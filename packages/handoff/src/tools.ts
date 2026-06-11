import { hashCanonical } from "@warrant/protocol";
import type { JsonValue, ToolCallRecord } from "@warrant/protocol";

/**
 * Structural stand-in for an AI SDK tool (or any tool object). The wrapper
 * only cares whether an `execute` function is present at runtime, so the
 * constraint is deliberately loose: concrete tool types (including the `ai`
 * package's `Tool`) remain assignable without this package depending on it.
 */
export type ToolLike = object;

export type ToolCallObservation = {
  record: ToolCallRecord;
  inputHash: string;
  outputHash?: string;
  ok: boolean;
};

/** Best-effort JSON projection; non-serializable values degrade to strings. */
function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

/**
 * Wrap a toolset so every invocation is journaled: raw input/output go to
 * the journal (carried as content-addressed semantic state at the next
 * checkpoint), and the observer receives hashes for the local trace.
 * Everything else about each tool — description, schema, identity — is
 * preserved, so the wrapped set drops into generateText unchanged.
 */
export function wrapTools<T extends Record<string, ToolLike>>(
  toolset: T,
  nextSeq: () => number,
  observe: (observation: ToolCallObservation) => void
): T {
  const wrapped: Record<string, ToolLike> = {};
  for (const [name, original] of Object.entries(toolset)) {
    const execute = (original as { execute?: unknown }).execute;
    if (typeof execute !== "function") {
      wrapped[name] = original;
      continue;
    }
    const callable = execute as (input: unknown, options: unknown) => unknown;
    wrapped[name] = {
      ...original,
      execute: async (input: unknown, options: unknown): Promise<unknown> => {
        const started = Date.now();
        const ts = new Date(started).toISOString();
        const inputJson = toJsonValue(input);
        const inputHash = hashCanonical(inputJson);
        try {
          const output = await callable.call(original, input, options);
          const outputJson = toJsonValue(output);
          observe({
            record: {
              seq: nextSeq(),
              ts,
              toolName: name,
              input: inputJson,
              output: outputJson,
              durationMs: Date.now() - started
            },
            inputHash,
            outputHash: hashCanonical(outputJson),
            ok: true
          });
          return output;
        } catch (error) {
          observe({
            record: {
              seq: nextSeq(),
              ts,
              toolName: name,
              input: inputJson,
              error: error instanceof Error ? error.message : String(error),
              durationMs: Date.now() - started
            },
            inputHash,
            ok: false
          });
          throw error;
        }
      }
    };
  }
  return wrapped as T;
}
