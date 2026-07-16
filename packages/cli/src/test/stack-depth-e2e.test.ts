/**
 * Cross-process depth suite: the product behaviors beyond single happy-path
 * turns, through the Node RouteKit/Fusion gateways + Python sidecar + simulator.
 *
 *  - multi-ensemble routing with per-ensemble judges and prompt overrides
 *    (asserted on the judge's actual wire request);
 *  - durable session accounting (turns + usage + priced cost in the store);
 *  - narration beats on the streaming reasoning channel.
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";

import { InMemorySessionStore } from "@fusionkit/gateway";
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


let stack: SimFusionStack;
let store: InMemorySessionStore;

before(async function () {
  if (SKIP !== false) return;
  store = new InMemorySessionStore();
  stack = await startSimFusionStack({
    members: [...MEMBERS],
    judgeId: "judge",
    sessionStore: store,
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

// --- multi-ensemble routing + per-ensemble prompts -------------------------------------

test("multi-ensemble routing forwards the requested ensemble's prompt override", { skip: SKIP }, async () => {
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

test("fused turns persist usage without resolving opaque endpoint ids to provider pricing", { skip: SKIP }, async () => {
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
  const cost = detail.meta.cost;
  assert.ok(cost !== undefined, "session cost accounting must be persisted");
  assert.ok(cost.totalTokens > 0, `expected persisted usage, got ${JSON.stringify(cost)}`);
  assert.equal(cost.totalUsd, 0, "FusionKit must not infer provider pricing from opaque endpoint ids");
  assert.ok((cost.unknownCostEntries ?? 0) > 0);
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
