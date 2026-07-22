/**
 * Acceptance tests for the single SSE codec (WS5.1).
 *
 * These tests define the contract for `SseDecoder` (incremental, spec-compliant
 * server-sent-event parsing) and `ChatStreamAssembler` (OpenAI-chat delta
 * assembly done once, correctly). Every hand-rolled `data:`-line parser in the
 * gateway migrates onto these two classes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ChatStreamAssembler } from "../sse/chat-assembler.js";
import { SseDecoder, SseParseError } from "../sse/parse.js";

function events(decoder: SseDecoder, ...chunks: Array<string | Uint8Array>) {
  const out = [];
  for (const chunk of chunks) out.push(...decoder.feed(chunk));
  return out;
}

// ---- SseDecoder ----

test("decodes a simple data event", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(events(decoder, 'data: {"a":1}\n\n'), [{ data: '{"a":1}' }]);
});

test("joins multi-line data: fields with newlines per the SSE spec", () => {
  // One event, two data lines -> payload is the lines joined by "\n". The old
  // per-line parsers would misread this as two separate JSON documents.
  const decoder = new SseDecoder();
  const got = events(decoder, 'data: {"content":\ndata: "hi"}\n\n');
  assert.deepEqual(got, [{ data: '{"content":\n"hi"}' }]);
});

test("carries event: and id: fields", () => {
  const decoder = new SseDecoder();
  const got = events(decoder, "event: message_start\nid: 7\ndata: {}\n\n");
  assert.deepEqual(got, [{ event: "message_start", id: "7", data: "{}" }]);
});

test("ignores comment lines and unknown fields", () => {
  const decoder = new SseDecoder();
  const got = events(decoder, ": keepalive\nretry: 100\ndata: x\n\n: another\n\n");
  assert.deepEqual(got, [{ data: "x" }]);
});

test("handles events split at arbitrary byte boundaries, including inside a UTF-8 rune", () => {
  const decoder = new SseDecoder();
  const bytes = new TextEncoder().encode('data: {"t":"héllo"}\n\ndata: [DONE]\n\n');
  const collected = [];
  // Feed one byte at a time: no chunking may ever split an event or corrupt a rune.
  for (const byte of bytes) collected.push(...decoder.feed(new Uint8Array([byte])));
  assert.deepEqual(collected, [{ data: '{"t":"héllo"}' }, { data: "[DONE]" }]);
});

test("accepts CRLF line endings", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(events(decoder, "data: a\r\n\r\ndata: b\r\n\r\n"), [{ data: "a" }, { data: "b" }]);
});

test("data: without a space after the colon is accepted", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(events(decoder, "data:tight\n\n"), [{ data: "tight" }]);
});

test("flush on a clean boundary returns nothing", () => {
  const decoder = new SseDecoder();
  decoder.feed("data: done\n\n");
  assert.deepEqual(decoder.flush(), []);
});

test("flush surfaces a trailing partial event as SseParseError, not silence", () => {
  const decoder = new SseDecoder();
  decoder.feed('data: {"complete":true}\n\ndata: {"cut-off-mid');
  assert.throws(() => decoder.flush(), SseParseError);
});

test("large events arrive intact across many feeds", () => {
  const decoder = new SseDecoder();
  const payload = "x".repeat(100_000);
  const wire = `data: ${payload}\n\n`;
  const collected = [];
  for (let i = 0; i < wire.length; i += 1_000) collected.push(...decoder.feed(wire.slice(i, i + 1_000)));
  assert.equal(collected.length, 1);
  assert.equal(collected[0]?.data, payload);
});

// ---- ChatStreamAssembler ----

function feedAssembler(assembler: ChatStreamAssembler, ...payloads: string[]): void {
  for (const data of payloads) assembler.push({ data });
}

function chunk(delta: Record<string, unknown>, finish?: string | null): string {
  return JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
}

test("assembles content and reasoning deltas in order", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(
    assembler,
    chunk({ content: "Hel" }),
    chunk({ reasoning: "thinking…" }),
    chunk({ content: "lo" }),
    chunk({}, "stop"),
    "[DONE]"
  );
  const turn = assembler.result();
  assert.equal(turn.content, "Hello");
  assert.equal(turn.reasoning, "thinking…");
  assert.equal(turn.finishReason, "stop");
  assert.equal(assembler.truncated, false);
});

test("merges fragmented tool-call arguments across chunks by index", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(
    assembler,
    chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"pa' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }),
    chunk({}, "tool_calls"),
    "[DONE]"
  );
  const turn = assembler.result();
  assert.equal(turn.toolCalls.length, 1);
  assert.deepEqual(turn.toolCalls[0], { id: "call_a", name: "read", arguments: '{"path":"a.txt"}' });
  assert.equal(turn.finishReason, "tool_calls");
});

test("keeps parallel tool calls separate when interleaved by index", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(
    assembler,
    chunk({ tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: '{"a"' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", function: { name: "write", arguments: '{"b"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: ":2}" } }] }),
    chunk({}, "tool_calls"),
    "[DONE]"
  );
  const turn = assembler.result();
  assert.deepEqual(turn.toolCalls, [
    { id: "call_a", name: "read", arguments: '{"a":1}' },
    { id: "call_b", name: "write", arguments: '{"b":2}' }
  ]);
});

test("parallel calls without index stay separate via id fallback", () => {
  // Some upstreams (Anthropic/Responses translations) omit `index`. Two calls
  // with distinct ids must not merge into one concatenated-arguments call.
  const assembler = new ChatStreamAssembler();
  feedAssembler(
    assembler,
    chunk({ tool_calls: [{ id: "call_a", function: { name: "read", arguments: '{"a":1}' } }] }),
    chunk({ tool_calls: [{ id: "call_b", function: { name: "write", arguments: '{"b":2}' } }] }),
    chunk({}, "tool_calls"),
    "[DONE]"
  );
  const turn = assembler.result();
  assert.deepEqual(turn.toolCalls, [
    { id: "call_a", name: "read", arguments: '{"a":1}' },
    { id: "call_b", name: "write", arguments: '{"b":2}' }
  ]);
});

test("id-and-index-less argument fragments append to the last open call", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(
    assembler,
    chunk({ tool_calls: [{ id: "call_a", function: { name: "run", arguments: '{"cmd":' } }] }),
    chunk({ tool_calls: [{ function: { arguments: '"ls"}' } }] }),
    chunk({}, "tool_calls"),
    "[DONE]"
  );
  const turn = assembler.result();
  assert.deepEqual(turn.toolCalls, [{ id: "call_a", name: "run", arguments: '{"cmd":"ls"}' }]);
});

test("captures usage and extension metadata from any chunk", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(
    assembler,
    chunk({ content: "ok" }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
      route: { request_id: "request_1" }
    }),
    "[DONE]"
  );
  const turn = assembler.result();
  assert.deepEqual(turn.usage, { prompt_tokens: 3, completion_tokens: 5 });
  assert.deepEqual(turn.extensions.route, { request_id: "request_1" });
});

test("merges split stream usage and rejects malformed reasoning metadata", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(
    assembler,
    JSON.stringify({ choices: [], usage: { prompt_tokens: 7 } }),
    chunk({
      reasoning_details: [
        { type: "attacker_block", index: 0, phase: "start", data: "leak" },
        { type: "redacted_thinking", index: 1, phase: "block", data: 42 }
      ]
    }),
    JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 3 }
    })
  );
  const turn = assembler.result();
  assert.deepEqual(turn.reasoningDetails, []);
  assert.deepEqual(turn.usage, {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10
  });
});

test("a stream that ends without finish_reason is truncated, not a clean stop", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(assembler, chunk({ content: "partial answ" }));
  // No finish_reason chunk, no [DONE]: the caller sees truncation.
  assert.equal(assembler.truncated, true);
  const turn = assembler.result();
  assert.equal(turn.content, "partial answ");
  assert.equal(turn.finishReason, undefined);
});

test("[DONE] without a prior finish_reason still counts as truncated", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(assembler, chunk({ content: "answer" }), "[DONE]");
  assert.equal(assembler.truncated, true);
});

test("finish_reason followed by [DONE] is a clean stop", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(assembler, chunk({ content: "answer" }), chunk({}, "stop"), "[DONE]");
  assert.equal(assembler.truncated, false);
});

test("malformed JSON surfaces as SseParseError instead of being swallowed", () => {
  const assembler = new ChatStreamAssembler();
  assert.throws(() => assembler.push({ data: '{"choices": [ oops' }), SseParseError);
});

test("empty-data keepalive events are ignored", () => {
  const assembler = new ChatStreamAssembler();
  feedAssembler(assembler, "", chunk({ content: "hi" }), chunk({}, "stop"), "[DONE]");
  assert.equal(assembler.result().content, "hi");
});
