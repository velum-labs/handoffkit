import assert from "node:assert/strict";
import { test } from "node:test";

import type { TrajectoryStep } from "@fusionkit/ensemble";

import { createClaudeStreamStepEmitter, parseClaudeStreamJson, resolveClaudeCliModel } from "../stream-trajectory.js";

function line(value: unknown): string {
  return JSON.stringify(value);
}

test("reconstructs a claude stream-json tool loop into steps", () => {
  const stdout = [
    line({ type: "system", subtype: "init", model: "claude-sonnet-4-5" }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "I should read the file" }]
      }
    }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I'll read the README." }]
      }
    }),
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: "a.js" } }]
      }
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "u1", content: "file contents" }]
      }
    }),
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Fixed it." }] }
    }),
    line({ type: "result", subtype: "success", is_error: false, result: "Fixed it." })
  ].join("\n");

  const { steps, finalOutput } = parseClaudeStreamJson(stdout);
  assert.deepEqual(
    steps.map((step) => step.type),
    ["reasoning", "output", "tool_call", "observation", "output"]
  );
  assert.equal(steps[2]?.tool_name, "Read");
  assert.equal(steps[2]?.tool_call_id, "u1");
  assert.equal(steps[3]?.tool_call_id, "u1");
  assert.equal(finalOutput, "Fixed it.");
  // Indices are sequential.
  assert.deepEqual(
    steps.map((step) => step.index),
    [0, 1, 2, 3, 4]
  );
});

test("marks failed tool results as errors and parses array tool_result content", () => {
  const stdout = [
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t9", name: "Bash", input: { command: "npm test" } }]
      }
    }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t9",
            is_error: true,
            content: [{ type: "text", text: "exit code 1" }]
          }
        ]
      }
    }),
    line({ type: "result", subtype: "success", result: "Done." })
  ].join("\n");

  const { steps } = parseClaudeStreamJson(stdout);
  const observation = steps.find((step) => step.type === "observation");
  assert.equal(observation?.text, "exit code 1");
  assert.equal(observation?.is_error, true);
});

test("appends the terminal result as a trailing output when not already last", () => {
  const stdout = [
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "u1", name: "Read", input: {} }]
      }
    }),
    line({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] }
    }),
    line({ type: "result", subtype: "success", result: "All set." })
  ].join("\n");

  const { steps, finalOutput } = parseClaudeStreamJson(stdout);
  assert.equal(finalOutput, "All set.");
  assert.equal(steps.at(-1)?.type, "output");
  assert.equal(steps.at(-1)?.text, "All set.");
});

test("incremental claude stream-json emitter matches final parser step ordering", () => {
  const lines = [
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "u1", name: "Read", input: { file_path: "a.js" } }]
      }
    }),
    line({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] }
    }),
    line({ type: "result", subtype: "success", result: "All set." })
  ];
  const live: TrajectoryStep[] = [];
  const emit = createClaudeStreamStepEmitter((step) => live.push(step));
  for (const item of lines) emit(item);

  const final = parseClaudeStreamJson(lines.join("\n"));
  assert.deepEqual(live, final.steps);
});

test("falls back to the last assistant output when no result event is present", () => {
  const stdout = [
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "partial answer" }] }
    })
  ].join("\n");

  const { steps, finalOutput } = parseClaudeStreamJson(stdout);
  assert.equal(finalOutput, "partial answer");
  assert.equal(steps.length, 1);
});

test("ignores non-JSON lines and irrelevant events", () => {
  const stdout = [
    "Warning: no stdin data received in 3s, proceeding without it.",
    line({ type: "system", subtype: "hook_started", hook_name: "SessionStart" }),
    line({ type: "system", subtype: "thinking_tokens", estimated_tokens: 4 }),
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] }
    }),
    "",
    line({ type: "result", subtype: "success", result: "hi" })
  ].join("\n");

  const { steps, finalOutput } = parseClaudeStreamJson(stdout);
  assert.deepEqual(
    steps.map((step) => step.type),
    ["output"]
  );
  assert.equal(finalOutput, "hi");
});

test("empty stdout reconstructs to an empty trajectory", () => {
  assert.deepEqual(parseClaudeStreamJson(""), { steps: [], finalOutput: "" });
});

test("resolveClaudeCliModel maps placeholder/full ids to CLI family aliases", () => {
  assert.equal(resolveClaudeCliModel("claude-opus-4-8"), "opus");
  assert.equal(resolveClaudeCliModel("claude-sonnet-4-5-20250929"), "sonnet");
  assert.equal(resolveClaudeCliModel("claude-haiku-4-5"), "haiku");
  assert.equal(resolveClaudeCliModel("claude-fable-5"), "fable");
  // Unrecognized ids pass through unchanged for the CLI to validate.
  assert.equal(resolveClaudeCliModel("gpt-5.5"), "gpt-5.5");
});
