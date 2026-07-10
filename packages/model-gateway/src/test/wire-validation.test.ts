import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateAnthropicRequest,
  validateChatRequest,
  validateCountTokensRequest,
  validateResponsesRequest
} from "../adapters/validate.js";

/**
 * Structural door validation: hostile-input fuzzing found malformed bodies
 * reaching deep code and surfacing as 502s carrying raw TypeError text or
 * internal fusion jargon. These tests pin the contract: caller errors are
 * 400s in the door's native envelope, and well-formed-but-unusual bodies
 * (that a real provider would accept) still pass.
 */

type OpenAiEnvelope = { error: { message: string; type: string } };
type AnthropicEnvelope = { type: string; error: { type: string; message: string } };

const chatOk = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("chat door rejects structurally hostile bodies with an OpenAI 400 envelope", () => {
  const hostile: Array<[string, unknown]> = [
    ["non-object body", "hello"],
    ["array body", [1, 2, 3]],
    ["empty body", {}],
    ["null messages", { model: "m", messages: null }],
    ["string messages", { model: "m", messages: "hi" }],
    ["empty messages", { model: "m", messages: [] }],
    ["message without role", { model: "m", messages: [{ content: "x" }] }],
    ["numeric content", { model: "m", messages: [{ role: "user", content: 42 }] }],
    ["tool message without call id", { model: "m", messages: [{ role: "tool", content: "result" }] }],
    ["string tool_calls", { model: "m", messages: [{ role: "assistant", content: null, tool_calls: "read" }] }],
    ["array model", { model: ["m"], messages: chatOk.messages }],
    ["object model", { model: { id: "m" }, messages: chatOk.messages }],
    ["string stream", { ...chatOk, stream: "yes" }],
    ["string tools", { ...chatOk, tools: "read" }]
  ];
  for (const [name, body] of hostile) {
    const rejection = validateChatRequest(body);
    assert.notEqual(rejection, undefined, `${name} must be rejected`);
    assert.equal(rejection?.status, 400, name);
    const envelope = rejection?.body as OpenAiEnvelope;
    assert.equal(envelope.error.type, "invalid_request_error", name);
    assert.ok(envelope.error.message.length > 0, name);
  }
});

test("chat door accepts every shape a real provider accepts", () => {
  const fine: Array<[string, unknown]> = [
    ["plain turn", chatOk],
    ["no model (default injection)", { messages: chatOk.messages }],
    ["null content", { model: "m", messages: [{ role: "user", content: null }] }],
    ["content parts", { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }],
    ["unknown role string", { model: "m", messages: [{ role: "developer", content: "x" }] }],
    ["stream null", { ...chatOk, stream: null }],
    ["stream true", { ...chatOk, stream: true }],
    ["tools array", { ...chatOk, tools: [] }],
    ["extra unknown fields", { ...chatOk, fusion: { mode: "panel" }, metadata: { a: 1 } }]
  ];
  for (const [name, body] of fine) {
    assert.equal(validateChatRequest(body), undefined, `${name} must pass`);
  }
});

test("anthropic door rejects hostile bodies with the Anthropic 400 envelope", () => {
  const hostile: Array<[string, unknown]> = [
    ["empty body", {}],
    ["null messages", { model: "c", max_tokens: 10, messages: null }],
    ["empty messages", { model: "c", max_tokens: 10, messages: [] }],
    ["array model", { model: ["c"], max_tokens: 10, messages: [{ role: "user", content: "x" }] }],
    ["string max_tokens", { model: "c", max_tokens: "lots", messages: [{ role: "user", content: "x" }] }],
    ["numeric system", { model: "c", max_tokens: 10, system: 42, messages: [{ role: "user", content: "x" }] }],
    ["string tools", { model: "c", max_tokens: 10, tools: "hammer", messages: [{ role: "user", content: "x" }] }]
  ];
  for (const [name, body] of hostile) {
    const rejection = validateAnthropicRequest(body);
    assert.equal(rejection?.status, 400, name);
    const envelope = rejection?.body as AnthropicEnvelope;
    assert.equal(envelope.type, "error", name);
    assert.equal(envelope.error.type, "invalid_request_error", name);
  }
});

test("anthropic door accepts real Claude Code shapes", () => {
  const fine: Array<[string, unknown]> = [
    ["plain", { model: "c", max_tokens: 100, messages: [{ role: "user", content: "x" }] }],
    ["block content + system blocks", {
      model: "c",
      max_tokens: 100,
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }]
    }],
    ["no max_tokens (gateway is tolerant)", { model: "c", messages: [{ role: "user", content: "x" }] }],
    ["null thinking/metadata", {
      model: "c",
      max_tokens: 100,
      thinking: null,
      metadata: null,
      messages: [{ role: "user", content: "x" }]
    }]
  ];
  for (const [name, body] of fine) {
    assert.equal(validateAnthropicRequest(body), undefined, `${name} must pass`);
  }
});

test("count_tokens requires a messages array but no minimum length", () => {
  assert.equal(validateCountTokensRequest({ messages: [] }), undefined);
  assert.equal(validateCountTokensRequest({ messages: [{ role: "user", content: "x" }] }), undefined);
  assert.equal(validateCountTokensRequest({})?.status, 400);
  assert.equal(validateCountTokensRequest({ messages: "hi" })?.status, 400);
  assert.equal(validateCountTokensRequest({ messages: [42] })?.status, 400);
  assert.equal(validateCountTokensRequest({ messages: [{ content: "missing role" }] })?.status, 400);
  assert.equal(
    validateCountTokensRequest({ messages: [{ role: "assistant", content: null }] })
      ?.status,
    400
  );
  assert.equal(
    validateCountTokensRequest({ messages: [{ role: "user", content: { text: "wrong shape" } }] })
      ?.status,
    400
  );
});

test("token limits must be positive integers at every wire door", () => {
  assert.equal(validateChatRequest({ ...chatOk, max_tokens: -1 })?.status, 400);
  assert.equal(validateChatRequest({ ...chatOk, max_completion_tokens: 1.5 })?.status, 400);
  assert.equal(
    validateAnthropicRequest({
      model: "c",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 0
    })?.status,
    400
  );
  assert.equal(validateResponsesRequest({ model: "m", input: "x", max_output_tokens: -1 })?.status, 400);
});

test("responses door requires a usable input and string model", () => {
  const hostile: Array<[string, unknown]> = [
    ["empty body", {}],
    ["numeric input", { model: "m", input: 42 }],
    ["empty input array", { model: "m", input: [] }],
    ["non-object input item", { model: "m", input: ["hi"] }],
    ["object model", { model: { a: 1 }, input: "hi" }],
    ["string tools", { model: "m", input: "hi", tools: "hammer" }]
  ];
  for (const [name, body] of hostile) {
    const rejection = validateResponsesRequest(body);
    assert.equal(rejection?.status, 400, name);
    assert.equal((rejection?.body as OpenAiEnvelope).error.type, "invalid_request_error", name);
  }
  const fine: Array<[string, unknown]> = [
    ["string input", { model: "m", input: "hi" }],
    ["item input", { model: "m", input: [{ type: "message", role: "user", content: "hi" }] }],
    ["codex nulls", { model: "m", input: "hi", reasoning: null, text: null, tool_choice: null }],
    ["unknown item types (dropped downstream)", { model: "m", input: [{ type: "quantum" }] }]
  ];
  for (const [name, body] of fine) {
    assert.equal(validateResponsesRequest(body), undefined, `${name} must pass`);
  }
});
