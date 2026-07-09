/**
 * Cross-process depth suite: the product behaviors beyond single happy-path
 * turns, through the REAL gateway + REAL Python engine + scripted provider.
 *
 *  - the multi-turn fused agent tool loop (the product's core loop), on both
 *    the OpenAI chat and Anthropic Messages doors (dialect round-trips of
 *    tool_calls / tool_use / tool_result included);
 *  - k=1 proposal fidelity: panel members see the caller's tools verbatim;
 *  - multi-ensemble routing with per-ensemble judges and prompt overrides
 *    (asserted on the judge's actual wire request);
 *  - durable session accounting (turns + usage + priced cost in the store);
 *  - narration beats on the streaming reasoning channel.
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";

import { InMemorySessionStore } from "@fusionkit/model-gateway";
import { judgeAnalysis, parseSse, sseReasoning, sseText, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

const MEMBERS = [
  { id: "alpha", model: "gpt-deep-a", provider: "openai" },
  { id: "beta", model: "claude-deep-b", provider: "anthropic" },
  { id: "judge", model: "gpt-deep-judge", provider: "openai" },
  { id: "minijudge", model: "gpt-mini-judge", provider: "openai" }
] as const;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } }
    }
  }
];

let stack: SimFusionStack;
let store: InMemorySessionStore;

before(async function () {
  if (SKIP !== false) return;
  store = new InMemorySessionStore();
  stack = await startSimFusionStack({
    members: [...MEMBERS],
    judgeId: "judge",
    sessionStore: store,
    pricing: { "gpt-deep-judge": { inputPer1mTokens: 10, outputPer1mTokens: 30 } },
    ensembles: [
      {
        name: "default",
        memberIds: ["alpha", "beta"],
        judgeId: "judge",
        prompts: { judge: "DEFAULT-JUDGE-MARKER weigh all evidence" }
      },
      {
        name: "mini",
        memberIds: ["alpha"],
        judgeId: "minijudge",
        prompts: { judge: "MINI-JUDGE-MARKER be quick" }
      }
    ]
  });
});

after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

type ChatChoice = {
  finish_reason: string;
  message: { content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
};

// --- the multi-turn fused agent tool loop (OpenAI door) ---------------------------

test("fused multi-turn tool loop through the OpenAI door", { skip: SKIP }, async () => {
  await stack.sim.reset();
  // Turn 1: both members PROPOSE tool calls (k=1 members see caller tools
  // verbatim); the judge analyzes; the synthesizer commits the batch.
  await stack.sim.queue("gpt-deep-a", [
    { tool_calls: [{ id: "prop_a", name: "read_file", arguments: '{"path": "config.yaml"}' }] }
  ]);
  await stack.sim.queue("claude-deep-b", [
    { tool_calls: [{ id: "prop_b", name: "read_file", arguments: '{"path": "settings.py"}' }] }
  ]);
  await stack.sim.queue("gpt-deep-judge", [
    { reply: judgeAnalysis() },
    { tool_calls: [{ id: "call_cfg", name: "read_file", arguments: '{"path": "config.yaml"}' }] }
  ]);
  const turn1 = await stack.door.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "why is the port wrong?" }],
    tools: TOOLS
  });
  assert.equal(turn1.status, 200);
  const choice1 = ((await turn1.json()) as { choices: ChatChoice[] }).choices[0];
  assert.equal(choice1?.finish_reason, "tool_calls");
  const toolCall = choice1?.message.tool_calls?.[0];
  assert.equal(toolCall?.function.name, "read_file");
  assert.deepEqual(JSON.parse(toolCall?.function.arguments ?? "{}"), { path: "config.yaml" });

  // k=1 proposal contract (spec B7): members received the caller's tools
  // VERBATIM on the wire — not a harness re-rendering.
  for (const model of ["gpt-deep-a", "claude-deep-b"]) {
    const call = (await stack.sim.calls({ model }))[0];
    assert.ok(
      JSON.stringify(call?.request).includes("read_file"),
      `${model} must be offered the caller's tools: ${await stack.sim.describeJournal()}`
    );
  }

  // Turn 2: the caller executed the tool; the loop closes on a fused answer.
  await stack.sim.queue("gpt-deep-a", ["the port is 8081"]);
  await stack.sim.queue("claude-deep-b", ["config pins 8081"]);
  await stack.sim.queue("gpt-deep-judge", [
    { reply: judgeAnalysis() },
    { reply: "final: update the port to 8081" }
  ]);
  const turn2 = await stack.door.chat({
    model: "fusion-panel",
    messages: [
      { role: "user", content: "why is the port wrong?" },
      { role: "assistant", content: null, tool_calls: [toolCall] },
      { role: "tool", tool_call_id: toolCall?.id, content: "port: 8081" }
    ],
    tools: TOOLS
  });
  assert.equal(turn2.status, 200);
  const choice2 = ((await turn2.json()) as { choices: ChatChoice[] }).choices[0];
  assert.match(choice2?.message.content ?? "", /final: update the port to 8081/);
  // The tool output reached the second-round panel AND the synthesizer wire
  // (the judge's analysis prompt sees the task + candidates by design; the
  // synthesizer sees the live conversation including tool results).
  const alphaTurn2 = (await stack.sim.calls({ model: "gpt-deep-a" }))[1];
  assert.ok(JSON.stringify(alphaTurn2?.request).includes("port: 8081"));
  const synthTurn2 = (await stack.sim.calls({ model: "gpt-deep-judge" }))[3];
  assert.ok(
    JSON.stringify(synthTurn2?.request).includes("port: 8081"),
    await stack.sim.describeJournal()
  );
});

// --- the same loop through the Anthropic door (dialect round-trip) -------------------

test("fused tool loop through the Anthropic door round-trips tool_use/tool_result", { skip: SKIP }, async () => {
  await stack.sim.reset();
  await stack.sim.queue("gpt-deep-a", ["look at the config"]);
  await stack.sim.queue("claude-deep-b", ["check config.yaml"]);
  await stack.sim.queue("gpt-deep-judge", [
    { reply: judgeAnalysis() },
    { tool_calls: [{ id: "call_read", name: "read_file", arguments: '{"path": "config.yaml"}' }] }
  ]);
  const turn1 = await stack.door.messages({
    model: "fusion-panel",
    max_tokens: 256,
    messages: [{ role: "user", content: "why is the port wrong?" }],
    tools: [
      {
        name: "read_file",
        description: "read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } }
      }
    ]
  });
  assert.equal(turn1.status, 200);
  const body1 = (await turn1.json()) as {
    stop_reason: string;
    content: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  };
  // The fused tool call must surface as a native Anthropic tool_use block.
  assert.equal(body1.stop_reason, "tool_use");
  const toolUse = body1.content.find((block) => block.type === "tool_use");
  assert.equal(toolUse?.name, "read_file");
  assert.deepEqual(toolUse?.input, { path: "config.yaml" });

  await stack.sim.queue("gpt-deep-a", ["8081 confirmed"]);
  await stack.sim.queue("claude-deep-b", ["it is 8081"]);
  await stack.sim.queue("gpt-deep-judge", [
    { reply: judgeAnalysis() },
    { reply: "final via anthropic loop: port is 8081" }
  ]);
  const turn2 = await stack.door.messages({
    model: "fusion-panel",
    max_tokens: 256,
    messages: [
      { role: "user", content: "why is the port wrong?" },
      { role: "assistant", content: [{ type: "tool_use", id: toolUse?.id, name: "read_file", input: { path: "config.yaml" } }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse?.id, content: "port: 8081" }]
      }
    ],
    tools: [
      {
        name: "read_file",
        description: "read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } }
      }
    ]
  });
  assert.equal(turn2.status, 200);
  const body2 = (await turn2.json()) as { content: Array<{ type: string; text?: string }> };
  const text = body2.content.find((block) => block.type === "text")?.text ?? "";
  assert.match(text, /final via anthropic loop: port is 8081/);
  // The Anthropic tool_result crossed the whole stack into the panel's wire.
  const alphaTurn2 = (await stack.sim.calls({ model: "gpt-deep-a" }))[1];
  assert.ok(JSON.stringify(alphaTurn2?.request).includes("port: 8081"));
});

// --- multi-ensemble routing + per-ensemble prompts -------------------------------------

test("multi-ensemble routing fans out only the requested ensemble's members and judge", { skip: SKIP }, async () => {
  await stack.sim.reset();
  await stack.sim.queue("gpt-deep-a", ["mini candidate"]);
  await stack.sim.queue("gpt-mini-judge", [{ reply: judgeAnalysis() }, { reply: "mini fused answer" }]);
  const response = await stack.door.chat({
    model: "fusion-mini",
    messages: [{ role: "user", content: "route to the mini ensemble" }]
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: ChatChoice[] };
  assert.match(body.choices[0]?.message.content ?? "", /mini fused answer/);

  // Only alpha fanned out (beta belongs to the default ensemble only), and
  // the fuse step ran on the mini ensemble's own judge.
  assert.equal((await stack.sim.calls({ model: "claude-deep-b" })).length, 0, await stack.sim.describeJournal());
  assert.equal((await stack.sim.calls({ model: "gpt-deep-a" })).length, 1);
  assert.equal((await stack.sim.calls({ model: "gpt-mini-judge" })).length, 2);
  // The mini ensemble's committed prompt override reached the judge wire.
  const judgeRequest = (await stack.sim.calls({ model: "gpt-mini-judge" }))[0];
  assert.ok(
    JSON.stringify(judgeRequest?.request.messages).includes("MINI-JUDGE-MARKER"),
    "per-ensemble judge prompt override must reach the wire"
  );
});

test("the default ensemble's prompt override reaches its judge wire", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({
    candidates: { "gpt-deep-a": "a", "claude-deep-b": "b" },
    judgeModel: "gpt-deep-judge",
    answer: "default fused"
  });
  const response = await stack.door.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "default ensemble" }]
  });
  assert.equal(response.status, 200);
  const judgeRequest = (await stack.sim.calls({ model: "gpt-deep-judge" }))[0];
  assert.ok(JSON.stringify(judgeRequest?.request.messages).includes("DEFAULT-JUDGE-MARKER"));
});

// --- durable session accounting ----------------------------------------------------------

test("fused turns land in the session store with usage and priced cost", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({
    candidates: { "gpt-deep-a": "a", "claude-deep-b": "b" },
    answer: { reply: "accounted answer", prompt_tokens: 1000, completion_tokens: 500 },
    analysis: judgeAnalysis()
  });
  const response = await stack.door.chat({
    model: "fusion-panel",
    messages: [{ role: "user", content: "account this turn" }]
  });
  assert.equal(response.status, 200);
  await delay(300); // detached persistence flush

  const sessions = store.list();
  assert.ok(sessions.length > 0, "a fused turn must create a durable session");
  const detail = store.load(sessions[0]?.id ?? "");
  assert.ok(detail, "session detail must load");
  assert.ok(detail.turns.length >= 1, "the turn must be persisted");
  // WS7: the fused turn is priced against the judge model's pricing override
  // (10/1M in, 30/1M out) applied to the fuse step's scripted usage.
  const cost = detail.meta.cost;
  assert.ok(cost !== undefined, "session cost accounting must be persisted");
  assert.ok(cost.totalUsd > 0, `expected a priced session cost, got ${JSON.stringify(cost)}`);
});

// --- narration on the reasoning channel ---------------------------------------------------

test("streaming fused turns narrate panel progress on the reasoning channel", { skip: SKIP }, async () => {
  await stack.scriptFusedTurn({
    candidates: { "gpt-deep-a": "a", "claude-deep-b": "b" },
    answer: "narrated answer"
  });
  const response = await stack.door.chat({
    model: "fusion-panel",
    stream: true,
    messages: [{ role: "user", content: "narrate this" }]
  });
  assert.equal(response.status, 200);
  const frames = parseSse(await response.text());
  const narration = sseReasoning(frames);
  assert.match(narration, /Fanning out to 2 models/, "panel fanout must be narrated");
  assert.match(narration, /Judging 2 candidates/, "judging must be narrated");
  assert.match(sseText(frames), /narrated answer/);
});
