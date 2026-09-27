/** Intern-Decision transport for a local llama-server.
 *
 * Intern-Decision predicts one single-token answer symbol per field from the
 * assistant JSON skeleton, so each field costs one forward pass: the logit
 * right before a field's <decision> marker scores its candidates. Calibration
 * rescales candidate probabilities, softmax(log(p) / T); it never samples.
 */
import type { JevCall, JevRawResponse } from "./platform.js";

type QuestionKind = "choice" | "score" | "noul";

interface Question {
  type: QuestionKind;
  instructions?: unknown;
  criteria?: unknown;
}

interface TokenResponse { tokens?: unknown; }
interface CompletionResponse { completion_probabilities?: Array<{ top_logprobs?: unknown }>; }
interface RenderedResponse { prompt?: unknown; }
interface LogprobEntry { token?: unknown; logprob?: unknown; }

/** Where to send a call, how to cancel it, and which fetch to use. */
interface Transport {
  baseUrl: string;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}

/** The compiled chat turns; `assistant` is the skeleton cut before one marker. */
interface DecisionRequest {
  system: string;
  user: string;
  assistant: string;
}

/** The 62 single-token answer symbols the checkpoint was trained on. */
const SYMBOLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SYSTEM =
  "You are a careful decision assistant. Use the state and decision schema in the user message to make the requested decisions. For every field, choose exactly one answer symbol from its listed options and return one valid JSON object mapping each field name to its chosen symbol. Do not include explanations, Markdown, or extra text.";
export const INTERN_DECISION_DEFAULT_URL = "http://127.0.0.1:8008";
/** Fitted for this checkpoint by NLL minimization on the separate calibration split. */
export const INTERN_DECISION_DEFAULT_TEMPERATURE = 1.99241824;
/** Reference recipe: ask for at least this many top logprobs per position. */
const TOP_LOGPROBS = 40;
/** A candidate missing from the top logprobs sits this far below the worst seen one. */
const MISSING_LOGPROB_PENALTY = 2;
/** The skeleton placeholder; the logit before it predicts that field's answer. */
const DECISION_TOKEN = "<decision>";
/** The placeholder as it appears in the stringified skeleton, i.e. quoted. */
const DECISION_MARKER = JSON.stringify(DECISION_TOKEN);

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

/** Ordered (value, description) candidates; noul is fixed to the no/yes order. */
function options(question: Question): Array<[string, string]> {
  if (question.type === "noul") return [["no", "The proposition is false."], ["yes", "The proposition is true."]];
  if (question.type === "choice") {
    return Object.entries((question.criteria ?? {}) as Record<string, unknown>).map(([key, value]) => [key, text(value)]);
  }
  if (Array.isArray(question.criteria)) return question.criteria.map((value, index) => [String(index), text(value)]);
  return Object.entries((question.criteria ?? {}) as Record<string, unknown>).map(([key, value]) => [String(key), text(value)]);
}

function calibrationTemperature(): number {
  const raw = process.env.INTERN_DECISION_TEMPERATURE?.trim();
  const value = raw ? Number(raw) : INTERN_DECISION_DEFAULT_TEMPERATURE;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Intern-Decision temperature must be finite and positive.");
  return value;
}

async function post(transport: Transport, path: string, body: unknown): Promise<unknown> {
  const response = await transport.fetchImpl(`${transport.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: transport.signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Intern-Decision request failed (HTTP ${response.status}).`);
  return response.json();
}

async function tokenize(transport: Transport, content: string): Promise<number[]> {
  const result = await post(transport, "/tokenize", { content, add_special: false, parse_special: true }) as TokenResponse;
  if (!Array.isArray(result.tokens) || result.tokens.some((token) => typeof token !== "number")) {
    throw new Error("Intern-Decision tokenize returned invalid tokens.");
  }
  return result.tokens as number[];
}

/** Offset of the fieldIndex-th marker; earlier fields keep their marker in the skeleton. */
function skeletonCut(skeleton: string, fieldIndex: number): number {
  let cut = skeleton.indexOf(DECISION_MARKER);
  for (let seen = 1; seen <= fieldIndex && cut >= 0; seen++) {
    cut = skeleton.indexOf(DECISION_MARKER, cut + DECISION_MARKER.length);
  }
  if (cut < 0) throw new Error("Intern-Decision skeleton has fewer decision markers than fields.");
  return cut;
}

function decisionRequest(state: unknown, entries: Array<[string, Question]>, fieldIndex: number): DecisionRequest {
  const schema = entries
    .map(([name, question]) => {
      const lines = options(question).map(([id, description], index) => `    ${SYMBOLS[index]} = ${id}: ${description}`);
      return `${name}: ${text(question.instructions)}\n${lines.join("\n")}`;
    })
    .join("\n");
  const evidence = typeof state === "string" ? state : JSON.stringify(state, null, 2);
  const user = `Return one answer for every field using the supplied answer symbols.\n\n## State\n${evidence}\n## Decision schema\n${schema}`;
  const skeleton = JSON.stringify(Object.fromEntries(entries.map(([name]) => [name, DECISION_TOKEN])), null, 4);
  return { system: SYSTEM, user, assistant: skeleton.slice(0, skeletonCut(skeleton, fieldIndex)) };
}

