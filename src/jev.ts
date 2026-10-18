import { choice, noul, score } from "@typesafe-ai/sdk";
import {
  callJev,
  credentialHint,
  resolveCredential,
  resolveModel,
  resolvePlatform,
  type JevPlatform,
} from "./platform.js";
import { errorMessage } from "./config.js";
import { appendJevLog } from "./log.js";
import type {
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevAnswerResult,
  JevSessionStats,
} from "./types.js";

/**
 * The noul probability the provider actually gave, or null when it gave none.
 *
 * `JevAnswerResult.value` is undefined for a question the provider did not answer, so anything that has to tell
 * "no answer" apart from "answered zero" reads through here instead.
 */
export function noulProbability(rawAnswer: unknown): number | null {
  const raw = rawAnswer as { noul?: unknown; probability?: unknown; value?: unknown };
  const value = raw?.noul ?? raw?.probability ?? raw?.value;
  // The Vercel AI Gateway names the noul answer `boolean`, so a literal boolean counts as 1/0.
  if (typeof value === "boolean") return value ? 1 : 0;
  return toNumber(value) ?? null;
}

/** Scalar normalization shared by the noul and score readers; anything non-numeric stays undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Provider answer shape before normalization; fields vary by platform. */
interface RawAnswer {
  choice?: string;
  noul?: number | string;
  probability?: number | string;
  score?: number;
  value?: string | number | boolean;
  confidence?: number;
  distribution?: Record<string, number>;
  probabilities?: Record<string, number>;
}

const DANGEROUS_PATH_PARTS = new Set(["__proto__", "constructor", "prototype"]);

/** Copy leaves: a shallow path must not alias the caller's object into what a deeper path then writes into. */
function copyLeaf(value: unknown): unknown {
  // shortcut: structuredClone rejects non-JSON leaves (functions, class instances); state arrives as JSON.
  return value !== null && typeof value === "object" ? structuredClone(value) : value;
}

