import { choice, noul, score } from "@typesafe-ai/sdk";
import {
  callJev,
  credentialHint,
  resolveCredential,
  resolveModel,
  resolvePlatform,
  type JevPlatform,
} from "./platform.js";
import type {
  JevEvaluationRequest,
  JevEvaluationResponse,
  JevAnswerResult,
  JevSessionStats,
} from "./types.js";

/**
 * The noul probability the provider actually gave, or null when it gave none.
 *
 * `JevAnswerResult.value` falls back to 0 so reporting code always has a number, which makes "no
 * answer" indistinguishable from "answered zero". Anything that has to tell them apart reads through
 * here instead — compaction does, because a low score drops history.
 */
export function noulProbability(rawAnswer: unknown): number | null {
  const raw = rawAnswer as { noul?: unknown; probability?: unknown; value?: unknown };
  const value = raw?.noul ?? raw?.probability ?? raw?.value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

export class JevClient {
  /** Platform this client talks to, fixed for the process lifetime. */
  public readonly platform: JevPlatform = resolvePlatform();
  public stats: JevSessionStats = {
    requestsCount: 0,
    totalTokens: 0,
  };

  public isConfigured(): boolean {
    return Boolean(resolveCredential(this.platform));
  }

  /** Human-readable description of where the API key came from, or null when unconfigured. */
  public getKeyOrigin(): string | null {
    return resolveCredential(this.platform)?.origin ?? null;
  }

  public async evaluate(
    request: JevEvaluationRequest,
    signal?: AbortSignal
  ): Promise<JevEvaluationResponse> {
    const startTime = Date.now();
    const apiKey = resolveCredential(this.platform)?.key;
    if (!apiKey) {
      throw new Error(
        `Missing Jev API key for the ${this.platform} platform. ${credentialHint(this.platform)}.`
      );
    }

    const questions: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === "choice") {
        // The SDK validates list-vs-map but lets a missing criteria through as a malformed
        // remote request; fail here instead, where the error names the question.
        if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) {
          throw new Error(`Choice question "${id}" needs criteria as a map of label -> description.`);
        }
        questions[id] = choice(q.instructions, q.criteria);
      } else if (q.type === "noul") {
        questions[id] = noul(q.instructions);
      } else if (q.type === "score") {
        // SDK 的 ScoreCriteria 是 [EntryType, EntryType, ...EntryType[]]：至少两级，索引即分数。
        questions[id] = score(q.instructions, q.criteria as [string, string, ...string[]]);
      }
    }

    const state: unknown =
      typeof request.state === "string" ? { text: request.state } : request.state;
    const model = resolveModel(this.platform, request.model);

    try {
      const response = await callJev(this.platform, apiKey, { state, questions, model, signal });

      const elapsedMs = Date.now() - startTime;
      this.stats.requestsCount += 1;
      const tokens = response.usage?.totalTokens || 0;
      this.stats.totalTokens += tokens;
      this.stats.lastElapsedMs = elapsedMs;

      const answers: Record<string, JevAnswerResult> = {};
      for (const [id, rawAns] of Object.entries(response.answers)) {
        const qConfig = request.questions[id];
        if (!qConfig) continue;

        const raw = rawAns as RawAnswer;
        // The Vercel AI Gateway answers with gateway types and reports confidence out of band.
        const confidence = raw?.confidence ?? response.confidence?.[id];

        if (qConfig.type === "choice") {
          answers[id] = {
            type: "choice",
            value: raw?.choice ?? raw?.value,
            confidence,
            distribution: raw?.distribution ?? raw?.probabilities,
            raw: rawAns,
          };
        } else if (qConfig.type === "noul") {
          answers[id] = {
            type: "noul",
            value: raw?.noul ?? raw?.probability ?? raw?.value,
            raw: rawAns,
          };
        } else if (qConfig.type === "score") {
          answers[id] = {
            type: "score",
            value: raw?.score ?? raw?.value,
            confidence,
            raw: rawAns,
          };
        }
      }

      return {
        answers,
        model: response.model || model,
        usage: response.usage,
        elapsedMs,
      };
    } catch (err) {
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
}
