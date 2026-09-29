import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";
import { callJev, resolveCredential, resolvePlatform } from "../src/platform.js";
import { JevClient, selectReferencedState } from "../src/jev.js";
import * as fs from "node:fs";
import * as os from "node:os";

type Ctx = { ui: { notify: (text: string, level: string) => void } };
type CommandDef = { handler: (args: string, ctx: Ctx) => Promise<void> };

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

test("selectReferencedState sends only referenced fields without summarizing", () => {
  assert.deepEqual(
    selectReferencedState(
      { ticket: { title: "Bug", messages: [{ text: "broken" }] }, secret: "omit" },
      { one: { instructions: "Read `ticket.title`", }, two: { instructions: "Read `ticket.messages[0].text`" } }
    ),
    { ticket: { title: "Bug", messages: [{ text: "broken" }] } }
  );
});

test("selectReferencedState rejects prototype-pollution paths", () => {
  const polluted = Object.prototype as { polluted?: unknown; x?: unknown };
  delete polluted.polluted;
  delete polluted.x;
  assert.throws(() => selectReferencedState(
    JSON.parse('{"__proto__":{"polluted":5}}'),
    { q: { instructions: "Read `__proto__.polluted`" } }
  ));
  assert.throws(() => selectReferencedState(
    { a: { constructor: { prototype: { x: 1 } } } },
    { q: { instructions: "Read `a.constructor.prototype.x`" } }
  ));
  assert.equal(polluted.polluted, undefined);
  assert.equal(polluted.x, undefined);
});

 test("missing or unreferenced question state fails before network", () => {
  assert.throws(() => selectReferencedState(
    { change: "ok" },
    { q: { instructions: "Read `missing`" } }
  ));
  assert.throws(() => selectReferencedState(
    { change: "ok" },
    { q: { instructions: "Make a decision" } }
  ));
});

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
    extension({
      registerTool(definition: any) { tool = definition; },
      registerCommand() {},
    } as unknown as ExtensionAPI);
    assert.equal(tool.name, "jev_evaluate");

    const result = await tool.execute("test-call", {
      state: { change: "Added a required field." },
      questions: {
        breaking: { type: "noul", instructions: "Does `change` break existing callers?" },
        kind: {
          type: "choice",
          instructions: "Classify `change`.",
          criteria: { api: "Public API change", other: "Other" }
        },
        severity: {
          type: "score",
          instructions: "Rate the impact of `change`.",
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

test("/jev-platform lists, validates, and switches platforms", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "openrouter", OPENROUTER_API_KEY: "unit-test-key" });
  try {
    const commands: Record<string, any> = {};
    let tool: any;
    extension({
      registerTool(definition: any) { tool = definition; },
      registerCommand(name: string, definition: any) { commands[name] = definition; },
    } as unknown as ExtensionAPI);
    assert.equal(tool.name, "jev_evaluate");
    const command = commands["jev-platform"];
    assert.ok(command, "the jev-platform command is registered");
    const notifications: Array<[string, string]> = [];
    const ctx = { ui: { notify: (text: string, level: string) => { notifications.push([text, level]); } } } as any;

    await command.handler("", ctx);
    const listText = notifications.at(-1)![0];
    assert.match(listText, /Active platform: openrouter/);
    assert.match(listText, /cloudflare/);
    assert.match(listText, /not configured/);

    await command.handler("cloudflare", ctx);
    assert.equal(process.env.JEV_PLATFORM, "cloudflare");
    assert.match(notifications.at(-1)![0], /switched to cloudflare/);

    await command.handler("nope", ctx);
    assert.equal(process.env.JEV_PLATFORM, "cloudflare", "an unknown name must not switch");
    assert.equal(notifications.at(-1)![1], "warning");
    assert.match(notifications.at(-1)![0], /Unknown platform/);

    const configDir = fs.mkdtempSync(os.tmpdir() + "/jev-config-");
    const restoreConfigEnv = setEnv({ JEV_CONFIG_FILE: configDir + "/pi-jev-core.json" });
    try {
      await command.handler("log on", ctx);
      assert.equal(JSON.parse(fs.readFileSync(configDir + "/pi-jev-core.json", "utf8")).logging, true);
      assert.match(notifications.at(-1)![0], /enabled/);
      await command.handler("log off", ctx);
      assert.equal(JSON.parse(fs.readFileSync(configDir + "/pi-jev-core.json", "utf8")).logging, false);
      assert.match(notifications.at(-1)![0], /disabled/);
    } finally {
      restoreConfigEnv();
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  } finally {
    restoreEnv();
  }
});

test("switching platforms persists the choice for future sessions", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/jev-store-");
  const store = dir + "/platform";
  const restoreEnv = setEnv({ JEV_PLATFORM: "openrouter", OPENROUTER_API_KEY: "unit-test-key", JEV_PLATFORM_FILE: store });
  const commands: Record<string, any> = {};
  try {
    extension({
      registerTool() {},
      registerCommand(name: string, definition: any) { commands[name] = definition; },
    } as unknown as ExtensionAPI);
    const notifications: Array<[string, string]> = [];
    const ctx = { ui: { notify: (text: string, level: string) => { notifications.push([text, level]); } } } as any;

    await commands["jev-platform"].handler("cloudflare", ctx);
    assert.equal(fs.readFileSync(store, "utf8").trim(), "cloudflare", "the choice lands in the store file");
    assert.equal(resolvePlatform(), "cloudflare", "env still wins in-session");
    assert.match(notifications.at(-1)![0], /persisted/);

    // a fresh process resolves from the store when JEV_PLATFORM is unset
    delete process.env.JEV_PLATFORM;
    assert.equal(resolvePlatform(), "cloudflare");
    assert.equal(new JevClient().platform, "cloudflare");

    // invalid store content falls back to typesafe
    fs.writeFileSync(store, "bogus");
    assert.equal(resolvePlatform(), "typesafe");
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("local platform posts to the configured port and needs no API key", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "local", JEV_LOCAL_PORT: "8123" });
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody = "";
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestBody = String(init?.body);
    return jsonResponse({ answers: { ok: { type: "noul", noul: 0.75 } }, model: "local-jev" });
  }) as typeof fetch;
  try {
    assert.equal(resolveCredential("local")?.key, "8123");
    assert.equal(resolvePlatform(), "local");
    const response = await callJev("local", "8123", {
      state: { text: "hello" },
      questions: { ok: { type: "noul", instructions: "ok?" } },
      model: "jev-latest",
    });
    assert.equal(requestUrl, "http://127.0.0.1:8123/v1/systemone");
    assert.match(requestBody, /"state"/);
    assert.equal((response.answers as Record<string, any>).ok.noul, 0.75);
    assert.equal(response.model, "local-jev");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("/jev-platform local <port> persists the port and switches", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/jev-local-");
  const store = dir + "/config.json";
  const restoreEnv = setEnv({ JEV_PLATFORM: "typesafe", JEV_CONFIG_FILE: store, JEV_LOCAL_PORT: undefined });
  const commands: Record<string, CommandDef> = {};
  try {
    extension({
      registerTool() {},
      registerCommand(name: string, definition: CommandDef) { commands[name] = definition; },
    } as unknown as ExtensionAPI);
    const notifications: Array<[string, string]> = [];
    const ctx: Ctx = { ui: { notify: (text: string, level: string) => { notifications.push([text, level]); } } };

    await commands["jev-platform"].handler("local 8123", ctx);
    assert.equal(process.env.JEV_PLATFORM, "local");
    assert.equal(process.env.JEV_LOCAL_PORT, "8123");
    const persisted = JSON.parse(fs.readFileSync(store, "utf8"));
    assert.equal(persisted.localPort, 8123);
    assert.equal(persisted.platform, "local");
    assert.equal(resolveCredential("local")?.key, "8123");

    // an invalid port is rejected without changing anything
    await commands["jev-platform"].handler("local 99999", ctx);
    assert.match(notifications.at(-1)![0], /Usage/);
    assert.equal(process.env.JEV_LOCAL_PORT, "8123");

    // the port resolves from the config file alone in a fresh process
    delete process.env.JEV_PLATFORM;
    delete process.env.JEV_LOCAL_PORT;
    assert.equal(resolvePlatform(), "local");
    assert.equal(resolveCredential("local")?.key, "8123");
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
