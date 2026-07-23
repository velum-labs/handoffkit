import assert from "node:assert/strict";
import { test } from "node:test";

import { chatToAnthropicMessage, openAiSseToAnthropic } from "@velum-labs/routekit-gateway";
import { chatToResponses, openAiSseToResponses } from "@velum-labs/routekit-gateway";
import { createTrajectoryCapture } from "../trajectory-capture.js";
import type { GatewayDialect } from "@velum-labs/routekit-gateway";

/**
 * The upstream model's own reasoning (local MLX `reasoning`, vLLM-style
 * `reasoning_content` on messages) flowing through the translators: token
 * deltas accumulate into ONE summary part (unlike narration beats, which are
 * one part each), and a reasoning-only turn must never assemble into an empty
 * response — that is the "empty turn, codex retries" failure.
 */

function sseStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
}

function chatChunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

function completedResponse(text: string): {
  output: Array<{ type: string; summary?: Array<{ text: string }>; content?: Array<{ text: string }> }>;
} {
  const completed = text.slice(text.indexOf("event: response.completed"));
  return (
    JSON.parse(completed.slice(completed.indexOf("data: ") + 6, completed.indexOf("\n\n"))) as {
      response: { output: Array<{ type: string; summary?: Array<{ text: string }> }> };
    }
  ).response;
}

// ---- Responses translator: token-delta reasoning ----

test("openAiSseToResponses accumulates reasoning token deltas into one summary part", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning: "Let me" }),
    chatChunk({ reasoning: " think." }),
    chatChunk({ content: "the answer" }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToResponses(upstream, "local"));

  // One part for the whole token stream: a single added/done pair, two deltas.
  assert.equal(text.match(/event: response\.reasoning_summary_part\.added/g)?.length, 1);
  assert.equal(text.match(/event: response\.reasoning_summary_part\.done/g)?.length, 1);
  assert.equal(text.match(/event: response\.reasoning_summary_text\.delta/g)?.length, 2);
  assert.match(text, /"text":"Let me think\."/);

  // Reasoning closes strictly before the answer text begins.
  const partDone = text.indexOf("response.reasoning_summary_part.done");
  const firstText = text.indexOf("response.output_text.delta");
  assert.ok(partDone >= 0 && firstText >= 0 && partDone < firstText);

  const response = completedResponse(text);
  assert.equal(response.output[0]?.type, "reasoning");
  assert.equal(response.output[0]?.summary?.[0]?.text, "Let me think.");
  assert.equal(response.output[1]?.type, "message");
});

test("openAiSseToResponses: a reasoning-only stream still completes with output", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning: "thinking, thinking..." }),
    chatChunk({}, "length"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToResponses(upstream, "local"));
  const response = completedResponse(text);
  assert.equal(response.output.length, 1, "reasoning-only turn must not assemble as output: []");
  assert.equal(response.output[0]?.type, "reasoning");
  assert.equal(response.output[0]?.summary?.[0]?.text, "thinking, thinking...");
});

test("openAiSseToResponses closes the token part before a tool call", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning: "I should run the tool." }),
    chatChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "run", arguments: "{}" } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToResponses(upstream, "local"));
  const partDone = text.indexOf("response.reasoning_summary_part.done");
  const toolAdded = text.indexOf('"type":"function_call"');
  assert.ok(partDone >= 0 && toolAdded >= 0 && partDone < toolAdded);
  const response = completedResponse(text);
  assert.deepEqual(
    response.output.map((item) => item.type),
    ["reasoning", "function_call"]
  );
});

test("openAiSseToResponses keeps narration beats and token deltas in separate parts", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning: "token thinking" }),
    chatChunk({ reasoning_content: "**A narration beat**\n\n" }),
    chatChunk({ content: "answer" }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToResponses(upstream, "local"));
  const response = completedResponse(text);
  assert.equal(response.output[0]?.type, "reasoning");
  assert.deepEqual(
    response.output[0]?.summary?.map((part) => part.text),
    ["token thinking", "**A narration beat**\n\n"]
  );
});

