/**
 * Reconstruct a native agent trajectory from the `claude` CLI's
 * `--output-format stream-json` stdout.
 *
 * Unlike codex (whose wire traffic we capture at an in-process gateway), the
 * headless `claude -p` CLI validates the selected model against the configured
 * endpoint's advertised model list and rejects a custom-gateway-advertised id,
 * so claude runs against its native Anthropic backend instead. We therefore
 * reconstruct the trajectory by parsing the CLI's structured stream-json events
 * rather than gateway wire capture.
 *
 * The stream emits one JSON object per line. The relevant events are:
 *   - `{type:"assistant", message:{content:[...]}}` whose content blocks are
 *     `thinking` (reasoning), `text` (output), and `tool_use` (tool_call).
 *   - `{type:"user", message:{content:[{type:"tool_result", ...}]}}`
 *     (observation), which carry the tool result for a prior `tool_use`.
 *   - `{type:"result", subtype, result, is_error}` — the terminal summary whose
 *     `result` is the final answer.
 *
 * fusionkit owns no verification, so reconstructed steps carry raw observations
 * only — never a computed verdict.
 */
import type { TrajectoryStep } from "@fusionkit/ensemble";

export type ClaudeStreamTrajectory = {
  steps: TrajectoryStep[];
  finalOutput: string;
};

export type ClaudeStreamStepEmitter = (line: string) => void;

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

function parseStreamJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed[0] !== "{") return undefined;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return asObject(event);
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
      } else if (blockType === "tool_use") {
        out.push({
          type: "tool_call",
          ...(asString(b.name) !== undefined ? { tool_name: asString(b.name) } : {}),
          ...(asString(b.id) !== undefined ? { tool_call_id: asString(b.id) } : {}),
          tool_input: truncate(stringify(b.input ?? {}), MAX_TOOL_INPUT)
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

/** Create an incremental parser for `claude --output-format stream-json` lines. */
export function createClaudeStreamStepEmitter(onStep: (step: TrajectoryStep) => void): ClaudeStreamStepEmitter {
  let index = 0;
  let lastText = "";
  const push = (step: Omit<TrajectoryStep, "index">): void => {
    const indexed = { index, ...step };
    index += 1;
    if (indexed.text !== undefined) lastText = indexed.text;
    onStep(indexed);
  };
  return (line: string): void => {
    const obj = parseStreamJsonLine(line);
    if (obj === undefined) return;
    if (asString(obj.type) === "result") {
      const result = asString(obj.result);
      if (result !== undefined && result.length > 0 && lastText !== result) {
        push({ type: "output", text: truncate(result, MAX_TEXT) });
      }
      return;
    }
    for (const step of stepsForEvent(obj)) push(step);
  };
}

/**
 * Reconstruct a trajectory from the full `claude -p --output-format stream-json`
 * stdout. Non-JSON lines (and irrelevant system/hook events) are ignored.
 */
export function parseClaudeStreamJson(stdout: string): ClaudeStreamTrajectory {
  const steps: TrajectoryStep[] = [];
  let finalOutput = "";
  const push = (step: Omit<TrajectoryStep, "index">): void => {
    steps.push({ index: steps.length, ...step });
  };
  for (const line of stdout.split("\n")) {
    const obj = parseStreamJsonLine(line);
    if (obj === undefined) continue;
    if (asString(obj.type) === "result") {
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
  return { steps, finalOutput };
}

/**
 * Map a panel candidate's model id to a model id the local `claude` CLI accepts.
 * Panel configs may carry placeholder/full provider ids (e.g. "claude-opus-4-8")
 * that the CLI does not recognize, so we resolve to the CLI's stable family
 * aliases ("opus"/"sonnet"/"haiku"/"fable"), which select the latest model in
 * that family. Unrecognized ids pass through unchanged (the CLI validates them).
 */
export function resolveClaudeCliModel(model: string): string {
  const normalized = model.toLowerCase();
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("fable")) return "fable";
  return model;
}
