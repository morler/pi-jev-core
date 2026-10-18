import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JevClient } from "../src/jev.js";
import type { JevEvaluationRequest } from "../src/types.js";
import { isJevPlatform, JEV_PLATFORMS, persistPlatform, platformStorePath, resolveCredential, resolveModel, type JevPlatform } from "../src/platform.js";
import { errorMessage, updateConfig } from "../src/config.js";
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

export default function (pi: ExtensionAPI): void {
  let jev = new JevClient();

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
        const response = await jev.evaluate(request, signal);
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
          details: response
        };
      } catch (error) {
        // The model sees which platform failed; the original error stays reachable as the cause.
        throw new Error(`Jev evaluation on ${jev.platform} failed: ${errorMessage(error)}`, { cause: error });
      }
    }
  });

  pi.registerCommand("jev-platform", {
    description: "List or switch the active Jev platform (/jev-platform [name] | local <port> | log on|off)",
    handler: async (args, ctx) => {
      const [requested, arg, ...extra] = args?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
      if (extra.length > 0) {
        ctx.ui.notify(`Unexpected argument(s): ${extra.join(" ")}`, "warning");
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
        const lines = (Object.keys(JEV_PLATFORMS) as JevPlatform[]).map((name) => {
          const marker = name === jev.platform ? "*" : " ";
          const origin = resolveCredential(name)?.origin ?? "not configured";
          return `${marker} ${name} — ${origin}`;
        });
        ctx.ui.notify(`Active platform: ${jev.platform}\n${lines.join("\n")}`, "info");
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

      // Persist first and touch the environment only once that worked: a failed write must not leave the running
      // process pointing at a platform that was never stored.
      try {
        if (localPort !== undefined && !(process.env.JEV_PLATFORM_FILE ?? "").trim()) updateConfig({ localPort });
        persistPlatform(requested);
      } catch (error) {
        ctx.ui.notify(`Unable to persist the Jev platform: ${errorMessage(error)}`, "error");
        return;
      }
      if (localPort !== undefined) process.env.JEV_LOCAL_PORT = String(localPort);
      process.env.JEV_PLATFORM = requested;
      jev = new JevClient();

      const origin = jev.getCredentialOrigin() ?? "not configured";
      ctx.ui.notify(
        `Jev platform switched to ${requested} (credential: ${origin}, model: ${resolveModel(requested)}; persisted to ${platformStorePath()})`,
        "info"
      );
    },
  });
}
