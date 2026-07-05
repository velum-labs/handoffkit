/**
 * Reconstruct a native agent trajectory from the `cursor-agent` CLI's
 * `--output-format stream-json` stdout.
 *
 * Like the `claude` CLI, cursor-agent emits one JSON object per line in headless
 * print mode. The relevant events are:
 *   - `{type:"assistant", message:{content:[...]}}` whose content blocks are
 *     `text` (output), `thinking` (reasoning), and `tool_use`/`tool_call`
 *     (tool_call).
 *   - `{type:"user", message:{content:[{type:"tool_result", ...}]}}`
 *     (observation), carrying the result for a prior tool call.
 *   - `{type:"result", subtype, result, is_error}` — the terminal summary whose
 *     `result` is the final answer and whose `is_error` is the authoritative
 *     success signal (more reliable than the process exit code).
 *
 * fusionkit owns no verification, so reconstructed steps carry raw observations
 * only — never a computed verdict.
 */
import type { TrajectoryStep } from "@fusionkit/ensemble";
import {
  asArray,
  asObject,
  asString,
  createStreamJsonStepEmitter,
  parseStreamJsonTrajectory,
  streamJsonResultContentText,
  stringifyStreamJsonValue,
  STREAM_JSON_MAX_TEXT,
  STREAM_JSON_MAX_TOOL_INPUT,
  truncateStreamJsonText
} from "@fusionkit/harness-core";

export type CursorStreamTrajectory = {
  steps: TrajectoryStep[];
  finalOutput: string;
  /** Whether a terminal `result` event was seen (vs. an interrupted/crashed run). */
  sawResult: boolean;
  /** The terminal `result` event's `is_error` flag (false when absent). */
  isError: boolean;
};

export type CursorStreamStepEmitter = (line: string) => void;

/** Parse a single stream-json event into zero or more (un-indexed) steps. */
function stepsForEvent(event: Record<string, unknown>): Omit<TrajectoryStep, "index">[] {
  const out: Omit<TrajectoryStep, "index">[] = [];
  const type = asString(event.type);
  const message = asObject(event.message);
  if (message === undefined) return out;
  const role = asString(message.role);

  if (type === "assistant" && role === "assistant") {
    for (const block of asArray(message.content)) {
      const b = asObject(block);
      if (b === undefined) continue;
      const blockType = asString(b.type);
      if (blockType === "thinking") {
        const text = asString(b.thinking) ?? "";
        if (text.length > 0) out.push({ type: "reasoning", text: truncateStreamJsonText(text, STREAM_JSON_MAX_TEXT) });
      } else if (blockType === "text") {
        const text = asString(b.text) ?? "";
        if (text.length > 0) out.push({ type: "output", text: truncateStreamJsonText(text, STREAM_JSON_MAX_TEXT) });
      } else if (blockType === "tool_use" || blockType === "tool_call") {
        out.push({
          type: "tool_call",
          ...(asString(b.name) !== undefined ? { tool_name: asString(b.name) } : {}),
          ...(asString(b.id) !== undefined ? { tool_call_id: asString(b.id) } : {}),
          tool_input: truncateStreamJsonText(stringifyStreamJsonValue(b.input ?? b.arguments ?? {}), STREAM_JSON_MAX_TOOL_INPUT)
        });
      }
    }
  } else if (type === "user" && role === "user") {
    for (const block of asArray(message.content)) {
      const b = asObject(block);
      if (b === undefined) continue;
      if (asString(b.type) !== "tool_result") continue;
      const isError = b.is_error === true;
      out.push({
        type: "observation",
        ...(asString(b.tool_use_id) !== undefined
          ? { tool_call_id: asString(b.tool_use_id) }
          : {}),
        text: truncateStreamJsonText(streamJsonResultContentText(b.content), STREAM_JSON_MAX_TEXT),
        ...(isError ? { is_error: true } : {})
      });
    }
  }
  return out;
}

/** Create an incremental parser for `cursor-agent --output-format stream-json` lines. */
export function createCursorStreamStepEmitter(onStep: (step: TrajectoryStep) => void): CursorStreamStepEmitter {
  return createStreamJsonStepEmitter<Omit<TrajectoryStep, "index">>({
    onStep,
    stepsForEvent,
    resultStep: (result) => ({
      type: "output",
      text: truncateStreamJsonText(result, STREAM_JSON_MAX_TEXT)
    })
  });
}

/**
 * Reconstruct a trajectory from the full `cursor-agent -p --output-format
 * stream-json` stdout. Non-JSON lines (and irrelevant system events) are ignored.
 */
export function parseCursorStreamJson(stdout: string): CursorStreamTrajectory {
  const parsed = parseStreamJsonTrajectory<Omit<TrajectoryStep, "index">>({
    stdout,
    stepsForEvent,
    resultStep: (result) => ({
      type: "output",
      text: truncateStreamJsonText(result, STREAM_JSON_MAX_TEXT)
    }),
    // Preserve previous behavior: an interrupted run falls back only to assistant output.
    fallbackText: (step) => (step.type === "output" ? step.text : "")
  });
  return {
    steps: parsed.steps,
    finalOutput: parsed.finalOutput,
    sawResult: parsed.sawResult,
    isError: parsed.isError
  };
}
