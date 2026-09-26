import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.js";
import { callJev, resolvePlatform } from "../src/platform.js";
import { JevClient } from "../src/jev.js";
import * as fs from "node:fs";
import * as os from "node:os";

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
    extension({
      registerTool(definition: any) { tool = definition; },
      registerCommand() {},
    } as unknown as ExtensionAPI);
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

test("JevK5 tokenizes and reads letter logprobs from llama-server", async () => {
  const urls: string[] = [];
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    bodies.push(JSON.parse(String(init?.body)));
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1, 2, 3, 4] });
    return jsonResponse({
      completion_probabilities: [{
        content: "A",
        top_logprobs: [{ token: "A", logprob: -0.1 }, { token: "B", logprob: -2.3 }]
      }]
    });
  };

  const response = await callJev("jevk5", "http://127.0.0.1:8008", {
    state: { text: "billed twice" },
    questions: {
      team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", tech: "Bugs" } }
    },
    model: "jevk5-4b-v0.2",
    fetch: fetchImpl
  });

  assert.deepEqual(urls, ["http://127.0.0.1:8008/tokenize", "http://127.0.0.1:8008/completion"]);
  assert.equal(bodies[0].parse_special, true);
  assert.match(bodies[0].content, /im_start.*system/s);
  assert.match(bodies[0].content, /billing: Payments/);
  assert.equal(bodies[1].n_predict, 1);
  assert.equal(bodies[1].temperature, 0);
  assert.equal(bodies[1].cache_prompt, false);
  const answer = response.answers.team as any;
  assert.equal(answer.type, "choice");
  assert.equal(answer.choice, "billing");
  assert.ok(answer.probabilities.billing > answer.probabilities.tech);
  const total = Object.values(answer.probabilities).reduce((a: number, b) => a + (b as number), 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.equal(response.usage?.inputTokens, 4);
});

test("JevK5 maps noul to the true/false pair and score to the expected level", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1] });
    return jsonResponse({
      completion_probabilities: [{
        top_logprobs: [{ token: "A", logprob: -0.2 }, { token: "B", logprob: -1.6 }]
      }]
    });
  };
  const restoreEnv = setEnv({ JEVK5_TEMP: "1" });
  try {
    const response = await callJev("jevk5", "http://127.0.0.1:9", {
      state: "s",
      questions: {
        ready: { type: "noul", instructions: "Ready?" },
        depth: { type: "score", instructions: "Rate.", criteria: ["Low", "High"] }
      },
      model: "jevk5-4b-v0.2",
      fetch: fetchImpl
    });
    const ready = response.answers.ready as any;
    assert.equal(ready.type, "noul");
    // e^1.4 / (e^1.4 + 1) ~ 0.80 at temperature 1
    assert.ok(ready.noul > 0.7 && ready.noul < 0.9, "noul = P(true)");
    const depth = response.answers.depth as any;
    // EV over levels [0,1] with p(0) ~ 0.80 sits between the levels, closer to 0.
    assert.ok(depth.score > 0 && depth.score < 0.5, "score is the expected level");
    assert.ok(depth.probabilities["0"] > depth.probabilities["1"]);
  } finally {
    restoreEnv();
  }
});

