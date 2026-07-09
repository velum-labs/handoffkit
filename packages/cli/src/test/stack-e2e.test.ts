/**
 * Cross-process stack e2e: coding-tool front doors -> REAL Node fusion
 * gateway -> REAL Python engine (`fusionkit serve`) -> scripted provider
 * simulator. Nothing between the tool's HTTP request and the provider wire is
 * mocked; the provider itself is scripted per model and every wire call is
 * asserted through the simulator's journal.
 *
 * Skipped (with the reason) where the Python toolchain is unavailable; the
 * `stack-e2e` CI job runs it with both toolchains installed.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { detectStackTooling, parseSse, simErrors, sseDone, sseText } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const tooling = detectStackTooling();
const SKIP = tooling.available ? false : `stack tooling unavailable: ${tooling.available === false ? tooling.reason : ""}`;

const JUDGE_ANALYSIS = JSON.stringify({
  consensus: ["agreement"],
  contradictions: [],
  unique_insights: [],
  coverage_gaps: [],
  likely_errors: [],
  recommended_final_structure: []
});

let stack: SimFusionStack;

before(async function () {
  if (SKIP !== false) return;
  stack = await startSimFusionStack({
    members: [
      { id: "alpha", model: "gpt-panel-a", provider: "openai" },
      { id: "beta", model: "claude-panel-b", provider: "anthropic" },
      { id: "judge", model: "gpt-judge", provider: "openai" }
    ],
    judgeId: "judge"
  });
});

after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

async function scriptFusedTurn(finalAnswer: string): Promise<void> {
  await stack.sim.reset();
  await stack.sim.queue("gpt-panel-a", [{ reply: "candidate from the OpenAI-wire member" }]);
  await stack.sim.queue("claude-panel-b", [{ reply: "candidate from the Anthropic-wire member" }]);
  // The judge endpoint serves both fuse-step roles in order: analysis, then synthesis.
  await stack.sim.queue("gpt-judge", [{ reply: JUDGE_ANALYSIS }, { reply: finalAnswer }]);
}

test("fused turn: OpenAI chat front door through gateway + engine + provider wire", { skip: SKIP }, async () => {
  await scriptFusedTurn("fused: full stack answer");
  const response = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      messages: [{ role: "user", content: "what approach should we take?" }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    choices: Array<{ message: { role: string; content: string } }>;
  };
  assert.equal(body.object, "chat.completion");
  assert.match(body.choices[0]?.message.content ?? "", /fused: full stack answer/);

  // The journal proves the production call graph: both members fanned out on
  // their own dialects, then the judge analyzed and synthesized.
  const journal = await stack.sim.journal();
  const dialects = new Map(journal.map((entry) => [entry.model, entry.dialect]));
  assert.equal(dialects.get("gpt-panel-a"), "openai-chat");
  assert.equal(dialects.get("claude-panel-b"), "anthropic-messages");
  assert.equal(journal.filter((entry) => entry.model === "gpt-judge").length, 2);
  // Panel members saw the caller's message verbatim (k=1 proposal contract).
  const memberRequest = journal.find((entry) => entry.model === "gpt-panel-a")?.request as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  assert.ok(
    memberRequest.messages?.some((message) => message.content?.includes("what approach should we take?")),
    "panel member must see the caller's message verbatim"
  );
});

test("fused turn: streaming SSE through the whole stack", { skip: SKIP }, async () => {
  await scriptFusedTurn("streamed fused answer");
  const response = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      stream: true,
      messages: [{ role: "user", content: "stream the fused answer" }]
    })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames = parseSse(await response.text());
  assert.match(sseText(frames), /streamed fused answer/);
  assert.ok(sseDone(frames), "stream must terminate with [DONE]");
});

test("fused turn: Anthropic Messages front door translates dialects end to end", { skip: SKIP }, async () => {
  await scriptFusedTurn("fused answer via anthropic door");
  const response = await fetch(`${stack.gatewayUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "fusion-panel",
      max_tokens: 256,
      messages: [{ role: "user", content: "answer through the anthropic dialect" }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    type: string;
    content: Array<{ type: string; text?: string }>;
  };
  assert.equal(body.type, "message");
  // The gateway may prepend a `thinking` block (judge narration) before the
  // answer, exactly like a reasoning-enabled Claude response; find the text.
  const text = body.content.find((block) => block.type === "text")?.text ?? "";
  assert.match(text, /fused answer via anthropic door/);
});

test("vendor passthrough: a member model routes gateway -> engine -> provider", { skip: SKIP }, async () => {
  await stack.sim.reset();
  await stack.sim.queue("claude-panel-b", [{ reply: "passthrough through every process" }]);
  const response = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-panel-b",
      messages: [{ role: "user", content: "direct to one vendor" }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.match(body.choices[0]?.message.content ?? "", /passthrough through every process/);
  // Exactly one provider call, on the Anthropic dialect — no fusion machinery.
  const journal = await stack.sim.journal();
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.dialect, "anthropic-messages");
});

test("panel degradation: one member's provider 401 still yields a fused answer", { skip: SKIP }, async () => {
  await stack.sim.reset();
  await stack.sim.queue("gpt-panel-a", [{ error: simErrors.invalidApiKey() }]);
  await stack.sim.queue("claude-panel-b", [{ reply: "the surviving candidate" }]);
  await stack.sim.queue("gpt-judge", [{ reply: JUDGE_ANALYSIS }, { reply: "fused from the survivor" }]);
  const response = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      messages: [{ role: "user", content: "degrade gracefully" }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.match(body.choices[0]?.message.content ?? "", /fused from the survivor/);
  const failed = await stack.sim.journalFor("gpt-panel-a");
  assert.deepEqual(failed.map((entry) => entry.status), [401]);
});
