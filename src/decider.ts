/** Decider platform transport: a local llama-server serving a decider GGUF (decider-4b v2.1).
 *
 * Plain-layout rows, exactly as decider-ai 1.4.0 renders them:
 *   Context:\n<state>\n\nQuestion: <q>\nOptions:\n(A) <opt>\n(B) <opt>\nAnswer: (
 * The answer letters' next-token logprobs are softmaxed at the per-type calibration
 * temperature from decider_config.json (choice 1.110, noul 1.560, score 1.287).
 * Score questions follow the isolated-levels recipe: one yes/no row per level, the
 * per-level P(fits) normalized into a level distribution whose expectation is the score.
 */
import type { JevCall, JevRawResponse } from "./platform.js";

interface RawQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

interface Row {
  question: string;
  options: string[];
  type: string;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DECIDER_DEFAULT_URL = "http://127.0.0.1:8008";

/** Per-type temperatures of decider-4b v2.1's decider_config.json; missing type falls back to 1.099. */
const TEMPERATURES: Record<string, number> = { choice: 1.11, noul: 1.56, score: 1.287 };
const FALLBACK_TEMPERATURE = 1.099;
/** Keep the state clear of the server context window (llama-server runs n_ctx 8192 here). */
const MAX_STATE_TOKENS = 7600;

const NOUL_WITHOUT_INSTRUCTIONS = "Which answer fits the context?";

/** decider-ai's DECIDER_TEMPERATURE: one temperature for every type, switching the per-type map off. */
function typeTemperature(type: string): number {
  const raw = process.env.DECIDER_TEMPERATURE?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TEMPERATURES[type] ?? FALLBACK_TEMPERATURE;
}

/** decider-ai's annotate_indices: write positions into long arrays so path references become lookups. */
function annotateIndices(value: unknown, minLen = 8): unknown {
  if (Array.isArray(value)) {
    if (value.length >= minLen) {
      return value.map((entry, index) =>
        entry !== null && typeof entry === "object"
          ? { _index: index, ...(annotateIndices(entry, minLen) as object) }
          : { _index: index, value: annotateIndices(entry, minLen) }
      );
    }
    return value.map((entry) => annotateIndices(entry, minLen));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, annotateIndices(entry, minLen)])
    );
  }
  return value;
}

/** JSON state is serialized as one line, like decider-ai's render_state. */
function renderState(state: unknown): string {
  if (typeof state === "string") return state;
  // ponytail: JSON.stringify is space-free while decider-ai's json.dumps keeps ", "/": "; add a
  // separator-normalizing serializer only if served probabilities drift from the reference client.
  return JSON.stringify(annotateIndices(state));
}

/** Question fields accept EntryType (string | object | array | null); the prompt wants text. */
function describe(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry === null || entry === undefined) return "";
  return JSON.stringify(entry);
}

/** "`2: somewhat`" -> "somewhat": an isolated level must not carry its number. */
function stripLevelNumber(text: string): string {
  return text.replace(/^\s*-?\d+\s*:\s*/, "");
}

function buildRow(question: string, options: string[], type: string): Row {
  return { question, options, type };
}

/** Map a System One question onto decider's scoring rows (plan_rows with isolated levels). */
function renderRows(id: string, question: RawQuestion): Row[] {
  const text = describe(question.instructions);
  if (!text && question.type !== "noul") {
    throw new Error(`Decider question "${id}" has no instructions.`);
  }
  if (question.type === "noul") {
    const criteria = (question.criteria ?? {}) as Record<string, unknown>;
    const no = (criteria as any).false ?? (criteria as any)[false as unknown as string];
    const yes = (criteria as any).true ?? (criteria as any)[true as unknown as string];
    return [
      buildRow(
        text || NOUL_WITHOUT_INSTRUCTIONS,
        [no ? `no: ${describe(no)}` : "no", yes ? `yes: ${describe(yes)}` : "yes"],
        "noul"
      ),
    ];
  }
  if (question.type === "choice") {
    const criteria = (question.criteria ?? {}) as Record<string, unknown>;
    const names = Object.keys(criteria);
    if (names.length > LETTERS.length) {
      throw new Error(
        `Decider question "${id}" has ${names.length} options but only ${LETTERS.length} single-letter answer tokens exist.`
      );
    }
    const options = names.map((name) => {
      const description = criteria[name];
      return description === null || description === undefined || description === ""
        ? name
        : `${name}: ${describe(description)}`;
    });
    return [buildRow(text, options, "choice")];
  }
  if (question.type === "score") {
    const levels = (question.criteria ?? []) as unknown[];
    // ISOLATED rows: each level judged alone as yes/no, without its number or its neighbours.
    return levels.map((level) =>
      buildRow(
        `${text}\nProposed answer: ${stripLevelNumber(describe(level))}\nDoes the proposed answer fit?`,
        ["no", "yes"],
        "score"
      )
    );
  }
  throw new Error(`Decider question "${id}" has unknown type "${question.type}".`);
}

