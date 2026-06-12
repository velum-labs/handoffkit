/**
 * Scripted mock models for the demo series, so demos 09/11/12 run
 * deterministically and key-free in CI. One canonical wiring instead of a
 * copy of the MockLanguageModelV3 plumbing in every example; the
 * governance the demos exercise is identical with real models (see
 * models.ts / resolveDemoModels).
 */
import { MockLanguageModelV3 } from "ai/test";

const usage = {
  inputTokens: {
    total: 8,
    noCache: 8,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined }
};

/** A model that always answers with one fixed text completion. */
export function mockTextModel(modelId: string, text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    modelId,
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage,
      warnings: []
    })
  });
}

/**
 * A model that issues exactly one tool call on its first turn, then
 * answers with text — the canonical scripted loop for tool-calling demos.
 */
export function mockToolThenTextModel(options: {
  toolName: string;
  input: unknown;
  text: string;
}): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls++;
      if (calls === 1) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: options.toolName,
              input: JSON.stringify(options.input)
            }
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
          usage,
          warnings: []
        };
      }
      return {
        content: [{ type: "text" as const, text: options.text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: []
      };
    }
  });
}
