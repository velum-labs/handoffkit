/**
 * Cross-process stack e2e across every gateway surface: coding-tool front
 * doors (OpenAI chat, Anthropic Messages + count_tokens, Codex Responses,
 * Cursor BYOK hybrid, model discovery) -> REAL Node fusion gateway -> REAL
 * Python engine (`fusionkit serve`) -> scripted provider simulator, with a
 * panel spanning every provider client family FusionKit ships (OpenAI,
 * Anthropic, Google, Codex). Nothing between the tool's HTTP request and the
 * provider wire is mocked; every wire call is asserted through the journal.
 *
 * Skipped (with the reason) where the Python toolchain is unavailable; the
 * `stack-e2e` CI job runs it with both toolchains installed.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { parseSse, simErrors, sseDone, sseText, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

/** One panel member per provider client family, plus a dedicated judge. */
const MEMBERS = [
  { id: "alpha", model: "gpt-panel-a", provider: "openai" },
  { id: "beta", model: "claude-panel-b", provider: "anthropic" },
  { id: "gamma", model: "gemini-panel-c", provider: "google" },
  { id: "delta", model: "gpt-codex-panel-d", provider: "codex" },
  { id: "judge", model: "gpt-judge", provider: "openai" }
] as const;

const CANDIDATES = {
  "gpt-panel-a": "candidate from the OpenAI-wire member",
  "claude-panel-b": "candidate from the Anthropic-wire member",
  "gemini-panel-c": "candidate from the Google-wire member",
  "gpt-codex-panel-d": "candidate from the Codex-wire member"
};

let stack: SimFusionStack;

before(async function () {
  if (SKIP !== false) return;
  stack = await startSimFusionStack({ members: [...MEMBERS], judgeId: "judge" });
});

after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

async function assertFullPanelOnTheWire(): Promise<void> {
  const journal = await stack.sim.journal();
  const dialects = new Map(journal.map((entry) => [entry.model, entry.dialect]));
  assert.equal(dialects.get("gpt-panel-a"), "openai-chat", await stack.sim.describeJournal());
  assert.equal(dialects.get("claude-panel-b"), "anthropic-messages");
  assert.equal(dialects.get("gemini-panel-c"), "google-generate");
  assert.equal(dialects.get("gpt-codex-panel-d"), "openai-responses");
  assert.equal((await stack.sim.calls({ model: "gpt-judge" })).length, 2, "judge analyzes then synthesizes");
}

// --- fused turns, one per tool-facing dialect --------------------------------

test("OpenAI chat door: fused turn fans out across all four provider dialects", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: "fused: full stack answer" });
  const response = await stack.door.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "what approach should we take?" }]
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    choices: Array<{ message: { role: string; content: string } }>;
  };
  assert.equal(body.object, "chat.completion");
  assert.match(body.choices[0]?.message.content ?? "", /fused: full stack answer/);
  await assertFullPanelOnTheWire();

  // Panel members saw the caller's message verbatim (k=1 proposal contract).
  const memberCall = (await stack.sim.calls({ model: "gpt-panel-a" }))[0];
  assert.ok(
    JSON.stringify(memberCall?.request).includes("what approach should we take?"),
    "panel member must see the caller's message verbatim"
  );
});

test("OpenAI chat door: streaming SSE through the whole stack", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: "streamed fused answer" });
  const response = await stack.door.chat({
    model: "fusion-panel",
    stream: true,
    messages: [{ role: "user", content: "stream the fused answer" }]
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames = parseSse(await response.text());
  assert.match(sseText(frames), /streamed fused answer/);
  assert.ok(sseDone(frames), "stream must terminate with [DONE]");
});

test("Anthropic Messages door: native shape + thinking block, fused end to end", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: "fused answer via anthropic door" });
  const response = await stack.door.messages({
    model: "fusion-panel",
    max_tokens: 256,
    messages: [{ role: "user", content: "answer through the anthropic dialect" }]
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    type: string;
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  assert.equal(body.type, "message");
  assert.equal(body.role, "assistant");
  // The gateway may prepend a `thinking` block (judge narration) before the
  // answer, exactly like a reasoning-enabled Claude response; find the text.
  const text = body.content.find((block) => block.type === "text")?.text ?? "";
  assert.match(text, /fused answer via anthropic door/);
});

test("Anthropic Messages door: streaming message_start..message_stop", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: "anthropic streamed fusion" });
  const response = await stack.door.messages({
    model: "fusion-panel",
    stream: true,
    max_tokens: 256,
    messages: [{ role: "user", content: "stream anthropic" }]
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames = parseSse(await response.text());
  const types = frames
    .map((frame) => (typeof frame.data === "object" && frame.data !== null ? (frame.data as { type?: string }).type : undefined))
    .filter((value): value is string => typeof value === "string");
  assert.ok(types.includes("message_start"), "must open with message_start");
  assert.ok(types.includes("message_stop"), "must close with message_stop");
  const text = frames
    .filter((frame) => typeof frame.data === "object" && frame.data !== null && (frame.data as { type?: string }).type === "content_block_delta")
    .map((frame) => (frame.data as { delta?: { text?: string } }).delta?.text ?? "")
    .join("");
  assert.match(text, /anthropic streamed fusion/);
});

test("Codex Responses door: native response shape, fused end to end", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: "fused answer via responses door" });
  const response = await stack.door.responses({
    model: "fusion-panel",
    input: [{ role: "user", content: [{ type: "input_text", text: "answer through the responses dialect" }] }]
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    output: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };
  assert.equal(body.object, "response");
  const message = body.output.find((item) => item.type === "message");
  assert.match(message?.content?.[0]?.text ?? "", /fused answer via responses door/);
});

