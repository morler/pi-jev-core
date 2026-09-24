import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JevClient } from "../src/jev.js";
import type { JevEvaluationRequest } from "../src/types.js";

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

export default function (pi: ExtensionAPI): void {
  const jev = new JevClient();

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
        Type.Record(Type.String(), Type.Any())
      ], { description: "Text or structured JSON to evaluate." }),
      questions: Type.Record(Type.String(), questionSchema, {
        minProperties: 1,
        description: "Named, independent Jev questions."
      }),
      model: Type.Optional(Type.String({ description: "Jev model override." }))
    }),
    async execute(_toolCallId, params, signal) {
      const response = await jev.evaluate(params as JevEvaluationRequest, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        details: response
      };
    }
  });
}
