/** Hopper platform transport: a local llama-server serving a Hopper GGUF (hopper-4b, the
 * Qwen3.5-4B LoRA merged in).
 *
 * One forward pass per question: the option letters' next-token logprobs are read from
 * `/completion` and rescaled with the per-kind temperatures of `hopper.json`, exactly like
 * the hopper_decisions 1.1.x reference client. The prompt is hopper's system instruction plus
 * one JSON user turn (evidence/criterion/options), rendered through the GGUF's own chat
 * template — applied server-side via `/apply-template`, which yields the thinking-off form
 * the reference gets from `apply_chat_template(..., enable_thinking=False)`.
 */
import type { JevCall, JevRawResponse } from "./platform.js";

/** Loose question shape: the values of JevEvaluationRequest.questions. */
interface RawQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const HOPPER_DEFAULT_URL = "http://127.0.0.1:8008";

/** Per-kind temperatures of hopper-4b v1.1's hopper.json; missing type falls back to 1.0. */
const TEMPERATURES: Record<string, number> = {
  choice: 0.7898505975532796,
  noul: 0.7531284680253558,
  score: 0.8997033695617845,
};
const FALLBACK_TEMPERATURE = 1.0;

const SYSTEM =
  "You make decisions about a document under a policy. Read only what is written in the document. " +
  "Reply with the letter of the correct option and nothing else.";
/** The fixed policy hopper's reference server prepends to every System One question. */
const POLICY = "Decide the case using only what the document states. Exactly one option is correct.";

/** HOPPER_TEMPERATURE: one temperature for every kind, switching the per-kind map off. */
function typeTemperature(type: string): number {
  const raw = process.env.HOPPER_TEMPERATURE?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TEMPERATURES[type] ?? FALLBACK_TEMPERATURE;
}

/** Question fields accept EntryType (string | object | array | null); the prompt wants text. */
function describe(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry === null || entry === undefined) return "";
  return JSON.stringify(entry);
}

/** Structured states are rendered as JSON, which is what the harness sends (render_document). */
function renderDocument(state: unknown): string {
  if (typeof state === "string") return state;
  return JSON.stringify(state, null, 2);
}

/** The shown option text (prompt.py option_lines): bare name when it says it all, else "name: text". */
function shownOptions(question: RawQuestion): { names: string[]; shown: string[] } {
  if (question.type === "noul") {
    return { names: ["true", "false"], shown: ["true", "false"] };
  }
  if (question.type === "choice") {
    const criteria = (question.criteria ?? {}) as Record<string, unknown>;
    const names = Object.keys(criteria);
    const shown = names.map((name) => {
      const description = describe(criteria[name]);
      return !description || description === name ? name : `${name}: ${description}`;
    });
    return { names, shown };
  }
  // score: levels are named positionally ("0", "1", ...) and shown with their number.
  const levels = (question.criteria ?? []) as unknown[];
  const names = levels.map((_, index) => String(index));
  const shown = levels.map((level, index) => {
    const description = describe(level);
    return description ? `${index}: ${description}` : String(index);
  });
  return { names, shown };
}

/** The policy rides in the criterion; a noul rubric has no option to sit on, so it joins the policy. */
function criterionFor(question: RawQuestion): string {
  let policy = POLICY;
  if (question.type === "noul") {
    const criteria = (question.criteria ?? {}) as Record<string, unknown>;
    policy = `${POLICY}\ntrue: ${describe(criteria.true) || "yes"}\nfalse: ${describe(criteria.false) || "no"}`;
  }
  return `${policy}\n\n${describe(question.instructions)}`;
}

/** json.dumps' default separators (", " / ": ") — the reference builds the user turn with plain dumps. */
function userJson(evidence: string, criterion: string, shown: string[]): string {
  const options = shown
    .map((text, index) => `{"letter": ${JSON.stringify(LETTERS[index])}, "description": ${JSON.stringify(text)}}`)
    .join(", ");
  return `{"evidence": ${JSON.stringify(evidence)}, "criterion": ${JSON.stringify(criterion)}, "options": [${options}]}`;
}

async function postJson(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Hopper request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }
  return response.json();
}

