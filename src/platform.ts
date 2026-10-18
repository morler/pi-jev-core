import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { configPath, errorMessage, readConfig, updateConfig, writeFileAtomic } from "./config.js";

/** The Jev API platforms this extension can talk to. */
export type JevPlatform = "typesafe" | "openrouter" | "cloudflare" | "vercel" | "local";

export interface PlatformSpec {
  /** Environment variable holding the API credential. */
  env: string;
  /** Secret file name under ~/.pi/agent/secrets; only hosted platforms have one. */
  secret?: string;
  /** Default Jev model id for this platform. */
  model: string;
}

/** The SDK's generic request type, recovered without importing its internal names. */
type SystemOneCall = Parameters<TypeSafeClient["systemOne"]>[0];

export const JEV_PLATFORMS: Record<JevPlatform, PlatformSpec> = {
  typesafe: { env: "TYPESAFE_API_KEY", secret: "typesafe_api_key", model: "jev-latest" },
  openrouter: { env: "OPENROUTER_API_KEY", secret: "openrouter_api_key", model: "typesafe/jev-1.13" },
  cloudflare: { env: "CLOUDFLARE_API_TOKEN", secret: "cloudflare_api_token", model: "typesafe/jev" },
  vercel: { env: "AI_GATEWAY_API_KEY", secret: "ai_gateway_api_key", model: "typesafe-ai/jev" },
  local: { env: "JEV_LOCAL_PORT", model: "jev-latest" },
};

/** Own-property check: `in` also accepts inherited keys such as `constructor` or `toString`. */
export function isJevPlatform(value: string): value is JevPlatform {
  return Object.hasOwn(JEV_PLATFORMS, value);
}