function referencedPaths(instructions: string): (string | number)[][] {
  const paths: (string | number)[][] = [];
  for (const match of instructions.matchAll(/`([^`]+)`/g)) {
    const parts = match[1]!.match(/[^.[\]]+|\[(\d+)\]/g)?.map((part) =>
      part.startsWith("[") ? Number(part.slice(1, -1)) : part
    );
    if (!parts?.length || parts.some((part) => typeof part === "string" && DANGEROUS_PATH_PARTS.has(part))) {
      throw new Error("State references must use safe property paths.");
    }
    paths.push(parts);
  }
  if (paths.length === 0) throw new Error("Every Jev question must explicitly reference state fields with backticks.");
  return paths;
}

/** Send only state fields explicitly referenced by question instructions. No summarization is performed. */
export function selectReferencedState(
  state: Record<string, unknown>,
  questions: Record<string, { instructions: string }>
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const question of Object.values(questions)) {
    for (const parts of referencedPaths(question.instructions)) {
      let source: unknown = state;
      for (const part of parts) {
        if (source === null || typeof source !== "object" || !Object.hasOwn(source, part)) {
          throw new Error(`State reference is missing: ${parts.join(".")}`);
        }
        source = (source as Record<string | number, unknown>)[part];
      }

      let target: Record<string | number, unknown> = selected;
      parts.forEach((part, index) => {
        if (index === parts.length - 1) {
          try {
            target[part] = copyLeaf(source);
          } catch (error) {
            throw new Error(`State reference is not cloneable: ${parts.join(".")}`, { cause: error });
          }
          return;
        }
        const next = parts[index + 1]!;
        if (!Object.hasOwn(target, part)) {
          target[part] = typeof next === "number" ? [] : {};
        }
        target = target[part] as Record<string | number, unknown>;
      });
    }
  }
  return selected;
}

export class JevClient {
  /** Platform this client talks to, fixed for the process lifetime. */
  public readonly platform: JevPlatform = resolvePlatform();
  public stats: JevSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
  };


  /** Monotonic per-request id: the single `last*` slot describes the newest request, not whichever finished last. */
  private requestSeq = 0;
  public isConfigured(): boolean {
    return Boolean(resolveCredential(this.platform));
  }

  /** Human-readable description of where the credential came from, or null when unconfigured. */
  public getCredentialOrigin(): string | null {
    return resolveCredential(this.platform)?.origin ?? null;
  }

  public async evaluate(
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<JevEvaluationResponse> {
    const startTime = Date.now();
    const seq = (this.requestSeq += 1);
    const credential = resolveCredential(this.platform);
    if (!credential) {
      const err = new Error(
        `Missing ${this.platform === "local" ? "port" : "API key"} for the ${this.platform} platform. ${credentialHint(this.platform)}.`
      );
      this.recordFailure(seq, request, err);
      throw err;
    }

    const questions: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === "choice") {
        // The SDK validates list-vs-map but lets a missing criteria through as a malformed
        // remote request; fail here instead, where the error names the question.
        if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) {
          this.reject(seq, request, `Choice question "${id}" needs criteria as a map of label -> description.`);
        }
        questions[id] = choice(q.instructions, q.criteria);
      } else if (q.type === "noul") {
        questions[id] = noul(q.instructions);
      } else if (q.type === "score") {
        // SDK 的 ScoreCriteria 是 [EntryType, EntryType, ...EntryType[]]：至少两级，索引即分数。
        if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
          this.reject(seq, request, `Score question "${id}" needs criteria as an array of at least two levels.`);
        }
        questions[id] = score(q.instructions, q.criteria as [string, string, ...string[]]);
      } else {
        // Dropping a question the SDK cannot build would send a request the caller never asked for.
        this.reject(seq, request, `Unsupported question type: ${(q as { type?: string }).type}`);
      }
    }

    let state: Record<string, unknown> | string;
    try {
      state = typeof request.state === "string"
        ? { text: request.state }
        : selectReferencedState(request.state, request.questions);
    } catch (error) {
      // A state reference that cannot be built is a failed evaluation, so it belongs in stats and the log too.
      this.recordFailure(seq, request, error);
      throw error;
    }
    const model = resolveModel(this.platform, request.model);

    try {
      const response = await callJev(this.platform, credential, { state, questions, model, signal });

      const elapsedMs = Date.now() - startTime;
      this.stats.requestsCount += 1;
      this.stats.totalTokens += response.usage?.totalTokens || 0;
      if (seq === this.requestSeq) {
        this.stats.lastElapsedMs = elapsedMs;
        delete this.stats.lastError;
      }
      const answers: Record<string, JevAnswerResult> = {};
      // A provider that reports no answers at all yields an empty response rather than a TypeError.
      for (const [id, rawAns] of Object.entries(response.answers ?? {})) {
        const qConfig = request.questions[id];
        if (!qConfig) continue;

        const raw = rawAns as RawAnswer;
        // The Vercel AI Gateway answers with gateway types and reports confidence out of band.
        const confidence = raw?.confidence ?? response.confidence?.[id];

        if (qConfig.type === "choice") {
          answers[id] = {
            type: "choice",
            value: raw?.choice ?? (typeof raw?.value === "string" ? raw.value : undefined),
            confidence,
            distribution: raw?.distribution ?? raw?.probabilities,
            raw: rawAns,
          };
        } else if (qConfig.type === "noul") {
          answers[id] = {
            type: "noul",
            value: noulProbability(rawAns) ?? undefined,
            confidence,
            raw: rawAns,
          };
        } else if (qConfig.type === "score") {
          answers[id] = {
            type: "score",
            value: toNumber(raw?.score ?? raw?.value),
            confidence,
            raw: rawAns,
          };
        }
      }

      const result = {
        answers,
        model: response.model || model,
        usage: response.usage,
        elapsedMs,
      };
      appendJevLog({ type: "evaluation", request, response: result });
      return result;
    } catch (err) {
      this.recordFailure(seq, request, err);
      throw err;
    }
  }

  /** Record a failure in `stats` and the log, the way the success path records its own fields. */
  private recordFailure(seq: number, request: JevEvaluationRequest, error: unknown): void {
    const message = errorMessage(error);
    // Only the newest request may write the single `last*` slot, or a slow older one would erase a newer result.
    if (seq === this.requestSeq) this.stats.lastError = message;
    appendJevLog({ type: "evaluation", request, error: message });
  }

  /** Fail a pre-flight check the way a remote failure is recorded, instead of leaking a bare throw. */
  private reject(seq: number, request: JevEvaluationRequest, message: string): never {
    const error = new Error(message);
    this.recordFailure(seq, request, error);
    throw error;
  }
}
