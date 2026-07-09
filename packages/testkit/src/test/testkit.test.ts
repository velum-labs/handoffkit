/**
 * Tooling validation: the Node testkit can boot the cross-stack harness —
 * provider simulator (spawned Python child) + the REAL Python fusion engine
 * (`fusionkit serve`, the exact entrypoint the production CLI spawns) — script
 * provider behaviors over the control plane, drive the engine's HTTP surface,
 * and observe the wire journal.
 *
 * Skipped (with the reason) where the Python toolchain is unavailable; the
 * `stack-e2e` CI job runs it with both toolchains installed.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  detectStackTooling,
  parseSse,
  simErrors,
  simRouterConfigYaml,
  sseDone,
  sseText,
  startEngine,
  startProviderSim
} from "../index.js";
import type { EngineHandle, ProviderSimHandle } from "../index.js";

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

let sim: ProviderSimHandle;
let engine: EngineHandle;

before(async function () {
  if (SKIP !== false) return;
  sim = await startProviderSim();
  engine = await startEngine({
    configYaml: simRouterConfigYaml({
      simUrl: sim.url,
      members: [
        { id: "alpha", model: "gpt-panel-a", provider: "openai" },
        { id: "beta", model: "claude-panel-b", provider: "anthropic" },
        { id: "judge", model: "gpt-judge", provider: "openai" }
      ],
      judgeId: "judge"
    })
  });
});

after(async () => {
  if (SKIP !== false) return;
  await engine.close();
  await sim.close();
});

test("provider simulator is scriptable and observable from Node", { skip: SKIP }, async () => {
  await sim.reset();
  await sim.queue("gpt-panel-a", [{ reply: "scripted from node" }]);
  const response = await fetch(`${sim.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-node" },
    body: JSON.stringify({
      model: "gpt-panel-a",
      messages: [{ role: "user", content: "hello" }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "scripted from node");

  const journal = await sim.journalFor("gpt-panel-a");
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.source, "queued");
  assert.equal(journal[0]?.auth.authorization, "Bearer sk-node");
});

test("real engine process: passthrough routes to the simulator on the right dialect", { skip: SKIP }, async () => {
  await sim.reset();
  await sim.queue("claude-panel-b", [{ reply: "anthropic passthrough via real engine" }]);
  const response = await fetch(`${engine.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "beta", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.equal(body.choices[0]?.message.content, "anthropic passthrough via real engine");
  const journal = await sim.journalFor("claude-panel-b");
  assert.equal(journal[0]?.dialect, "anthropic-messages");
});

test("real engine process: fused streaming turn end to end", { skip: SKIP }, async () => {
  await sim.reset();
  await sim.queue("gpt-panel-a", [{ reply: "candidate A" }]);
  await sim.queue("claude-panel-b", [{ reply: "candidate B" }]);
  await sim.queue("gpt-judge", [{ reply: JUDGE_ANALYSIS }, { reply: "fused across the stack" }]);
  const response = await fetch(`${engine.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusionkit/panel",
      stream: true,
      messages: [{ role: "user", content: "fuse it" }]
    })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames = parseSse(await response.text());
  assert.equal(sseText(frames), "fused across the stack");
  assert.ok(sseDone(frames), "fused stream must terminate with [DONE]");

  // The journal shows the full call graph: both members, then judge + synth.
  const models = (await sim.journal()).map((entry) => entry.model);
  assert.ok(models.includes("gpt-panel-a"));
  assert.ok(models.includes("claude-panel-b"));
  assert.equal(models.filter((model) => model === "gpt-judge").length, 2);
});

test("error injection reaches through the real engine (provider 401 surfaces)", { skip: SKIP }, async () => {
  await sim.reset();
  await sim.queue("gpt-panel-a", [{ error: simErrors.invalidApiKey() }]);
  const response = await fetch(`${engine.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "alpha", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(response.status, 401);
  const journal = await sim.journalFor("gpt-panel-a");
  assert.deepEqual(journal.map((entry) => entry.status), [401]);
});