/** Hosted endpoints and gateway versions, kept here so an API bump is one edit. */
const ENDPOINTS = {
  openrouter: "https://openrouter.ai/api/alpha/decisions",
  vercel: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
  cloudflare: "https://api.cloudflare.com/client/v4/accounts",
  local: (port: number) => `http://127.0.0.1:${port}/v1/systemone`,
} as const;
const GATEWAY_PROTOCOL_VERSION = "0.0.1";
const EVALUATION_SPEC_VERSION = "4";
/** A provider that never answers must not hold the caller's request open forever. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Narrow one JSON layer to an object without trusting any of its fields. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Keep a number we can actually use; anything else (missing, string, NaN) is undefined. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The SDK and the direct APIs disagree on casing, and either may omit counts; callers get one shape. */
function normalizeUsage(value: unknown): JevRawResponse["usage"] {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const inputTokens = optionalNumber(usage.input_tokens) ?? optionalNumber(usage.inputTokens);
  const outputTokens = optionalNumber(usage.output_tokens) ?? optionalNumber(usage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      optionalNumber(usage.total_tokens) ?? optionalNumber(usage.totalTokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

/** Where /jev-platform persists the choice for future sessions. */
export function platformStorePath(): string {
  return process.env.JEV_PLATFORM_FILE?.trim() || configPath();
}

export function readPersistedPlatform(): JevPlatform | null {
  const stored = process.env.JEV_PLATFORM_FILE?.trim() ? readPlatformStore() : readConfig().platform;
  const raw = stored?.trim().toLowerCase() ?? "";
  return raw && isJevPlatform(raw) ? raw : null;
}

/** A store file that is not there yet is "nothing stored"; one that cannot be read is a failure the caller must hear about. */
function readPlatformStore(): string | undefined {
  try {
    return fs.readFileSync(platformStorePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Unable to read the Jev platform store:", errorMessage(error));
    }
    return undefined;
  }
}

export function persistPlatform(platform: JevPlatform): void {
  if (process.env.JEV_PLATFORM_FILE?.trim()) {
    writeFileAtomic(platformStorePath(), platform + "\n", 0o600);
    return;
  }
  updateConfig({ platform });
}

/** Active platform: JEV_PLATFORM wins, then the persisted /jev-platform choice, then TypeSafe. */
export function resolvePlatform(): JevPlatform {
  const raw = process.env.JEV_PLATFORM?.trim().toLowerCase();
  if (raw && isJevPlatform(raw)) return raw;
  return readPersistedPlatform() ?? "typesafe";
}

/** Model id: explicit override, then JEV_MODEL, then the platform default. */
export function resolveModel(platform: JevPlatform, override?: string): string {
  const fallback = platform === "typesafe" ? process.env.TYPESAFE_DEFAULT_MODEL?.trim() : undefined;
  return override?.trim() || process.env.JEV_MODEL?.trim() || fallback || JEV_PLATFORMS[platform].model;
}

/** How to reach a platform: an API key, or — for `local` — the port it listens on. */
export type Credential =
  | { kind: "apiKey"; key: string; source: "env" | "file"; origin: string }
  | { kind: "port"; port: number; source: "env" | "file"; origin: string };

function isPort(value: string): boolean {
  return /^[0-9]+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
}

/** Credential for the platform: its environment variable, then the persisted port or its Pi secret file. */
export function resolveCredential(platform: JevPlatform = resolvePlatform()): Credential | null {
  const spec = JEV_PLATFORMS[platform];
  if (platform === "local") {
    const envPort = process.env.JEV_LOCAL_PORT?.trim();
    if (envPort && isPort(envPort)) return { kind: "port", port: Number(envPort), source: "env", origin: "$JEV_LOCAL_PORT" };
    const configPort = readConfig().localPort;
    if (configPort !== undefined && isPort(String(configPort))) {
      return { kind: "port", port: Number(configPort), source: "file", origin: configPath() };
    }
    return null;
  }

  const envKey = process.env[spec.env]?.trim();
  if (envKey) return { kind: "apiKey", key: envKey, source: "env", origin: `$${spec.env}` };

  // A hosted platform that names no secret file cannot be configured from disk.
  if (!spec.secret) return null;
  const secretPath = path.join(os.homedir(), ".pi", "agent", "secrets", spec.secret);
  try {
    const content = fs.readFileSync(secretPath, "utf8").trim();
    if (content) {
      return { kind: "apiKey", key: content, source: "file", origin: `~/.pi/agent/secrets/${spec.secret}` };
    }
  } catch (error) {
    // A missing secret file just means "not configured"; an unreadable one is a failure the user must hear about.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Unable to read ${secretPath}:`, errorMessage(error));
    }
  }

  return null;
}

/** How to fix a missing credential, for error messages and status output. */
export function credentialHint(platform: JevPlatform = resolvePlatform()): string {
  const spec = JEV_PLATFORMS[platform];
  if (platform === "local") return "Run /jev-platform local <port> or set JEV_LOCAL_PORT (1-65535)";
  return `Set ${spec.env} or write ~/.pi/agent/secrets/${spec.secret}`;
}

export interface JevCall {
  state: unknown;
  questions: Record<string, unknown>;
  model: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface JevRawResponse {
  answers: Record<string, unknown>;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Per-question confidence reported out of band (Vercel AI Gateway provider metadata). */
  confidence?: Record<string, number>;
}

/** Send one System One evaluation to the active platform's Jev endpoint. */
export async function callJev(
  platform: JevPlatform,
  credential: Credential,
  call: JevCall
): Promise<JevRawResponse> {
  const doFetch: typeof fetch = call.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (platform === "local") {
    if (credential.kind !== "port") throw new Error("The local platform is addressed by port, not by an API key.");
    const json = await postJson(
      ENDPOINTS.local(credential.port),
      {},
      { model: call.model, state: call.state, questions: call.questions },
      call.signal,
      doFetch
    );
    return direct(json);
  }

  // Everything below talks to a hosted API, so a port credential here is a caller bug.
  if (credential.kind !== "apiKey") throw new Error(`The ${platform} platform is addressed by an API key.`);
  const apiKey = credential.key;

  if (platform === "typesafe") {
    const client = new TypeSafeClient({ apiKey, fetch: doFetch });
    const res = await client.systemOne(
      { state: call.state, questions: call.questions, model: call.model } as SystemOneCall,
      { signal: call.signal }
    );
    return {
      answers: res?.answers ?? {},
      model: typeof res?.model === "string" ? res.model : undefined,
      usage: normalizeUsage(res?.usage),
    };
  }

  if (platform === "openrouter") {
    const json = await postJson(
      ENDPOINTS.openrouter,
      bearer(apiKey),
      { model: call.model, state: call.state, questions: call.questions },
      call.signal,
      doFetch
    );
    return direct(json);
  }

  if (platform === "cloudflare") {
    const { accountId, gatewayId } = cloudflareConfig();
    const json = await postJson(
      `${ENDPOINTS.cloudflare}/${encodeURIComponent(accountId)}/ai/run`,
      {
        ...bearer(apiKey),
        "cf-aig-gateway-id": gatewayId,
        "cf-aig-collect-log": "false",
        "cf-aig-skip-cache": "true",
        "cf-aig-max-attempts": "1",
      },
      { model: call.model, input: { state: call.state, questions: call.questions } },
      call.signal,
      doFetch
    );
    return direct(unwrapEnvelope(json));
  }

  // vercel: AI Gateway evaluation endpoint, taking the same question objects as the direct APIs.
  const json = await postJson(
    ENDPOINTS.vercel,
    {
      ...bearer(apiKey),
      // The gateway rejects requests without its protocol and auth-method headers.
      "ai-gateway-protocol-version": GATEWAY_PROTOCOL_VERSION,
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": EVALUATION_SPEC_VERSION,
      "ai-model-id": call.model,
    },
    {
      state: call.state,
      questions: toGatewayQuestions(call.questions),
      // ponytail: zero-data-retention is always requested; add an env toggle if a gateway plan rejects it.
      providerOptions: { gateway: { zeroDataRetention: true } },
    },
    call.signal,
    doFetch
  );
  return { ...direct(json), confidence: extractConfidence(json) };
}

/** The gateway names TypeSafe's `noul` question type `boolean`; choice and score match. */
function toGatewayQuestions(questions: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const q = question as Record<string, unknown>;
      return [id, q?.type === "noul" ? { ...q, type: "boolean" } : q];
    })
  );
}

