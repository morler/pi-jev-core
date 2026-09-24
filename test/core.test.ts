import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";
import { callJev } from "../src/platform.js";
import { JevClient } from "../src/jev.js";

function setEnv(patch: Record<string, string | undefined>): () => void {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("jev_evaluate sends and normalizes all three question types", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "openrouter", OPENROUTER_API_KEY: "unit-test-key" });
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({
      model: "typesafe/jev-1.13",
      answers: {
        breaking: { type: "noul", noul: 0.9 },
        kind: { type: "choice", choice: "api", distribution: { api: 0.8, other: 0.2 } },
        severity: { type: "score", score: 1, confidence: 0.7 }
      },
      usage: { input_tokens: 11, output_tokens: 3 }
    });
  }) as typeof fetch;

  try {
    let tool: any;
    extension({ registerTool(definition: any) { tool = definition; } } as unknown as ExtensionAPI);
    assert.equal(tool.name, "jev_evaluate");

    const result = await tool.execute("test-call", {
      state: { change: "Added a required field." },
      questions: {
        breaking: { type: "noul", instructions: "Does this break existing callers?" },
        kind: {
          type: "choice",
          instructions: "Classify the change.",
          criteria: { api: "Public API change", other: "Other" }
        },
        severity: {
          type: "score",
          instructions: "Rate impact.",
          criteria: ["Critical", "High", "Low"]
        }
      }
    });

    assert.equal(requestUrl, "https://openrouter.ai/api/alpha/decisions");
    const body = JSON.parse(String(requestInit?.body));
    assert.deepEqual(body.state, { change: "Added a required field." });
    assert.equal(body.questions.breaking.type, "noul");
    assert.deepEqual(body.questions.kind.criteria, { api: "Public API change", other: "Other" });
    assert.deepEqual(body.questions.severity.criteria, ["Critical", "High", "Low"]);
    assert.equal(result.details.answers.breaking.value, 0.9);
    assert.equal(result.details.answers.kind.value, "api");
    assert.equal(result.details.answers.kind.distribution.api, 0.8);
    assert.equal(result.details.answers.severity.value, 1);
    assert.equal(result.details.usage.totalTokens, 14);
    assert.match(result.content[0].text, /"model": "typesafe\/jev-1\.13"/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("Vercel maps Noul and carries confidence through", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({
      answers: { likely: { type: "boolean", probability: 0.75 } },
      providerMetadata: { typesafe: { confidence: { likely: 0.8 } } }
    });
  };

  const response = await callJev("vercel", "unit-test-key", {
    state: "text",
    questions: { likely: { type: "noul", instructions: "Is it likely?" } },
    model: "typesafe-ai/jev",
    fetch: fetchImpl
  });

  assert.equal(requestUrl, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("ai-gateway-protocol-version"), "0.0.1");
  assert.equal(JSON.parse(String(requestInit?.body)).questions.likely.type, "boolean");
  assert.deepEqual(response.answers.likely, { type: "boolean", probability: 0.75 });
  assert.equal(response.confidence?.likely, 0.8);
});

test("Cloudflare unwraps its gateway response and sends the account route", async () => {
  const restoreEnv = setEnv({
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_GATEWAY_ID: "test-gateway"
  });
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return jsonResponse({
      success: true,
      result: { state: "Completed", result: { answers: { ready: { noul: 0.6 } } } }
    });
  };

  try {
    const response = await callJev("cloudflare", "unit-test-key", {
      state: "text",
      questions: { ready: { type: "noul", instructions: "Ready?" } },
      model: "typesafe/jev",
      fetch: fetchImpl
    });
    assert.equal(
      requestUrl,
      "https://api.cloudflare.com/client/v4/accounts/test-account/ai/run"
    );
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get("cf-aig-gateway-id"), "test-gateway");
    assert.deepEqual(response.answers, { ready: { noul: 0.6 } });
  } finally {
    restoreEnv();
  }
});

test("TypeSafe platform delegates to its SDK", async () => {
  let calls = 0;
  const response = await callJev("typesafe", "unit-test-key", {
    state: "text",
    questions: { ready: { type: "noul", instructions: "Ready?" } },
    model: "jev-latest",
    fetch: async () => {
      calls++;
      return jsonResponse({
        answers: { ready: { noul: 0.65 } },
        model: "jev-latest",
        usage: { input_tokens: 2, output_tokens: 1 }
      });
    }
  });

  assert.ok(calls > 0);
  assert.deepEqual(response.answers.ready, { noul: 0.65 });
  assert.equal(response.usage?.totalTokens, 3);
});

test("choice questions without a criteria map fail fast locally, never reaching the network", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "openrouter", OPENROUTER_API_KEY: "unit-test-key" });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return jsonResponse({ answers: {} });
  }) as typeof fetch;
  try {
    const client = new JevClient();
    await assert.rejects(
      client.evaluate({
        state: "s",
        questions: { bad: { type: "choice", instructions: "Pick one." } } as any,
      }),
      /needs criteria as a map/
    );
    assert.equal(fetchCalls, 0, "the malformed request never reached the network");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("score questions with fewer than two criteria fail fast locally, never reaching the network", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "openrouter", OPENROUTER_API_KEY: "unit-test-key" });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return jsonResponse({ answers: {} });
  }) as typeof fetch;
  try {
    const client = new JevClient();
    for (const criteria of [[], ["OnlyOne"]]) {
      await assert.rejects(
        client.evaluate({
          state: "s",
          questions: { bad: { type: "score", instructions: "Rate it.", criteria } as any },
        }),
        /needs criteria as an array/
      );
    }
    assert.equal(fetchCalls, 0, "the malformed request never reached the network");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});