/** The plain-layout prompt of one scoring row. */
function rowPrompt(row: Row): string {
  const optionLines = row.options.map((option, index) => `\n(${LETTERS[index]}) ${option}`).join("");
  return `\n\nQuestion: ${row.question}\nOptions:${optionLines}\nAnswer: (`;
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
      `Decider request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }
  return response.json();
}

async function tokenize(
  baseUrl: string,
  content: string,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<number[]> {
  const json = await postJson(
    `${baseUrl}/tokenize`,
    { content, add_special: false, parse_special: true },
    signal,
    fetchImpl
  );
  if (!Array.isArray(json?.tokens) || json.tokens.length === 0) {
    throw new Error("Decider tokenize returned no tokens.");
  }
  return json.tokens as number[];
}

/** Letter logprobs from one forward pass, softmaxed at the row's calibration temperature. */
function softmaxLetters(completion: any, optionCount: number, temperature: number): number[] {
  const topLogprobs = completion?.completion_probabilities?.[0]?.top_logprobs;
  if (!Array.isArray(topLogprobs) || topLogprobs.length === 0) {
    throw new Error("Decider completion contained no token probabilities.");
  }
  const seen = new Map<string, number>();
  for (const entry of topLogprobs as Array<{ token?: string; logprob?: number }>) {
    if (typeof entry?.token === "string" && typeof entry?.logprob === "number") {
      seen.set(entry.token, entry.logprob);
    }
  }
  const floor = Math.min(...seen.values()) - 2.0;
  const logprobs = Array.from({ length: optionCount }, (_, index) => seen.get(LETTERS[index]) ?? floor);
  const max = Math.max(...logprobs);
  const weights = logprobs.map((value) => Math.exp((value - max) / temperature));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

/** TypeSafe's choice confidence: (n * p_max - 1) / (n - 1), clipped to [0, 1]. */
function choiceConfidence(probabilities: number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  const scaled = (n * Math.max(...probabilities) - 1) / (n - 1);
  return Math.max(0, Math.min(1, scaled));
}

/** TypeSafe's score confidence: 1 - expected distance to the top level, over the levels' mean distance. */
function scoreConfidence(probabilities: number[]): number {
  const n = probabilities.length;
  if (n <= 1) return 1;
  const top = probabilities.indexOf(Math.max(...probabilities));
  const spread = probabilities.reduce((sum, weight, index) => sum + weight * Math.abs(index - top), 0);
  const uniform =
    Array.from({ length: n }, (_, index) => Math.abs(index - (n - 1) / 2)).reduce((a, b) => a + b, 0) / n;
  return Math.max(0, Math.min(1, 1 - spread / uniform));
}

/** Evaluate every question sequentially; each row is one forward pass on the local server. */
// ponytail: sequential on purpose — llama-server queues concurrency on its slots anyway; the state
// prefix is re-sent per row (cache_prompt stays off), add shared-prefix caching if throughput matters.
export async function callDecider(
  baseUrl: string,
  call: JevCall,
  fetchImpl: typeof fetch
): Promise<JevRawResponse> {
  const state = renderState(call.state);
  const signal = call.signal;
  // Truncate the state in token space, exactly like decider-ai's max_ctx_tokens.
  const head = await tokenize(baseUrl, "Context:\n", signal, fetchImpl);
  const body = await tokenize(baseUrl, state, signal, fetchImpl);
  const stateTokens = [...head, ...body.slice(0, MAX_STATE_TOKENS)];

  const answers: Record<string, unknown> = {};
  let tailTokens = 0;
  for (const [id, rawQuestion] of Object.entries(call.questions)) {
    const question = rawQuestion as RawQuestion;
    const rows = renderRows(id, question);
    if (rows.length === 0) {
      throw new Error(`Decider question "${id}" produced no scoring rows.`);
    }

    if (question.type === "noul") {
      const row = rows[0]!;
      const probabilities = softmaxLetters(
        await postJson(
          `${baseUrl}/completion`,
          { prompt: [...stateTokens, ...(await tokenize(baseUrl, rowPrompt(row), signal, fetchImpl))],
            n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: false },
          signal,
          fetchImpl
        ),
        row.options.length,
        typeTemperature("noul")
      );
      answers[id] = { type: "noul", noul: probabilities[1] };
      tailTokens += row.options.length;
    } else if (question.type === "choice") {
      const row = rows[0]!;
      const probabilities = softmaxLetters(
        await postJson(
          `${baseUrl}/completion`,
          { prompt: [...stateTokens, ...(await tokenize(baseUrl, rowPrompt(row), signal, fetchImpl))],
            n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: false },
          signal,
          fetchImpl
        ),
        row.options.length,
        typeTemperature("choice")
      );
      const names = Object.keys((question.criteria ?? {}) as Record<string, unknown>);
      const best = probabilities.indexOf(Math.max(...probabilities));
      answers[id] = {
        type: "choice",
        choice: names[best],
        confidence: choiceConfidence(probabilities),
        x_p_max: Math.max(...probabilities),
        probabilities: Object.fromEntries(names.map((name, index) => [name, probabilities[index]])),
      };
      tailTokens += row.options.length;
    } else {
      // score: one yes/no row per level; the per-level P(fits) normalize into the level distribution.
      const fits: number[] = [];
      for (const row of rows) {
        const probabilities = softmaxLetters(
          await postJson(
            `${baseUrl}/completion`,
            { prompt: [...stateTokens, ...(await tokenize(baseUrl, rowPrompt(row), signal, fetchImpl))],
              n_predict: 1, n_probs: 40, temperature: 0, cache_prompt: false },
            signal,
            fetchImpl
          ),
          row.options.length,
          typeTemperature("score")
        );
        fits.push(probabilities[1]!);
        tailTokens += row.options.length;
      }
      const total = fits.reduce((sum, fit) => sum + fit, 0) || 1e-9;
      const levelProbabilities = fits.map((fit) => fit / total);
      const score = levelProbabilities.reduce((sum, weight, level) => sum + weight * level, 0);
      answers[id] = {
        type: "score",
        score,
        confidence: scoreConfidence(levelProbabilities),
        probabilities: Object.fromEntries(levelProbabilities.map((weight, level) => [String(level), weight])),
      };
    }
  }

  const inputTokens = stateTokens.length + tailTokens;
  return {
    answers,
    model: call.model,
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
  };
}