test("JevClient works against the local JevK5 platform without an API key", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "jevk5" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1, 2] });
    return jsonResponse({
      completion_probabilities: [{
        top_logprobs: [{ token: "A", logprob: -0.05 }, { token: "B", logprob: -3.0 }]
      }]
    });
  }) as typeof fetch;
  try {
    const client = new JevClient();
    assert.equal(client.isConfigured(), true, "local JevK5 needs no API key");
    assert.match(client.getKeyOrigin() ?? "", /default/);
    const result = await client.evaluate({
      state: "The package arrived.",
      questions: { delivered: { type: "noul", instructions: "Was the package delivered?" } }
    });
    assert.equal(result.answers.delivered.type, "noul");
    assert.ok(Number(result.answers.delivered.value) > 0.5);
    assert.equal(result.model, "jevk5-4b-v0.2");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("JevK5 rejects more options than answer letters", async () => {
  const fetchImpl: typeof fetch = async () => jsonResponse({ answers: {} });
  const criteria = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`opt${i}`, `Option ${i}`])
  );
  await assert.rejects(
    callJev("jevk5", "http://127.0.0.1:9", {
      state: "s",
      questions: { pick: { type: "choice", instructions: "Pick.", criteria } },
      model: "jevk5-4b-v0.2",
      fetch: fetchImpl,
    }),
    /only 16 answer letters/
  );
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
    assert.match(listText, /jevk5/);
    assert.match(listText, /not configured/);

    await command.handler("jevk5", ctx);
    assert.equal(process.env.JEV_PLATFORM, "jevk5");
    assert.match(notifications.at(-1)![0], /switched to jevk5/);

    await command.handler("nope", ctx);
    assert.equal(process.env.JEV_PLATFORM, "jevk5", "an unknown name must not switch");
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

    await commands["jev-platform"].handler("jevk5", ctx);
    assert.equal(fs.readFileSync(store, "utf8").trim(), "jevk5", "the choice lands in the store file");
    assert.equal(resolvePlatform(), "jevk5", "env still wins in-session");
    assert.match(notifications.at(-1)![0], /persisted/);

    // a fresh process resolves from the store when JEV_PLATFORM is unset
    delete process.env.JEV_PLATFORM;
    assert.equal(resolvePlatform(), "jevk5");
    assert.equal(new JevClient().platform, "jevk5");

    // invalid store content falls back to typesafe
    fs.writeFileSync(store, "bogus");
    assert.equal(resolvePlatform(), "typesafe");
  } finally {
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Decider platform (decider-4b via llama-server, plain layout) ----

test("Decider tokenizes the plain layout and reads letter logprobs from llama-server", async () => {
  const urls: string[] = [];
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    bodies.push(JSON.parse(String(init?.body)));
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1, 2, 3, 4] });
    return jsonResponse({
      completion_probabilities: [{
        top_logprobs: [{ token: "A", logprob: -0.1 }, { token: "B", logprob: -2.3 }]
      }]
    });
  };
  const restoreEnv = setEnv({ DECIDER_TEMPERATURE: "1" });
  try {
    const response = await callJev("decider", "http://127.0.0.1:8008", {
      state: { text: "billed twice" },
      questions: {
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", tech: "Bugs" } }
      },
      model: "decider-4b-v2.1",
      fetch: fetchImpl
    });
    assert.deepEqual(urls, [
      "http://127.0.0.1:8008/tokenize",
      "http://127.0.0.1:8008/tokenize",
      "http://127.0.0.1:8008/tokenize",
      "http://127.0.0.1:8008/completion"
    ]);
    assert.equal(bodies[0].content, "Context:\n");
    assert.equal(bodies[1].content, '{"text":"billed twice"}');
    assert.match(
      bodies[2].content,
      /^\n\nQuestion: Which team\?\nOptions:\n\(A\) billing: Payments\n\(B\) tech: Bugs\nAnswer: \($/
    );
    assert.equal(bodies[2].add_special, false);
    assert.equal(bodies[3].n_predict, 1);
    assert.equal(bodies[3].n_probs, 40);
    assert.equal(bodies[3].temperature, 0);
    assert.equal(bodies[3].cache_prompt, false);
    assert.ok(Array.isArray(bodies[3].prompt), "completion takes the token array");
    const answer = response.answers.team as any;
    assert.equal(answer.type, "choice");
    assert.equal(answer.choice, "billing");
    // softmax at temperature 1: e^2.2 / (1 + e^2.2) ~ 0.90
    assert.ok(answer.probabilities.billing > 0.85 && answer.probabilities.billing < 0.95);
    assert.equal(response.model, "decider-4b-v2.1");
  } finally {
    restoreEnv();
  }
});

