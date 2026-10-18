/** Derived from the question configs, so adding a question kind cannot leave this union stale. */
export type QuestionType = QuestionConfig["type"];

export interface BaseQuestionConfig {
  instructions: string;
}

export interface ChoiceQuestionConfig extends BaseQuestionConfig {
  type: "choice";
  /** Candidate keys mapped to descriptions; a `null` description means the key carries no explanation. */
  criteria: Record<string, string | null>;
}

export interface NoulQuestionConfig extends BaseQuestionConfig {
  type: "noul";
}

export interface ScoreQuestionConfig extends BaseQuestionConfig {
  type: "score";
  /** Ordered levels; the array index is the score. At least two levels — the runtime rejects fewer. */
  criteria: string[];
}

export type QuestionConfig = ChoiceQuestionConfig | NoulQuestionConfig | ScoreQuestionConfig;

export interface JevEvaluationRequest {
  /**
   * An object is filtered to the fields your backtick references name; a string is sent verbatim as
   * `{ text: state }` without being parsed, so the referenced text has to live in the string itself.
   */
  state: Record<string, unknown> | string;
  questions: Record<string, QuestionConfig>;
  model?: string;
}

export interface JevAnswerResult {
  type: QuestionType;
  /**
   * Undefined means the provider gave no answer; never coerce that into a fake value.
   * Shape by `type`: `choice` -> option key (string), `score` -> level index mean (number),
   * `noul` -> probability in the 0-1 range (number).
   */
  value?: string | number;
  /**
   * Provider confidence in the 0-1 range, or absent when the provider reports none. For `noul` this is the
   * provider's confidence in its own answer; the probability itself is `value`.
   */
  confidence?: number;
  /** Per-option probabilities in the 0-1 range; they are not guaranteed to sum to exactly 1. */
  distribution?: Record<string, number>;
  raw?: unknown;
}

export interface JevEvaluationResponse {
  /** Keyed by question id: a question the provider did not answer is omitted, not returned as an empty result. */
  answers: Record<string, JevAnswerResult>;
  model: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  elapsedMs: number;
}

export interface JevSessionStats {
  requestsCount: number;
  totalTokens: number;
  lastElapsedMs?: number;
  lastError?: string;
}
