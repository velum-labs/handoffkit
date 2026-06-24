import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCursorStreamJson } from "../stream-trajectory.js";

function line(value: unknown): string {
  return JSON.stringify(value);
}

test("reconstructs a cursor-agent stream-json answer into an output step", () => {
  // The exact event shape cursor-agent emits for a single-turn answer.
  const stdout = [
    line({ type: "system", subtype: "init", apiKeySource: "login", model: "Sonnet 4" }),
    line({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "capital of France?" }] }
    }),
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "The capital of France is Paris." }] }
    }),
    line({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "The capital of France is Paris."
    })
  ].join("\n");

  const { steps, finalOutput, sawResult, isError } = parseCursorStreamJson(stdout);
  assert.equal(sawResult, true);
  assert.equal(isError, false);
  assert.equal(finalOutput, "The capital of France is Paris.");
  assert.deepEqual(
    steps.map((step) => step.type),
    ["output"]
  );
  assert.equal(steps[0]?.text, "The capital of France is Paris.");
});

test("reconstructs a cursor-agent tool loop (tool_call + tool_result)", () => {
  const stdout = [
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "read_file", arguments: { path: "a.js" } }]
      }
    }),
    line({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "file body" }] }
    }),
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] }
    }),
    line({ type: "result", subtype: "success", is_error: false, result: "Done." })
  ].join("\n");

  const { steps, finalOutput } = parseCursorStreamJson(stdout);
  assert.deepEqual(
    steps.map((step) => step.type),
    ["tool_call", "observation", "output"]
  );
  assert.equal(steps[0]?.tool_name, "read_file");
  assert.equal(steps[1]?.tool_call_id, "c1");
  assert.equal(finalOutput, "Done.");
});

test("flags an errored cursor result", () => {
  const stdout = [
    line({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "trying" }] }
    }),
    line({ type: "result", subtype: "error", is_error: true, result: "model call failed" })
  ].join("\n");

  const { sawResult, isError } = parseCursorStreamJson(stdout);
  assert.equal(sawResult, true);
  assert.equal(isError, true);
});

test("falls back to the last assistant output when no result event is present", () => {
  const stdout = line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "partial" }] }
  });
  const { finalOutput, sawResult, steps } = parseCursorStreamJson(stdout);
  assert.equal(sawResult, false);
  assert.equal(finalOutput, "partial");
  assert.equal(steps.length, 1);
});

test("empty stdout reconstructs to an empty trajectory", () => {
  assert.deepEqual(parseCursorStreamJson(""), {
    steps: [],
    finalOutput: "",
    sawResult: false,
    isError: false
  });
});
