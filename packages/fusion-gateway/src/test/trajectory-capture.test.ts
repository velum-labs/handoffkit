import assert from "node:assert/strict";
import { test } from "node:test";

import { createTrajectoryCapture } from "../trajectory-capture.js";
import type { GatewayDialect } from "@routekit/gateway";

function feed(dialect: GatewayDialect, requestBody: unknown, responseBody: unknown) {
  return feedRaw(dialect, requestBody, JSON.stringify(responseBody));
}

function feedRaw(dialect: GatewayDialect, requestBody: unknown, responseBody: string, stream = false) {
  const capture = createTrajectoryCapture();
  capture.sink.onModelCallRaw?.(
    {
      callId: "c1",
      dialect,
      requestedModel: "m",
      model: "m",
      stream,
      requestBody,
      startedAt: new Date().toISOString()
    },
    { statusCode: 200, responseBody: Buffer.from(responseBody), durationMs: 1 }
  );
  return capture.reconstruct();
}

/** Build an OpenAI Responses SSE event stream body. */
function responsesSse(events: Array<Record<string, unknown>>): string {
  return (
    events.map((event) => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

test("ignores embedding calls when reconstructing chat trajectories", () => {
  const { steps, finalOutput } = feed(
    "openai-embeddings",
    { input: "not a chat prompt" },
    { data: [{ embedding: [0.1, 0.2] }] }
  );
  assert.deepEqual(steps, []);
  assert.equal(finalOutput, "");
});

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

test("reconstructs a streamed (SSE) openai-responses answer with no prior steps", () => {
  // What codex sends/receives for a single-turn answer: the request input is just
  // the user message (no steps), and the response is a streamed event sequence
  // (`stream: true`), not a single JSON object. The final answer must come from
  // the streamed events so the candidate gets a non-empty trajectory.
  const body = responsesSse([
    { type: "response.created", response: { status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", status: "in_progress", role: "assistant", content: [] }
    },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello " },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "world." },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello world.", annotations: [] }]
      }
    },
    {
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hello world.", annotations: [] }]
          }
        ]
      }
    }
  ]);
  const { steps, finalOutput } = feedRaw(
    "openai-responses",
    { input: [{ type: "message", role: "user", content: "say hello" }] },
    body,
    true
  );
  assert.equal(finalOutput, "Hello world.");
  assert.deepEqual(
    steps.map((step) => step.type),
    ["output"]
  );
  assert.equal(steps[0]?.text, "Hello world.");
});

test("reconstructs a streamed openai-responses answer from deltas alone", () => {
  const body = responsesSse([
    { type: "response.output_text.delta", delta: "partial " },
    { type: "response.output_text.delta", delta: "answer" }
  ]);
  const { finalOutput } = feedRaw("openai-responses", { input: "say hello" }, body, true);
  assert.equal(finalOutput, "partial answer");
});

test("reconstructs a streamed openai-chat answer from chunk deltas", () => {
  const body =
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Fixed " } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "it." } }] })}\n\n` +
    "data: [DONE]\n\n";
  const { finalOutput, steps } = feedRaw(
    "openai-chat",
    { messages: [{ role: "user", content: "fix it" }] },
    body,
    true
  );
  assert.equal(finalOutput, "Fixed it.");
  assert.equal(steps.at(-1)?.text, "Fixed it.");
});

test("empty captures reconstruct to an empty trajectory", () => {
  const capture = createTrajectoryCapture();
  assert.deepEqual(capture.reconstruct(), { steps: [], finalOutput: "" });
});
