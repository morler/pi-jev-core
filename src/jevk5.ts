/** JevK5 platform transport: a local llama-server serving a JevK5 GGUF.
 *
 * One forward pass per question: the answer letters' next-token logprobs are
 * read from `/completion` and calibrated with the recipe temperature, exactly
 * like the reference client shipped with the JevK5 GGUF.
 */
import type { JevCall, JevRawResponse } from "./platform.js";

/** Loose question shape: the values of JevEvaluationRequest.questions. */
interface RawQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

const LETTERS = "ABCDEFGHIJKLMNOP";
export const JEVK5_DEFAULT_URL = "http://127.0.0.1:8008";
/** Calibration temperature from the JevK5 recipe: 1.532 for the 4B, 1.42 for the 2B. */
const DEFAULT_TEMPERATURE = 1.532;

const SYSTEM =
  "Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. " +
  "Respond with only its uppercase letter, with no explanation or reasoning.";

/** Base URL of the local llama-server. */
export function jevk5BaseUrl(): string {
  return process.env.JEVK5_BASE_URL?.trim().replace(/\/+$/, "") || JEVK5_DEFAULT_URL;
}

function calibrationTemperature(): number {
  const raw = process.env.JEVK5_TEMP?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TEMPERATURE;
}

/** Question fields accept EntryType (string | object | array | null); the prompt wants text. */
function describe(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry === null || entry === undefined) return "";
  return JSON.stringify(entry);
}

/** Map a System One question onto the lettered option map JevK5's prompt expects. */
function buildOptions(question: RawQuestion): Record<string, string> {
  if (question.type === "noul") {
    const criteria = (question.criteria ?? {}) as Record<string, unknown>;
    return {
      true: describe(criteria.true) || "The proposition is true.",
      false: describe(criteria.false) || "The proposition is false.",
    };
  }
  const options: Record<string, string> = {};
  if (question.type === "choice") {
    for (const [label, description] of Object.entries((question.criteria as Record<string, unknown> | undefined) ?? {})) {
      options[label] = describe(description) || label;
    }
  } else {
    (question.criteria as unknown[] | undefined)?.forEach((level, index) => {
      options[String(index)] = describe(level) || String(index);
    });
  }
  return options;
}

function buildPrompt(evidence: unknown, criterion: string, options: Record<string, string>): string {
  const ids = Object.keys(options);
  const user = JSON.stringify({
    evidence,
    criterion,
    options: ids.map((id, index) => ({ letter: LETTERS[index], description: `${id}: ${options[id]}` })),
  });
  return (
    `<|im_start|>system\n${SYSTEM}<|im_end|>\n` +
    `<|im_start|>user\n${user}<|im_end|>\n` +
    `<|im_start|>assistant\n<think>\n\n</think>\n\n`
  );
}

async function postJson(
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<any> {
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
      `JevK5 request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }
  return response.json();
}

/** One JevK5 decision: letter logprobs from one forward pass, softmaxed at the calibration temperature. */
async function decide(
  baseUrl: string,
  evidence: unknown,
  criterion: string,
  options: Record<string, string>,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<{ probabilities: Record<string, number>; inputTokens: number }> {
  const ids = Object.keys(options);
  const prompt = buildPrompt(evidence, criterion, options);
  const tokenized = await postJson(
    `${baseUrl}/tokenize`,
    { content: prompt, add_special: false, parse_special: true },
    signal,
    fetchImpl
  );
  const tokens = tokenized?.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error("JevK5 tokenize returned no tokens.");
  }
  const completion = await postJson(
    `${baseUrl}/completion`,
    { prompt: tokens, n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: false },
    signal,
    fetchImpl
  );
  const topLogprobs = completion?.completion_probabilities?.[0]?.top_logprobs;
  if (!Array.isArray(topLogprobs) || topLogprobs.length === 0) {
    throw new Error("JevK5 completion contained no token probabilities.");
  }

  const seen = new Map<string, number>();
  for (const entry of topLogprobs as Array<{ token?: string; logprob?: number }>) {
    if (typeof entry?.token === "string" && typeof entry?.logprob === "number") {
      seen.set(entry.token, entry.logprob);
    }
  }
  const floor = Math.min(...seen.values()) - 2.0;
  const logprobs = ids.map((_, index) => seen.get(LETTERS[index]) ?? floor);
  const max = Math.max(...logprobs);
  const temperature = calibrationTemperature();
  const weights = logprobs.map((value) => Math.exp((value - max) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const probabilities: Record<string, number> = {};
  ids.forEach((id, index) => {
    probabilities[id] = weights[index] / total;
  });
  return { probabilities, inputTokens: tokens.length };
}

/** Evaluate every question sequentially; each is one forward pass on the local server. */
// ponytail: sequential on purpose — llama-server's default single slot queues concurrency anyway;
// start it with --parallel N and switch to Promise.all if decision fan-out matters.
export async function callJevK5(
  baseUrl: string,
  call: JevCall,
  fetchImpl: typeof fetch
): Promise<JevRawResponse> {
  const answers: Record<string, unknown> = {};
  let inputTokens = 0;
  for (const [id, rawQuestion] of Object.entries(call.questions)) {
    const question = rawQuestion as RawQuestion;
    const options = buildOptions(question);
    if (Object.keys(options).length < 2) {
      throw new Error(`JevK5 question "${id}" produced fewer than two options.`);
    }
    if (Object.keys(options).length > LETTERS.length) {
      throw new Error(
        `JevK5 question "${id}" has ${Object.keys(options).length} options but only ${LETTERS.length} answer letters exist.`
      );
    }
    const criterion = describe(question.instructions) || question.type;
    const { probabilities, inputTokens: questionTokens } = await decide(
      baseUrl,
      call.state,
      criterion,
      options,
      call.signal,
      fetchImpl
    );
    inputTokens += questionTokens;

    const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
    if (question.type === "noul") {
      // P(true) is the noul contract; jev.ts normalizes it into value.
      answers[id] = { type: "noul", noul: probabilities.true ?? 0 };
    } else if (question.type === "choice") {
      answers[id] = {
        type: "choice",
        choice: ranked[0][0],
        confidence: ranked[0][1],
        probabilities,
      };
    } else {
      const expected = Object.entries(probabilities).reduce(
        (sum, [level, probability]) => sum + Number(level) * probability,
        0
      );
      answers[id] = {
        type: "score",
        score: expected,
        confidence: ranked[0][1],
        probabilities,
      };
    }
  }
  return {
    answers,
    model: call.model,
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
  };
}