test("Decider answers noul with P(yes) and score through isolated level rows", async () => {
  let completions = 0;
  const tails: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/tokenize")) {
      const body = JSON.parse(String(init?.body));
      if (body.content !== "Context:\n") tails.push(body.content);
      return jsonResponse({ tokens: [1] });
    }
    completions += 1;
    const logprobs = [
      [{ token: "A", logprob: -0.2 }, { token: "B", logprob: -1.6 }],  // noul: P(yes) ~ 0.198
      [{ token: "A", logprob: -0.1 }, { token: "B", logprob: -2.3 }],  // level 0 fits ~ 0.10
      [{ token: "A", logprob: -3.0 }, { token: "B", logprob: -0.05 }]  // level 1 fits ~ 0.95
    ][completions - 1];
    return jsonResponse({ completion_probabilities: [{ top_logprobs: logprobs }] });
  };
  const restoreEnv = setEnv({ DECIDER_TEMPERATURE: "1" });
  try {
    const response = await callJev("decider", "http://127.0.0.1:8008", {
      state: "s",
      questions: {
        ready: { type: "noul", instructions: "Ready?" },
        depth: { type: "score", instructions: "Rate.", criteria: ["0: Low", "1: High"] }
      },
      model: "decider-4b-v2.1",
      fetch: fetchImpl
    });
    const ready = response.answers.ready as any;
    assert.equal(ready.type, "noul");
    assert.ok(ready.noul > 0.15 && ready.noul < 0.25, "noul = P(yes) of the no/yes pair");
    assert.equal(completions, 3, "one yes/no row per score level");
    assert.match(tails[2]!, /Proposed answer: Low\nDoes the proposed answer fit\?/);
    assert.match(tails[3]!, /Proposed answer: High\nDoes the proposed answer fit\?/);
    const depth = response.answers.depth as any;
    // level fits ~ [0.10, 0.95] -> normalized ~ [0.095, 0.905], EV ~ 0.905
    assert.ok(depth.score > 0.85 && depth.score < 0.95, "score is the expected level");
    assert.ok(depth.probabilities["1"] > depth.probabilities["0"]);
    assert.ok(depth.confidence > 0.7);
  } finally {
    restoreEnv();
  }
});

test("JevClient works against the local Decider platform without an API key", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "decider", DECIDER_TEMPERATURE: "1" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1, 2] });
    return jsonResponse({
      completion_probabilities: [{
        top_logprobs: [{ token: "A", logprob: -3.0 }, { token: "B", logprob: -0.05 }]
      }]
    });
  }) as typeof fetch;
  try {
    const client = new JevClient();
    assert.equal(client.isConfigured(), true, "local Decider needs no API key");
    assert.match(client.getKeyOrigin() ?? "", /default/);
    const result = await client.evaluate({
      state: "The package arrived.",
      questions: { delivered: { type: "noul", instructions: "Was the package delivered?" } }
    });
    assert.equal(result.answers.delivered.type, "noul");
    assert.ok(Number(result.answers.delivered.value) > 0.9);
    assert.equal(result.model, "decider-4b-v2.1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("Decider rejects choice questions with more options than letters", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1] });
    return jsonResponse({ answers: {} });
  };
  const criteria = Object.fromEntries(
    Array.from({ length: 27 }, (_, i) => [`opt${i}`, `Option ${i}`])
  );
  await assert.rejects(
    callJev("decider", "http://127.0.0.1:9", {
      state: "s",
      questions: { pick: { type: "choice", instructions: "Pick.", criteria } },
      model: "decider-4b-v2.1",
      fetch: fetchImpl,
    }),
    /26 single-letter answer tokens/
  );
});

// ---- Hopper platform (hopper-4b via llama-server, GGUF chat template + JSON user turn) ----

test("Hopper applies the GGUF chat template and reads letter logprobs from llama-server", async () => {
  const urls: string[] = [];
  const bodies: any[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    bodies.push(JSON.parse(String(init?.body)));
    if (url.endsWith("/apply-template")) return jsonResponse({ prompt: "<|im_start|>rendered" });
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1, 2, 3, 4] });
    return jsonResponse({
      completion_probabilities: [{
        top_logprobs: [{ token: "A", logprob: -0.1 }, { token: "B", logprob: -2.3 }]
      }]
    });
  };

  const restoreEnv = setEnv({ HOPPER_TEMPERATURE: "1" });
  try {
    const response = await callJev("hopper", "http://127.0.0.1:8008", {
      state: { text: "billed twice" },
      questions: {
        team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", tech: "Bugs" } }
      },
      model: "hopper-4b-v1.1",
      fetch: fetchImpl
    });

    assert.deepEqual(urls, [
      "http://127.0.0.1:8008/apply-template",
      "http://127.0.0.1:8008/tokenize",
      "http://127.0.0.1:8008/completion"
    ]);
    assert.deepEqual(bodies[0].messages[0], {
      role: "system",
      content: "You make decisions about a document under a policy. Read only what is written in the document. Reply with the letter of the correct option and nothing else."
    });
    const user = JSON.parse(bodies[0].messages[1].content);
    assert.match(user.criterion, /Exactly one option is correct\.\n\nWhich team\?/);
    assert.deepEqual(user.options, [
      { letter: "A", description: "billing: Payments" },
      { letter: "B", description: "tech: Bugs" }
    ]);
    assert.equal(bodies[1].content, "<|im_start|>rendered");
    assert.equal(bodies[1].parse_special, true);
    assert.equal(bodies[2].n_predict, 1);
    assert.equal(bodies[2].temperature, 0);
    assert.equal(bodies[2].cache_prompt, false);
    const answer = response.answers.team as any;
    assert.equal(answer.type, "choice");
    assert.equal(answer.choice, "billing");
    // e^2.2 / (1 + e^2.2) ~ 0.90 at temperature 1
    assert.ok(answer.probabilities.billing > 0.85 && answer.probabilities.billing < 0.95);
    const total = Object.values(answer.probabilities).reduce((a: number, b) => a + (b as number), 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.equal(response.usage?.inputTokens, 4);
    assert.equal(response.model, "hopper-4b-v1.1");
  } finally {
    restoreEnv();
  }
});