test("chatToResponses maps non-stream reasoning to a reasoning item ahead of the message", () => {
  const withBoth = chatToResponses(
    { choices: [{ message: { content: "the answer", reasoning: "thought first" } }] },
    "local"
  ) as { output: Array<{ type: string; summary?: Array<{ text: string }> }> };
  assert.deepEqual(
    withBoth.output.map((item) => item.type),
    ["reasoning", "message"]
  );
  assert.equal(withBoth.output[0]?.summary?.[0]?.text, "thought first");

  // vLLM-style field spelling maps the same way.
  const vllm = chatToResponses(
    { choices: [{ message: { content: "answer", reasoning_content: "vllm thought" } }] },
    "local"
  ) as { output: Array<{ type: string; summary?: Array<{ text: string }> }> };
  assert.equal(vllm.output[0]?.summary?.[0]?.text, "vllm thought");

  // Reasoning-only (e.g. the model hit its token cap mid-think): never empty.
  const reasoningOnly = chatToResponses(
    { choices: [{ message: { content: null, reasoning: "ran out of budget" } }] },
    "local"
  ) as { output: Array<{ type: string }> };
  assert.equal(reasoningOnly.output.length, 1);
  assert.equal(reasoningOnly.output[0]?.type, "reasoning");
});

// ---- Anthropic translator parity ----

test("openAiSseToAnthropic maps reasoning token deltas onto the thinking block verbatim", async () => {
  const upstream = sseStream(
    chatChunk({ reasoning: "**raw** tokens" }),
    chatChunk({ content: "answer" }),
    chatChunk({}, "stop"),
    "data: [DONE]\n\n"
  );
  const text = await streamText(openAiSseToAnthropic(upstream, "local"));
  assert.match(text, /"type":"thinking"/);
  // Token deltas are plain text already: no bold-marker stripping.
  assert.match(text, /"thinking":"\*\*raw\*\* tokens"/);
  const thinkingStop = text.indexOf('"type":"content_block_stop"');
  const textBlock = text.indexOf('"type":"text_delta"');
  assert.ok(thinkingStop >= 0 && textBlock >= 0 && thinkingStop < textBlock);
});

test("chatToAnthropicMessage maps non-stream reasoning to a thinking block first", () => {
  const message = chatToAnthropicMessage(
    { choices: [{ message: { content: "answer", reasoning: "thought" } }] },
    "local"
  ) as { content: Array<{ type: string; thinking?: string }> };
  assert.deepEqual(
    message.content.map((block) => block.type),
    ["thinking", "text"]
  );
  assert.equal(message.content[0]?.thinking, "thought");
});

// ---- Trajectory capture ----

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

test("trajectory capture emits reasoning steps from chat reasoning fields", () => {
  const { steps } = feed(
    "openai-chat",
    {
      messages: [
        { role: "user", content: "task" },
        {
          role: "assistant",
          content: null,
          reasoning: "I need to look at the file.",
          tool_calls: [{ id: "t1", function: { name: "read", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "t1", content: "data" }
      ]
    },
    { choices: [{ message: { role: "assistant", content: "Done." } }] }
  );
  assert.deepEqual(
    steps.map((step) => step.type),
    ["reasoning", "tool_call", "observation", "output"]
  );
  assert.equal(steps[0]?.text, "I need to look at the file.");
});

test("trajectory capture surfaces the final turn's reasoning from the response body", () => {
  // A single-step run: the request has no echoed reasoning items yet; the
  // reasoning lives only in the response and must still become a step.
  const { steps, finalOutput } = feed(
    "openai-responses",
    { input: [{ type: "message", role: "user", content: "task" }] },
    {
      output: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "think first" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }
      ]
    }
  );
  assert.deepEqual(
    steps.map((step) => step.type),
    ["reasoning", "output"]
  );
  assert.equal(steps[0]?.text, "think first");
  assert.equal(finalOutput, "OK");
});

test("trajectory capture emits reasoning steps from Responses reasoning items", () => {
  const { steps } = feed(
    "openai-responses",
    {
      input: [
        { type: "message", role: "user", content: "task" },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "First I think, " },
            { type: "summary_text", text: "then I act." }
          ],
          content: null
        },
        { type: "function_call", name: "run", call_id: "c1", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" }
      ]
    },
    { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }] }
  );
  assert.deepEqual(
    steps.map((step) => step.type),
    ["reasoning", "tool_call", "observation", "output"]
  );
  assert.equal(steps[0]?.text, "First I think, then I act.");
});