/** One Hopper decision: letter logprobs from one forward pass, softmaxed at the kind's temperature. */
async function decide(
  baseUrl: string,
  evidence: string,
  criterion: string,
  shown: string[],
  kind: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<{ weights: number[]; inputTokens: number }> {
  const rendered = (await postJson(
    `${baseUrl}/apply-template`,
    {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: userJson(evidence, criterion, shown) },
      ],
    },
    signal,
    fetchImpl
  )) as { prompt?: unknown } | null | undefined;
  if (typeof rendered?.prompt !== "string" || rendered.prompt.length === 0) {
    throw new Error("Hopper apply-template returned no prompt.");
  }
  const tokenized = (await postJson(
    `${baseUrl}/tokenize`,
    { content: rendered.prompt, add_special: false, parse_special: true },
    signal,
    fetchImpl
  )) as { tokens?: unknown } | null | undefined;
  const tokens = tokenized?.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error("Hopper tokenize returned no tokens.");
  }
  const completion = (await postJson(
    `${baseUrl}/completion`,
    { prompt: tokens, n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: false },
    signal,
    fetchImpl
  )) as { completion_probabilities?: Array<{ top_logprobs?: unknown }> } | null | undefined;
  const topLogprobs = completion?.completion_probabilities?.[0]?.top_logprobs;
  if (!Array.isArray(topLogprobs) || topLogprobs.length === 0) {
    throw new Error("Hopper completion contained no token probabilities.");
  }

  const seen = new Map<string, number>();
  for (const entry of topLogprobs as Array<{ token?: string; logprob?: number }>) {
    if (typeof entry?.token === "string" && typeof entry?.logprob === "number") {
      seen.set(entry.token, entry.logprob);
    }
  }
  const floor = Math.min(...seen.values()) - 2.0;
  const logprobs = shown.map((_, index) => seen.get(LETTERS[index]) ?? floor);
  const max = Math.max(...logprobs);
  const temperature = typeTemperature(kind);
  const weights = logprobs.map((value) => Math.exp((value - max) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return { weights: weights.map((weight) => weight / total), inputTokens: tokens.length };
}

/** Evaluate every question sequentially; each is one forward pass on the local server. */
// ponytail: sequential on purpose — llama-server's default single slot queues concurrency anyway;
// start it with --parallel N and switch to Promise.all if decision fan-out matters.
export async function callHopper(
  baseUrl: string,
  call: JevCall,
  fetchImpl: typeof fetch
): Promise<JevRawResponse> {
  const document = renderDocument(call.state);
  const answers: Record<string, unknown> = {};
  let inputTokens = 0;
  for (const [id, rawQuestion] of Object.entries(call.questions)) {
    const question = rawQuestion as RawQuestion;
    if (question.type !== "noul" && question.type !== "choice" && question.type !== "score") {
      throw new Error(`Hopper question "${id}" has unknown type "${question.type}".`);
    }
    const shown = shownOptions(question);
    if (shown.shown.length < 2) {
      throw new Error(`Hopper question "${id}" produced fewer than two options.`);
    }
    if (shown.shown.length > LETTERS.length) {
      throw new Error(
        `Hopper question "${id}" has ${shown.shown.length} options but only ${LETTERS.length} answer letters exist.`
      );
    }
    const criterion = criterionFor(question);
    // The reference falls back to the question text when the document is empty (document or question).
    const evidence = document || describe(question.instructions);
    const { weights, inputTokens: questionTokens } = await decide(
      baseUrl,
      evidence,
      criterion,
      shown.shown,
      question.type,
      call.signal,
      fetchImpl
    );
    inputTokens += questionTokens;

    // The harness's own tie-break (jevbench/scoring.py): the lexicographically smallest label.
    // Letters ride in shown order, so the first strictly-greater maximum is that label.
    let best = 0;
    for (let index = 1; index < weights.length; index++) {
      if (weights[index]! > weights[best]!) best = index;
    }
    if (question.type === "noul") {
      // P(true) is the noul contract; jev.ts normalizes it into value.
      answers[id] = { type: "noul", noul: weights[0] ?? 0 };
    } else if (question.type === "choice") {
      answers[id] = {
        type: "choice",
        choice: shown.names[best],
        confidence: weights[best],
        probabilities: Object.fromEntries(shown.names.map((name, index) => [name, weights[index]!])),
      };
    } else {
      const expected = weights.reduce((sum, probability, level) => sum + probability * level, 0);
      answers[id] = {
        type: "score",
        score: expected,
        confidence: weights[best],
        probabilities: Object.fromEntries(weights.map((probability, level) => [String(level), probability])),
      };
    }
  }
  return {
    answers,
    model: call.model,
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
  };
}
