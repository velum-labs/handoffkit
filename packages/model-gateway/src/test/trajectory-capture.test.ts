import assert from "node:assert/strict";
import { test } from "node:test";

import { createTrajectoryCapture } from "../trajectory-capture.js";
import type { GatewayDialect } from "../provenance.js";

function feed(dialect: GatewayDialect, requestBody: unknown, responseBody: unknown) {
  const capture = createTrajectoryCapture();
  capture.sink.onModelCallRaw?.(
    {
      callId: "c1",
      dialect,
      requestedModel: "m",
      model: "m",
      stream: false,
      requestBody,
      startedAt: new Date().toISOString()
    },
    { statusCode: 200, responseBody: Buffer.from(JSON.stringify(responseBody)), durationMs: 1 }
  );
  return capture.reconstruct();
}

test("reconstructs an openai-chat tool loop into steps", () => {
  const { steps, finalOutput } = feed(
    "openai-chat",
    {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "fix the bug" },
        {
          role: "assistant",
          content: "reading the file",
          tool_calls: [
            { id: "t1", function: { name: "read_file", arguments: '{"path":"a.js"}' } }
          ]
        },
        { role: "tool", tool_call_id: "t1", content: "file contents" }
      ]
    },
    { choices: [{ message: { role: "assistant", content: "Fixed it." } }] }
  );
  assert.deepEqual(
    steps.map((step) => step.type),
    ["reasoning", "tool_call", "observation", "output"]
  );
  assert.equal(steps[1]?.tool_name, "read_file");
  assert.equal(steps[2]?.tool_call_id, "t1");
  assert.equal(finalOutput, "Fixed it.");
});

test("reconstructs an openai-responses tool loop into steps", () => {
  const { steps, finalOutput } = feed(
    "openai-responses",
    {
      input: [
        { type: "message", role: "user", content: "fix it" },
        { type: "function_call", call_id: "c1", name: "run", arguments: '{"cmd":"test"}' },
        { type: "function_call_output", call_id: "c1", output: "exit_code=0" }
      ]
    },
    { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }] }
  );
  assert.deepEqual(
    steps.map((step) => step.type),
    ["tool_call", "observation", "output"]
  );
  assert.equal(steps[0]?.tool_name, "run");
  assert.equal(finalOutput, "Done.");
});

test("reconstructs an anthropic-messages tool loop into steps", () => {
  const { steps, finalOutput } = feed(
    "anthropic-messages",
    {
      messages: [
        { role: "user", content: [{ type: "text", text: "fix it" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read the file" },
            { type: "tool_use", id: "u1", name: "read_file", input: { path: "a.js" } }
          ]
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "contents" }] }
      ]
    },
    { content: [{ type: "text", text: "Fixed it." }] }
  );
  assert.deepEqual(
    steps.map((step) => step.type),
    ["reasoning", "tool_call", "observation", "output"]
  );
  assert.equal(steps[1]?.tool_name, "read_file");
  assert.equal(steps[2]?.tool_call_id, "u1");
  assert.equal(finalOutput, "Fixed it.");
});

test("empty captures reconstruct to an empty trajectory", () => {
  const capture = createTrajectoryCapture();
  assert.deepEqual(capture.reconstruct(), { steps: [], finalOutput: "" });
});