/** Cloudflare routing needs the account and gateway slug, both from the environment. */
function cloudflareConfig(): { accountId: string; gatewayId: string } {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID?.trim();
  if (!accountId || !gatewayId) {
    throw new Error(
      "Cloudflare platform requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID."
    );
  }
  return { accountId, gatewayId };
}

/** Normalize the `{answers, model?, usage?}` payload the direct APIs share. */
function direct(json: unknown): JevRawResponse {
  const payload = asRecord(json);
  const answers = asRecord(payload?.answers);
  if (!answers) {
    throw new Error("Jev response contained no answers.");
  }

  const model = payload?.model;

  return {
    answers,
    model: typeof model === "string" ? model : undefined,
    usage: normalizeUsage(payload?.usage),
  };
}

/** Cloudflare nests the answer payload under up to two `result` envelopes. */
function unwrapEnvelope(json: unknown): unknown {
  let value = json;
  for (let depth = 0; depth < 3; depth++) {
    const record = asRecord(value);
    if (!record || record.answers) break;
    value = record.result ?? value;
  }
  return value;
}

/** The gateway reports per-question confidence in provider metadata, not in the answer. */
function extractConfidence(json: unknown): Record<string, number> | undefined {
  const confidence = asRecord(asRecord(asRecord(json)?.providerMetadata)?.typesafe)?.confidence;
  const entries = Object.entries(asRecord(confidence) ?? {}).filter(([, value]) => Number.isFinite(value));
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, number>) : undefined;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      // The caller's signal and the deadline both count: whichever fires first aborts the request.
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
  } catch (error) {
    if (timeout.aborted) throw new Error(`Jev request timed out after ${REQUEST_TIMEOUT_MS} ms.`, { cause: error });
    throw new Error(`Jev request failed: ${errorMessage(error)}`, { cause: error });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Jev request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error("Jev request failed: the response body was not valid JSON.", { cause: error });
  }
}

function bearer(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}
