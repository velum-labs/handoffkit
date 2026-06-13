import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { agents, localFirst } from "@warrant/handoff";
import { makeRepo, startStack } from "@warrant/testkit";
import type { Stack } from "@warrant/testkit";

import { swarmTools } from "../swarm-tools.js";
import type {
  DispatchOutput,
  EscalateOutput,
  PullOutput,
  StatusOutput,
  SwarmTools,
  SwarmToolsConfig
} from "../swarm-tools.js";

const POOL = "swarm-pool";
const TOOL_CTX = { toolCallId: "call", messages: [] };

let stack: Stack;

before(async () => {
  // A concurrent runner so a worker fan-out actually runs in parallel; mock
  // workers keep the test deterministic and key-free. Both worker and cloud
  // (escalation) runs use the mock agent on the process tier here — the real
  // swarm uses pi workers and a claude-code cloud target.
  stack = await startStack({
    pool: POOL,
    startRunner: true,
    concurrency: 4,
    pollIntervalMs: 25,
    policy: (policy) => {
      policy.agents.allow = ["mock"];
    }
  });
});

after(async () => {
  await stack.stop();
});

function makeSwarm(repoDir: string, overrides: Partial<SwarmToolsConfig> = {}): SwarmTools {
  return swarmTools({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    workerPool: POOL,
    cloudPool: POOL,
    actor: { kind: "human", id: "orchestrator" },
    // Mock workers and a mock cloud agent on the process tier keep CI key-free.
    workerAgent: agents.mock(),
    workerSession: "process",
    cloudAgent: agents.mock(),
    cloudSession: "process",
    ...overrides
  });
}

test("dispatch fans workers out and a completed worker is judged from evidence and pulled", async () => {
  const repoDir = makeRepo({ files: { "README.md": "# swarm fixture\n" } });
  try {
    const swarm = makeSwarm(repoDir);
    const dispatch = swarm.tools.dispatch_workers.execute;
    const pull = swarm.tools.pull_worker.execute;
    assert.ok(dispatch && pull);

    const dispatched = (await dispatch(
      { tasks: [{ prompt: "improve the docs", fileScope: ["MOCK_AGENT.md"] }] },
      TOOL_CTX
    )) as DispatchOutput;
    assert.equal(dispatched.budgetExceeded, false);
    assert.equal(dispatched.dispatched.length, 1);
    const runId = dispatched.dispatched[0]?.runId;
    assert.ok(runId);

    const pulled = (await pull({ runId }, TOOL_CTX)) as PullOutput;
    assert.equal(pulled.verdict, "accepted");
    assert.equal(pulled.status, "completed");
    assert.ok(pulled.filesChanged.includes("MOCK_AGENT.md"));
    assert.ok(pulled.scorecard, "an accepted worker carries a deterministic scorecard");
    assert.equal(pulled.scorecard?.status, "completed");
    assert.equal(pulled.scorecard?.exitCode, 0);
    assert.ok(pulled.receipt?.verified, "the receipt must verify offline");
    assert.match(pulled.receipt?.contractHash ?? "", /^[0-9a-f]{64}$/);

    // The worker's change landed on the workspace of record.
    assert.ok(existsSync(join(repoDir, "MOCK_AGENT.md")));

    // The evidence record reflects the accepted verdict.
    const records = swarm.calls();
    assert.ok(
      records.some((r) => r.tool === "pull_worker" && r.verdict === "accepted" && r.runId === runId)
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("a worker overlapping already-pulled files is downgraded to escalate, not pulled", async () => {
  const repoDir = makeRepo({ files: { "README.md": "# overlap fixture\n" } });
  try {
    const swarm = makeSwarm(repoDir);
    const dispatch = swarm.tools.dispatch_workers.execute;
    const pull = swarm.tools.pull_worker.execute;
    assert.ok(dispatch && pull);

    // Two mock workers both write MOCK_AGENT.md, so they necessarily collide.
    const dispatched = (await dispatch(
      { tasks: [{ prompt: "task one" }, { prompt: "task two" }] },
      TOOL_CTX
    )) as DispatchOutput;
    assert.equal(dispatched.dispatched.length, 2);
    const [a, b] = dispatched.dispatched;
    assert.ok(a && b);

    const first = (await pull({ runId: a.runId }, TOOL_CTX)) as PullOutput;
    assert.equal(first.verdict, "accepted");

    const second = (await pull({ runId: b.runId }, TOOL_CTX)) as PullOutput;
    assert.equal(second.verdict, "escalate");
    assert.ok(second.conflictingPaths?.includes("MOCK_AGENT.md"));
    assert.match(second.reason, /overlaps already-pulled/);
    // Evidence is still attached to the refused pull.
    assert.ok(second.receipt?.verified);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("worker_status reports without blocking and flags unknown ids", async () => {
  const repoDir = makeRepo({ files: { "README.md": "# status fixture\n" } });
  try {
    const swarm = makeSwarm(repoDir);
    const dispatch = swarm.tools.dispatch_workers.execute;
    const status = swarm.tools.worker_status.execute;
    assert.ok(dispatch && status);

    const dispatched = (await dispatch(
      { tasks: [{ prompt: "do work" }] },
      TOOL_CTX
    )) as DispatchOutput;
    const runId = dispatched.dispatched[0]?.runId;
    assert.ok(runId);

    const reported = (await status(
      { runIds: [runId, "run_does_not_exist"] },
      TOOL_CTX
    )) as StatusOutput;
    assert.equal(reported.statuses.length, 2);
    assert.equal(reported.statuses.find((s) => s.runId === runId)?.known, true);
    assert.equal(reported.statuses.find((s) => s.runId === "run_does_not_exist")?.known, false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("dispatch beyond the fan-out ceiling is refused with budgetExceeded", async () => {
  const repoDir = makeRepo({ files: { "README.md": "# budget fixture\n" } });
  try {
    const swarm = makeSwarm(repoDir, {
      policy: localFirst({ allowPools: [POOL], maxParallelRuns: 1 })
    });
    const dispatch = swarm.tools.dispatch_workers.execute;
    assert.ok(dispatch);

    const dispatched = (await dispatch(
      { tasks: [{ prompt: "one" }, { prompt: "two" }] },
      TOOL_CTX
    )) as DispatchOutput;
    assert.equal(dispatched.budgetExceeded, true);
    assert.equal(dispatched.dispatched.length, 0);
    assert.match(dispatched.reason, /exceeds policy ceiling/);
    assert.equal(swarm.calls().length, 0, "a refused dispatch produces no records");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("escalate_task runs the cloud agent as a governed run and is budget-bounded", async () => {
  const repoDir = makeRepo({ files: { "README.md": "# escalate fixture\n" } });
  try {
    const swarm = makeSwarm(repoDir, { maxEscalations: 1 });
    const escalate = swarm.tools.escalate_task.execute;
    assert.ok(escalate);

    const first = (await escalate({ task: "fix it properly" }, TOOL_CTX)) as EscalateOutput;
    assert.equal(first.budgetExceeded, false);
    assert.equal(first.status, "completed");
    assert.ok(first.receipt?.verified);
    assert.match(first.receipt?.contractHash ?? "", /^[0-9a-f]{64}$/);

    const second = (await escalate({ task: "and again" }, TOOL_CTX)) as EscalateOutput;
    assert.equal(second.budgetExceeded, true);
    assert.match(second.reason, /budget exhausted/);

    const records = swarm.calls();
    assert.equal(records.filter((r) => r.tool === "escalate_task").length, 1);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
