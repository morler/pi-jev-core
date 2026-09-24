import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { callJevK5, JEVK5_DEFAULT_URL } from "./jevk5.js";

/** The Jev API platforms this extension can talk to. */
export type JevPlatform = "typesafe" | "openrouter" | "cloudflare" | "vercel" | "jevk5";

export interface PlatformSpec {
  /** Environment variable holding the API credential. */
  env: string;
  /** Secret file name under ~/.pi/agent/secrets. */
  secret: string;
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
  jevk5: { env: "JEVK5_BASE_URL", secret: "jevk5_base_url", model: "jevk5-4b-v0.2" },
};

/** Active platform from JEV_PLATFORM, defaulting to TypeSafe's own API. */
export function resolvePlatform(): JevPlatform {
  const raw = process.env.JEV_PLATFORM?.trim().toLowerCase();
  return raw && raw in JEV_PLATFORMS ? (raw as JevPlatform) : "typesafe";
}

/** Model id: explicit override, then JEV_MODEL, then the platform default. */
export function resolveModel(platform: JevPlatform, override?: string): string {
  const fallback = platform === "typesafe" ? process.env.TYPESAFE_DEFAULT_MODEL?.trim() : undefined;
  return override?.trim() || process.env.JEV_MODEL?.trim() || fallback || JEV_PLATFORMS[platform].model;
}

export interface Credential {
  key: string;
  source: "env" | "file";
  origin: string;
}

/** API credential from the platform's environment variable, then its Pi secret file. */
export function resolveCredential(platform: JevPlatform = resolvePlatform()): Credential | null {
  if (platform === "jevk5") {
    // Local llama-server needs no API key; the credential carries the server base URL.
    const url = process.env.JEVK5_BASE_URL?.trim();
    return {
      key: url || JEVK5_DEFAULT_URL,
      source: "env",
      origin: url ? "$JEVK5_BASE_URL" : `built-in default (${JEVK5_DEFAULT_URL})`,
    };
  }
  const spec = JEV_PLATFORMS[platform];

  const envKey = process.env[spec.env]?.trim();
  if (envKey) return { key: envKey, source: "env", origin: `$${spec.env}` };

  const secretPath = path.join(os.homedir(), ".pi", "agent", "secrets", spec.secret);
  try {
    const content = fs.readFileSync(secretPath, "utf8").trim();
    if (content) {
      return { key: content, source: "file", origin: `~/.pi/agent/secrets/${spec.secret}` };
    }
  } catch {
    // Missing or unreadable secret file: report unconfigured instead of failing.
  }

  return null;
}

/** How to fix a missing credential, for error messages and status output. */
export function credentialHint(platform: JevPlatform = resolvePlatform()): string {
  const spec = JEV_PLATFORMS[platform];
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
  apiKey: string,
  call: JevCall
): Promise<JevRawResponse> {
  const doFetch: typeof fetch = call.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (platform === "jevk5") {
    // apiKey carries the llama-server base URL for this platform.
    return callJevK5(apiKey, call, doFetch);
  }

  if (platform === "typesafe") {
    const client = new TypeSafeClient({ apiKey, fetch: doFetch });
    const res = await client.systemOne(
      { state: call.state, questions: call.questions, model: call.model } as SystemOneCall,
      { signal: call.signal }
    );
    const usage = res?.usage;
    return {
      answers: res?.answers ?? {},
      model: typeof res?.model === "string" ? res.model : undefined,
      usage: usage
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
          }
        : undefined,
    };
  }

  if (platform === "openrouter") {
    const json = await postJson(
      "https://openrouter.ai/api/alpha/decisions",
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
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run`,
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
    "https://ai-gateway.vercel.sh/v4/ai/evaluation-model",
    {
      ...bearer(apiKey),
      // The gateway rejects requests without its protocol and auth-method headers.
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
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
function direct(json: any): JevRawResponse {
  const answers = json?.answers;
  if (!answers || typeof answers !== "object") {
    throw new Error("Jev response contained no answers.");
  }

  const usage = json?.usage;
  const inputTokens = usage?.input_tokens ?? usage?.inputTokens;
  const outputTokens = usage?.output_tokens ?? usage?.outputTokens;

  return {
    answers,
    model: typeof json?.model === "string" ? json.model : undefined,
    usage: usage
      ? {
          inputTokens,
          outputTokens,
          totalTokens: usage.total_tokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
        }
      : undefined,
  };
}

/** Cloudflare nests the answer payload under up to two `result` envelopes. */
function unwrapEnvelope(json: any): any {
  let value = json;
  for (let depth = 0; depth < 3 && value && typeof value === "object" && !value.answers; depth++) {
    value = value.result ?? value;
  }
  return value;
}

/** The gateway reports per-question confidence in provider metadata, not in the answer. */
function extractConfidence(json: any): Record<string, number> | undefined {
  const confidence = json?.providerMetadata?.typesafe?.confidence;
  if (!confidence || typeof confidence !== "object") return undefined;

  const entries = Object.entries(confidence).filter(([, value]) => typeof value === "number");
  return entries.length > 0 ? (Object.fromEntries(entries) as Record<string, number>) : undefined;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<any> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Jev request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`
    );
  }

  return response.json();
}

function bearer(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}
