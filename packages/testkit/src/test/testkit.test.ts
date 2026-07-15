/**
 * Tooling validation: the Node testkit can boot the cross-stack harness —
 * RouteKit-upstream simulator (spawned Python child) + the internal Python
 * synthesis sidecar (the exact entrypoint the production CLI spawns) — script
 * responses over the control plane, drive the sidecar's internal HTTP surface,
 * and observe the wire journal.
 *
 * Skipped (with the reason) where the Python toolchain is unavailable; the
 * `stack-e2e` CI job runs it with both toolchains installed.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  parseSse,
  simErrors,
  simSidecarConfigYaml,
  spawnCaptured,
  sseDone,
  sseText,
  stackToolingSkip,
  startEngine,
  startProviderSim
} from "../index.js";
import type { EngineHandle, ProviderSimHandle } from "../index.js";

const SKIP = stackToolingSkip();

const JUDGE_ANALYSIS = JSON.stringify({
  consensus: ["agreement"],
  contradictions: [],
  unique_insights: [],
  coverage_gaps: [],
  likely_errors: [],
  recommended_final_structure: []
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let sim: ProviderSimHandle;
let engine: EngineHandle;

before(async function () {
  if (SKIP !== false) return;
  sim = await startProviderSim();
  engine = await startEngine({
    configYaml: simSidecarConfigYaml({
      simUrl: sim.url,
      members: [
        { id: "alpha", model: "alpha" },
        { id: "beta", model: "beta" },
        { id: "judge", model: "judge" }
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
  await sim.queue("gpt-panel-a", ["scripted from node"]);
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
});

test("internal sidecar: fused streaming step calls opaque RouteKit judge id", { skip: SKIP }, async () => {
  await sim.reset();
  await sim.queue("judge", [{ reply: JUDGE_ANALYSIS }, { reply: "fused across the stack" }]);
  const response = await fetch(`${engine.url}/v1/fusion/trajectories:fuse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      stream: true,
      messages: [{ role: "user", content: "fuse it" }],
      trajectories: [
        {
          trajectory_id: "traj-alpha",
          model_id: "alpha",
          status: "succeeded",
          final_output: "candidate A"
        },
        {
          trajectory_id: "traj-beta",
          model_id: "beta",
          status: "succeeded",
          final_output: "candidate B"
        }
      ]
    })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const frames = parseSse(await response.text());
  assert.equal(sseText(frames), "fused across the stack");
  assert.ok(sseDone(frames), "fused stream must terminate with [DONE]");

  // Panel trajectories are produced by Node; the sidecar calls only judge and
  // synthesis through the opaque RouteKit endpoint.
  const models = (await sim.journal()).map((entry) => entry.model);
  assert.deepEqual(models, ["judge", "judge"]);
});

test("internal sidecar can synthesize after RouteKit judge analysis fails", { skip: SKIP }, async () => {
  await sim.reset();
  await sim.queue("judge", [{ error: simErrors.invalidApiKey() }]);
  const response = await fetch(`${engine.url}/v1/fusion/trajectories:fuse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      messages: [{ role: "user", content: "hi" }],
      trajectories: [
        {
          trajectory_id: "traj-alpha",
          model_id: "alpha",
          status: "succeeded",
          final_output: "candidate"
        }
      ]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.match(body.choices[0]?.message.content ?? "", /judge default reply/);
  const journal = await sim.journalFor("judge");
  assert.deepEqual(journal.map((entry) => entry.status), [401, 200]);
});

test("captured-process teardown kills wrapper grandchildren", async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'console.log("GRANDCHILD:" + child.pid);',
    "setInterval(() => {}, 1000);"
  ].join("\n");
  const proc = spawnCaptured({ command: process.execPath, args: ["-e", script] });
  const line = await proc.nextLine(/^GRANDCHILD:/, 5_000);
  const grandchildPid = Number(line.slice("GRANDCHILD:".length));
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

  await proc.close();
  const deadline = Date.now() + 2_000;
  while (processAlive(grandchildPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processAlive(grandchildPid), false, "the child process group must be fully reaped");
});