/** Render the compiled turns with the GGUF chat template, think block included. */
async function render(transport: Transport, request: DecisionRequest): Promise<string> {
  const result = await post(transport, "/apply-template", {
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
      { role: "assistant", content: request.assistant },
    ],
    add_generation_prompt: false,
  }) as RenderedResponse;
  if (typeof result.prompt !== "string" || result.prompt.length === 0) {
    throw new Error("Intern-Decision apply-template returned no prompt.");
  }
  return result.prompt;
}

/** Logprobs keyed by trimmed token: llama-server writes candidates as ` A`, ` B`, ... */
function seenLogprobs(completion: CompletionResponse): Map<string, number> {
  const top = completion.completion_probabilities?.[0]?.top_logprobs;
  if (!Array.isArray(top) || top.length === 0) throw new Error("Intern-Decision completion contained no token probabilities.");
  const seen = new Map<string, number>();
  for (const item of top as LogprobEntry[]) {
    if (typeof item.token === "string" && typeof item.logprob === "number") seen.set(item.token.trim(), item.logprob);
  }
  return seen;
}

/** softmax(log(p) / T) over the candidate logits; T=1 is the uncalibrated form. */
function calibrated(seen: Map<string, number>, optionCount: number): number[] {
  if (seen.size === 0) throw new Error("Intern-Decision completion contained no logprobs.");
  const floor = Math.min(...seen.values()) - MISSING_LOGPROB_PENALTY;
  const logits = Array.from({ length: optionCount }, (_, index) => seen.get(SYMBOLS[index]) ?? floor);
  const max = Math.max(...logits);
  const weights = logits.map((logit) => Math.exp((logit - max) / calibrationTemperature()));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

/** One forward pass: render, tokenize, read the candidate distribution. */
async function candidateProbabilities(
  transport: Transport,
  request: DecisionRequest,
  optionCount: number
): Promise<{ probabilities: number[]; inputTokens: number }> {
  const prompt = await tokenize(transport, await render(transport, request));
  const completion = await post(transport, "/completion", {
    prompt,
    n_predict: 1,
    n_probs: Math.max(TOP_LOGPROBS, optionCount),
    temperature: 0,
    cache_prompt: false,
  }) as CompletionResponse;
  return { probabilities: calibrated(seenLogprobs(completion), optionCount), inputTokens: prompt.length };
}

export function internDecisionBaseUrl(): string {
  return process.env.INTERN_DECISION_BASE_URL?.trim().replace(/\/+$/, "") || INTERN_DECISION_DEFAULT_URL;
}

export async function callInternDecision(baseUrl: string, call: JevCall, fetchImpl: typeof fetch): Promise<JevRawResponse> {
  const transport: Transport = { baseUrl, signal: call.signal, fetchImpl };
  const entries = Object.entries(call.questions) as Array<[string, Question]>;
  const answers: Record<string, unknown> = {};
  let inputTokens = 0;
  for (let fieldIndex = 0; fieldIndex < entries.length; fieldIndex++) {
    const [name, question] = entries[fieldIndex];
    if (!(["choice", "score", "noul"] as readonly QuestionKind[]).includes(question.type)) {
      throw new Error(`Intern-Decision question "${name}" has unknown type "${String(question.type)}".`);
    }
    const ids = options(question).map(([id]) => id);
    if (ids.length < 2 || ids.length > SYMBOLS.length) {
      throw new Error(`Intern-Decision question "${name}" has ${ids.length} options; expected 2-${SYMBOLS.length}.`);
    }
    const request = decisionRequest(call.state, entries, fieldIndex);
    const { probabilities, inputTokens: questionTokens } = await candidateProbabilities(transport, request, ids.length);
    inputTokens += questionTokens;
    const distribution = Object.fromEntries(ids.map((id, index) => [id, probabilities[index]])) as Record<string, number>;
    const best = probabilities.indexOf(Math.max(...probabilities));
    if (question.type === "noul") answers[name] = { type: "noul", noul: distribution.yes };
    else if (question.type === "choice") {
      answers[name] = { type: "choice", choice: ids[best], confidence: probabilities[best], probabilities: distribution };
    } else {
      const score = probabilities.reduce((sum, probability, level) => sum + level * probability, 0);
      answers[name] = { type: "score", score, confidence: probabilities[best], probabilities: distribution };
    }
  }
  return { answers, model: call.model, usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens } };
}
