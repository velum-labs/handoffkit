/**
 * Reconstruct a native agent trajectory from the `claude` CLI's
 * `--output-format stream-json` stdout.
 *
 * Unlike codex (whose trajectory comes from gateway wire capture), the headless
 * `claude -p` CLI's trajectory is reconstructed by parsing its structured
 * stream-json events: Anthropic-family panel members run against the native
 * Anthropic backend, and other members run through a per-candidate translation
 * gateway under a `claude-` alias (see `harness.ts`), but in both cases the
 * stream-json stdout is the trajectory source.
 *
 * The stream emits one JSON object per line. The relevant events are:
 *   - `{type:"assistant", message:{content:[...]}}` whose content blocks are
 *     `thinking` (reasoning), `text` (output), and `tool_use` (tool_call).
 *   - `{type:"user", message:{content:[{type:"tool_result", ...}]}}`
 *     (observation), which carry the tool result for a prior `tool_use`.
 *   - `{type:"result", subtype, result, is_error}` — the terminal summary whose
 *     `result` is the final answer.
 *   - `{type:"system", subtype:"compact_boundary", compact_metadata:{...}}` —
 *     the CLI compacted its context mid-run. Recorded as a reasoning-step
 *     marker so the judge can see the agent itself lost sight of earlier steps
 *     (the reconstructed trajectory still has them: the parser sees the full
 *     stream).
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

export type ClaudeStreamTrajectory = {
  steps: TrajectoryStep[];
  finalOutput: string;
};

export type ClaudeStreamStepEmitter = (line: string) => void;

/**
 * A compaction boundary as a reasoning-step marker. The wire trajectory item
 * union has no compaction type, and an output step would pollute the
 * final-output fallback; a reasoning step rides the existing shapes while
 * telling the judge the agent's own context no longer holds the earlier steps.
 */
function compactionStep(event: Record<string, unknown>): Omit<TrajectoryStep, "index"> {
  const meta = asObject(event.compact_metadata);
  const trigger = asString(meta?.trigger) ?? "auto";
  const preTokens = typeof meta?.pre_tokens === "number" ? meta.pre_tokens : undefined;
  const tokens = preTokens !== undefined ? `; ~${preTokens} tokens before compaction` : "";
  return {
    type: "reasoning",
    text:
      `[context compacted (${trigger}${tokens}): the agent summarized and dropped its earlier ` +
      "context here; steps above were no longer visible to it after this point]"
  };
}

/** Parse a single stream-json event into zero or more (un-indexed) steps. */
function stepsForEvent(event: Record<string, unknown>): Omit<TrajectoryStep, "index">[] {
  const out: Omit<TrajectoryStep, "index">[] = [];
  const type = asString(event.type);
  if (type === "system" && asString(event.subtype) === "compact_boundary") {
    out.push(compactionStep(event));
    return out;
  }
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
      } else if (blockType === "tool_use") {
        out.push({
          type: "tool_call",
          ...(asString(b.name) !== undefined ? { tool_name: asString(b.name) } : {}),
          ...(asString(b.id) !== undefined ? { tool_call_id: asString(b.id) } : {}),
          tool_input: truncateStreamJsonText(stringifyStreamJsonValue(b.input ?? {}), STREAM_JSON_MAX_TOOL_INPUT)
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

/** Create an incremental parser for `claude --output-format stream-json` lines. */
export function createClaudeStreamStepEmitter(onStep: (step: TrajectoryStep) => void): ClaudeStreamStepEmitter {
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
 * Reconstruct a trajectory from the full `claude -p --output-format stream-json`
 * stdout. Non-JSON lines (and irrelevant system/hook events) are ignored.
 */
export function parseClaudeStreamJson(stdout: string): ClaudeStreamTrajectory {
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
  return { steps: parsed.steps, finalOutput: parsed.finalOutput };
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
