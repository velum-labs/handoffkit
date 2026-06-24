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

export type CursorStreamTrajectory = {
  steps: TrajectoryStep[];
  finalOutput: string;
  /** Whether a terminal `result` event was seen (vs. an interrupted/crashed run). */
  sawResult: boolean;
  /** The terminal `result` event's `is_error` flag (false when absent). */
  isError: boolean;
};

const MAX_TEXT = 4000;
const MAX_TOOL_INPUT = 600;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A tool_result `content` is either a string or an array of text/parts. */
function resultContentText(content: unknown): string {
  const direct = asString(content);
  if (direct !== undefined) return direct;
  return asArray(content)
    .map((part) => {
      const obj = asObject(part);
      if (obj === undefined) return "";
      if (obj.type === "text") return asString(obj.text) ?? "";
      return "";
    })
    .filter((text) => text.length > 0)
    .join("");
}

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
        if (text.length > 0) out.push({ type: "reasoning", text: truncate(text, MAX_TEXT) });
      } else if (blockType === "text") {
        const text = asString(b.text) ?? "";
        if (text.length > 0) out.push({ type: "output", text: truncate(text, MAX_TEXT) });
      } else if (blockType === "tool_use" || blockType === "tool_call") {
        out.push({
          type: "tool_call",
          ...(asString(b.name) !== undefined ? { tool_name: asString(b.name) } : {}),
          ...(asString(b.id) !== undefined ? { tool_call_id: asString(b.id) } : {}),
          tool_input: truncate(stringify(b.input ?? b.arguments ?? {}), MAX_TOOL_INPUT)
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
        text: truncate(resultContentText(b.content), MAX_TEXT),
        ...(isError ? { is_error: true } : {})
      });
    }
  }
  return out;
}

/**
 * Reconstruct a trajectory from the full `cursor-agent -p --output-format
 * stream-json` stdout. Non-JSON lines (and irrelevant system events) are ignored.
 */
export function parseCursorStreamJson(stdout: string): CursorStreamTrajectory {
  const steps: TrajectoryStep[] = [];
  let finalOutput = "";
  let sawResult = false;
  let isError = false;
  const push = (step: Omit<TrajectoryStep, "index">): void => {
    steps.push({ index: steps.length, ...step });
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== "{") continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const obj = asObject(event);
    if (obj === undefined) continue;
    if (asString(obj.type) === "result") {
      sawResult = true;
      if (obj.is_error === true) isError = true;
      const result = asString(obj.result);
      if (result !== undefined && result.length > 0) finalOutput = result;
      continue;
    }
    for (const step of stepsForEvent(obj)) push(step);
  }
  // The terminal `result` is the canonical final answer. If it was absent (e.g.
  // an interrupted run), fall back to the last assistant output step.
  if (finalOutput.length === 0) {
    for (let i = steps.length - 1; i >= 0; i -= 1) {
      const step = steps[i];
      if (step?.type === "output" && step.text !== undefined && step.text.length > 0) {
        finalOutput = step.text;
        break;
      }
    }
  } else if (steps.at(-1)?.text !== finalOutput) {
    push({ type: "output", text: truncate(finalOutput, MAX_TEXT) });
  }
  return { steps, finalOutput, sawResult, isError };
}
