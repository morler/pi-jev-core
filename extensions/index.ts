import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getJev, resetJev } from "../src/jev.js";
import type { JevEvaluationRequest } from "../src/types.js";
import { isJevPlatform, JEV_PLATFORMS, persistPlatform, platformStorePath, resolveCredential, resolveModel, type JevPlatform } from "../src/platform.js";
import { errorMessage, updateConfig, validEndpoint, type JevConfig } from "../src/config.js";
import { isJevLoggingEnabled, setJevLoggingEnabled } from "../src/log.js";

const questionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("noul"),
    instructions: Type.String({ description: "Yes/no judgment; Jev returns the probability of yes." })
  }),
  Type.Object({
    type: Type.Literal("choice"),
    instructions: Type.String({ description: "Judgment instruction." }),
    criteria: Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Null()]),
      { minProperties: 1, description: "Candidate keys mapped to descriptions." }
    )
  }),
  Type.Object({
    type: Type.Literal("score"),
    instructions: Type.String({ description: "Judgment instruction." }),
    criteria: Type.Array(Type.String(), {
      minItems: 2,
      description: "Ordered rubric levels, highest first; at least two (index = score, starting at 0)."
    })
  })
]);

const USAGE_LOCAL = "Usage: /jev-platform local <port 1-65535>";
const USAGE_LOG = "Usage: /jev-platform log on|off";
const USAGE_CUSTOM = "Usage: /jev-platform custom <endpoint-url> [model]";

export default function (pi: ExtensionAPI): void {

  pi.registerTool({
    name: "jev_evaluate",
    label: "Jev Evaluate",
    description:
      "Run a Jev System One evaluation using noul (yes probability), choice, or score questions. The state is sent to the configured Jev platform; do not include secrets.",
    promptSnippet: "Use Jev for structured probability, choice, or rubric decisions",
    promptGuidelines: [
      "Use for structured judgments rather than open-ended text generation.",
      "Send only the state required; it is transmitted to the configured Jev platform."
    ],
    parameters: Type.Object({
      state: Type.Union([
        Type.String(),
        Type.Record(Type.String(), Type.Unknown())
      ], { description: "Text or JSON object; object fields referenced by questions are selected before transmission." }),
      questions: Type.Record(Type.String(), questionSchema, {
        minProperties: 1,
        description: "Named, independent Jev questions."
      }),
      model: Type.Optional(Type.String({ description: "Jev model override." }))
    }),
    async execute(_toolCallId, params, signal) {
      const request = params as JevEvaluationRequest;
      try {
        const response = await getJev().evaluate(request, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: response
        };
      } catch (error) {
        // The model sees which platform failed; the original error stays reachable as the cause.
        throw new Error(`Jev evaluation on ${getJev().platform} failed: ${errorMessage(error)}`, { cause: error });
      }
    }
  });

  pi.registerCommand("jev-platform", {
    description: "List or switch the active Jev platform (/jev-platform [name] | local <port> | custom <url> [model] | log on|off)",
    handler: async (args, ctx) => {
      // Only the platform name is lowercased: an endpoint URL and a model id can be case-sensitive.
      const tokens = args?.trim().split(/\s+/).filter(Boolean) ?? [];
      const requested = tokens[0]?.toLowerCase();
      const arg = tokens[1];
      const extra = tokens.slice(2);
      // `custom <url> [model]` is the one form that takes a second argument.
      const allowedExtra = requested === "custom" ? 1 : 0;
      if (extra.length > allowedExtra) {
        ctx.ui.notify(`Unexpected argument(s): ${extra.slice(allowedExtra).join(" ")}`, "warning");
        return;
      }
      if (requested === "log") {
        if (!["on", "off"].includes(arg ?? "")) {
          ctx.ui.notify(`${USAGE_LOG} (currently ${isJevLoggingEnabled() ? "on" : "off"})`, "warning");
          return;
        }
        const enabled = arg === "on";
        try {
          setJevLoggingEnabled(enabled);
        } catch (error) {
          ctx.ui.notify(`Unable to persist the logging setting: ${errorMessage(error)}`, "error");
          return;
        }
        ctx.ui.notify(`Jev logging ${enabled ? "enabled" : "disabled"}`, "info");
        return;
      }
      if (!requested) {
        const active = getJev().platform;
        const lines = (Object.keys(JEV_PLATFORMS) as JevPlatform[]).map((name) => {
          const marker = name === active ? "*" : " ";
          const origin = resolveCredential(name)?.origin ?? "not configured";
          return `${marker} ${name} — ${origin}`;
        });
        ctx.ui.notify(`Active platform: ${active}\n${lines.join("\n")}`, "info");
        return;
      }
      if (!isJevPlatform(requested)) {
        ctx.ui.notify(`Unknown platform "${requested}". Available: ${Object.keys(JEV_PLATFORMS).join(", ")}`, "warning");
        return;
      }

      let localPort: number | undefined;
      if (requested === "local") {
        if (arg) {
          // Only plain decimal digits: Number() would also accept "0x10", "1e3" and "+80".
          const port = /^[0-9]+$/.test(arg) ? Number(arg) : NaN;
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            ctx.ui.notify(USAGE_LOCAL, "warning");
            return;
          }
          localPort = port;
        } else if (!resolveCredential("local")) {
          ctx.ui.notify(USAGE_LOCAL, "warning");
          return;
        }
      }

      let customEndpoint: string | undefined;
      let customModel: string | undefined;
      if (requested === "custom") {
        if (arg) {
          const url = validEndpoint(arg);
          if (!url) {
            ctx.ui.notify(USAGE_CUSTOM, "warning");
            return;
          }
          customEndpoint = url;
          customModel = extra[0];
        } else if (!resolveCredential("custom")) {
          ctx.ui.notify(USAGE_CUSTOM, "warning");
          return;
        }
      }

      // Persist first and touch the environment only once that worked: a failed write must not leave the running
      // process pointing at a platform that was never stored.
      const configUpdate: Partial<JevConfig> = {};
      if (localPort !== undefined) configUpdate.localPort = localPort;
      if (customEndpoint !== undefined) configUpdate.customEndpoint = customEndpoint;
      if (customModel !== undefined) configUpdate.customModel = customModel;
      try {
        // A store file (JEV_PLATFORM_FILE) owns the persisted choice, so the config file stays untouched then.
        if (Object.keys(configUpdate).length > 0 && !(process.env.JEV_PLATFORM_FILE ?? "").trim()) {
          updateConfig(configUpdate);
        }
        persistPlatform(requested);
      } catch (error) {
        ctx.ui.notify(`Unable to persist the Jev platform: ${errorMessage(error)}`, "error");
        return;
      }
      if (localPort !== undefined) process.env.JEV_LOCAL_PORT = String(localPort);
      if (customEndpoint !== undefined) process.env.JEV_CUSTOM_ENDPOINT = customEndpoint;
      if (customModel !== undefined) process.env.JEV_CUSTOM_MODEL = customModel;
      process.env.JEV_PLATFORM = requested;
      // The shared client is rebuilt, so other extensions see the new platform on their next call.
      resetJev();

      const origin = getJev().getCredentialOrigin() ?? "not configured";
      ctx.ui.notify(
        `Jev platform switched to ${requested} (credential: ${origin}, model: ${resolveModel(requested)}; persisted to ${platformStorePath()})`,
        "info"
      );
    },
  });
}