test("Hopper maps noul to P(true) with the rubric in the policy and score to the expected level", async () => {
  const userTurns: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/apply-template")) {
      userTurns.push(JSON.parse(String(init?.body)).messages[1].content);
      return jsonResponse({ prompt: "<|im_start|>rendered" });
    }
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1] });
    return jsonResponse({
      completion_probabilities: [{
        top_logprobs: [{ token: "A", logprob: -0.2 }, { token: "B", logprob: -1.6 }]
      }]
    });
  };
  const restoreEnv = setEnv({ HOPPER_TEMPERATURE: "1" });
  try {
    const response = await callJev("hopper", "http://127.0.0.1:9", {
      state: "s",
      questions: {
        ready: { type: "noul", instructions: "Ready?" },
        depth: { type: "score", instructions: "Rate.", criteria: ["Low", "High"] }
      },
      model: "hopper-4b-v1.1",
      fetch: fetchImpl
    });
    const readyUser = JSON.parse(userTurns[0]);
    assert.match(readyUser.criterion, /true: yes\nfalse: no\n\nReady\?/);
    assert.deepEqual(readyUser.options, [
      { letter: "A", description: "true" },
      { letter: "B", description: "false" }
    ]);
    const ready = response.answers.ready as any;
    assert.equal(ready.type, "noul");
    // e^1.4 / (e^1.4 + 1) ~ 0.80 at temperature 1 — A (true) dominates
    assert.ok(ready.noul > 0.7 && ready.noul < 0.9, "noul = P(true)");
    const depthUser = JSON.parse(userTurns[1]);
    assert.deepEqual(depthUser.options, [
      { letter: "A", description: "0: Low" },
      { letter: "B", description: "1: High" }
    ]);
    const depth = response.answers.depth as any;
    // EV over levels [0,1] with p(0) ~ 0.80 sits between the levels, closer to 0.
    assert.ok(depth.score > 0 && depth.score < 0.5, "score is the expected level");
    assert.ok(depth.probabilities["0"] > depth.probabilities["1"]);
  } finally {
    restoreEnv();
  }
});

test("JevClient works against the local Hopper platform without an API key", async () => {
  const restoreEnv = setEnv({ JEV_PLATFORM: "hopper" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/apply-template")) return jsonResponse({ prompt: "p" });
    if (url.endsWith("/tokenize")) return jsonResponse({ tokens: [1, 2] });
    return jsonResponse({
      completion_probabilities: [{
        top_logprobs: [{ token: "A", logprob: -0.05 }, { token: "B", logprob: -3.0 }]
      }]
    });
  }) as typeof fetch;
  try {
    const client = new JevClient();
    assert.equal(client.isConfigured(), true, "local Hopper needs no API key");
    assert.match(client.getKeyOrigin() ?? "", /default/);
    const result = await client.evaluate({
      state: "The package arrived.",
      questions: { delivered: { type: "noul", instructions: "Was the package delivered?" } }
    });
    assert.equal(result.answers.delivered.type, "noul");
    assert.ok(Number(result.answers.delivered.value) > 0.5);
    assert.equal(result.model, "hopper-4b-v1.1");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("Hopper rejects choice questions with more options than letters", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/apply-template")) return jsonResponse({ prompt: "p" });
    return jsonResponse({ answers: {} });
  };
  const criteria = Object.fromEntries(
    Array.from({ length: 27 }, (_, i) => [`opt${i}`, `Option ${i}`])
  );
  await assert.rejects(
    callJev("hopper", "http://127.0.0.1:9", {
      state: "s",
      questions: { pick: { type: "choice", instructions: "Pick.", criteria } },
      model: "hopper-4b-v1.1",
      fetch: fetchImpl,
    }),
    /only 26 answer letters/
  );
});