test("Codex Responses door: streaming response.created..response.completed", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: "responses streamed fusion" });
  const response = await stack.door.responses({
    model: "fusion-panel",
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: "stream responses" }] }]
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames = parseSse(await response.text());
  const types = frames
    .map((frame) => (typeof frame.data === "object" && frame.data !== null ? (frame.data as { type?: string }).type : undefined))
    .filter((value): value is string => typeof value === "string");
  assert.ok(types.includes("response.created"), "must open with response.created");
  assert.ok(types.includes("response.output_text.delta"), "must stream output text deltas");
  assert.ok(types.includes("response.completed"), "must close with response.completed");
});

test("Cursor BYOK door: Responses-hybrid body translates and fuses", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({ candidates: CANDIDATES, answer: "fused answer via cursor door" });
  const response = await stack.door.cursorChat({
    model: "fusion-panel",
    input: [
      { type: "message", role: "developer", content: "You are a coding agent." },
      { type: "message", role: "user", content: [{ type: "input_text", text: "fix it via cursor" }] }
    ]
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.match(body.choices[0]?.message.content ?? "", /fused answer via cursor door/);
  // The hybrid body was translated before fanout: members saw the user text.
  const memberCall = (await stack.sim.calls({ model: "gpt-panel-a" }))[0];
  assert.ok(JSON.stringify(memberCall?.request).includes("fix it via cursor"));
});

// --- vendor passthrough per provider family -----------------------------------

test("vendor passthrough routes each member to its own provider dialect", { skip: SKIP }, async () => {
  await stack.sim.reset();
  const expected: Array<[string, string, string]> = [
    ["gpt-panel-a", "openai passthrough", "openai-chat"],
    ["claude-panel-b", "anthropic passthrough", "anthropic-messages"],
    ["gemini-panel-c", "google passthrough", "google-generate"],
    ["gpt-codex-panel-d", "codex passthrough", "openai-responses"]
  ];
  for (const [model, reply] of expected) await stack.sim.queue(model, [reply]);
  for (const [model, reply, dialect] of expected) {
    const response = await stack.door.chat({
      model,
      messages: [{ role: "user", content: `direct to ${model}` }]
    });
    assert.equal(response.status, 200, `${model} passthrough must succeed`);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.match(body.choices[0]?.message.content ?? "", new RegExp(reply));
    const calls = await stack.sim.calls({ model });
    assert.equal(calls.length, 1, await stack.sim.describeJournal());
    assert.equal(calls[0]?.dialect, dialect);
  }
});

// --- discovery, preflight, and edge doors ---------------------------------------

test("model discovery doors advertise the fused model and every member", { skip: SKIP }, async () => {
  const models = (await (await stack.door.models()).json()) as { data: Array<{ id: string }> };
  const ids = new Set(models.data.map((entry) => entry.id));
  assert.ok(ids.has("fusion-panel"), "fused ensemble model must be advertised");
  for (const member of MEMBERS.slice(0, 4)) {
    assert.ok(ids.has(member.model), `${member.model} must be advertised as a passthrough`);
  }

  // Claude Code's discovery probe (anthropic-version header) gets the Anthropic shape.
  const anthropicModels = (await (await stack.door.models({ anthropicShape: true })).json()) as {
    data: Array<{ id: string; type?: string }>;
  };
  assert.ok(anthropicModels.data.length > 0);

  // Claude Code's single-model validation probe echoes any advertised id.
  const single = (await (await stack.door.model("fusion-panel")).json()) as { type: string; id: string };
  assert.equal(single.type, "model");
  assert.equal(single.id, "fusion-panel");

  // Cursor probes the models list relative to its BYOK base URL.
  const cursorModels = (await (await stack.door.cursorModels()).json()) as { data: Array<{ id: string }> };
  assert.ok(cursorModels.data.some((entry) => entry.id === "fusion-panel"));
});

test("count_tokens door answers Claude Code's preflight and scales with input", { skip: SKIP }, async () => {
  const count = async (content: string): Promise<number> => {
    const response = await stack.door.countTokens({
      model: "fusion-panel",
      messages: [{ role: "user", content }]
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { input_tokens: number }).input_tokens;
  };
  const short = await count("hi");
  const long = await count("a much longer message ".repeat(50));
  assert.ok(short > 0);
  assert.ok(long > short * 5, `token estimate must scale with input (short=${short}, long=${long})`);
});

test("embeddings door states its unsupported contract instead of hanging", { skip: SKIP }, async () => {
  const response = await stack.door.embeddings({ model: "fusion-panel", input: "embed me" });
  assert.ok(response.status >= 400, "fusion gateway documents embeddings as unsupported");
  const body = (await response.json()) as { error?: { message?: string } };
  assert.match(body.error?.message ?? "", /not supported/);
});

// --- degradation ----------------------------------------------------------------

test("panel degradation: one member's provider 401 still yields a fused answer", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({
    candidates: {
      "gpt-panel-a": { error: simErrors.invalidApiKey() },
      "claude-panel-b": "the surviving candidate",
      "gemini-panel-c": "another survivor",
      "gpt-codex-panel-d": "a third survivor"
    },
    answer: "fused from the survivors"
  });
  const response = await stack.door.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "degrade gracefully" }]
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.match(body.choices[0]?.message.content ?? "", /fused from the survivors/);
  const failed = await stack.sim.calls({ model: "gpt-panel-a" });
  assert.deepEqual(failed.map((entry) => entry.status), [401], "permanent auth failure is not retried");
});
