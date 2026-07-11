/**
 * WS4 durable resume across a gateway restart for an UNBOUNDED managed
 * worktree rollout. Turn 1 persists completed panel trajectories to a real
 * FileSystemSessionStore; stack 1 shuts down; stack 2 binds `resumeId` and
 * re-fuses the persisted candidates without one new panel/provider call.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { FileSystemSessionStore } from "@fusionkit/model-gateway";
import { judgeAnalysis, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

const MEMBERS = [
  { id: "member", model: "resume-member", provider: "openai" },
  { id: "judge", model: "resume-judge", provider: "openai" }
] as const;

const TURN = {
  model: "fusion-panel",
  messages: [{ role: "user", content: "persist this completed rollout" }]
};

test(
  "unbounded panel candidates survive gateway restart and resume without re-fanout",
  { skip: SKIP },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "fusionkit-resume-"));
    const store = new FileSystemSessionStore(join(root, "sessions"));
    let sessionId = "";
    const first = await startSimFusionStack({
      members: [...MEMBERS],
      judgeId: "judge",
      harness: "agent",
      unbounded: true,
      sessionStore: store
    });
    try {
      await first.sim.queue("resume-member", ["persisted managed candidate"]);
      await first.sim.queue("resume-judge", [
        { reply: judgeAnalysis() },
        { reply: "first fused answer" }
      ]);
      const response = await first.door.chat(TURN);
      assert.equal(response.status, 200, await first.sim.describeJournal());
      await delay(300); // detached session persistence
      const sessions = store.list();
      assert.equal(sessions.length, 1);
      sessionId = sessions[0]?.id ?? "";
      assert.ok(sessionId);
      const persisted = store.load(sessionId);
      assert.equal(persisted?.turns.length, 1);
      assert.equal(persisted?.turns[0]?.candidates.length, 1);
    } finally {
      await first.close();
    }

    const resumed = await startSimFusionStack({
      members: [...MEMBERS],
      judgeId: "judge",
      harness: "agent",
      unbounded: true,
      sessionStore: store,
      resumeId: sessionId
    });
    try {
      // Only the fuse step is scripted: if resume misses the persisted panel
      // cache, the member falls through to its default reply and the journal
      // exposes the regression.
      await resumed.sim.queue("resume-judge", [
        { reply: judgeAnalysis() },
        { reply: "second answer from persisted candidates" }
      ]);
      const response = await resumed.door.chat(TURN);
      assert.equal(response.status, 200, await resumed.sim.describeJournal());
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      assert.match(body.choices[0]?.message.content ?? "", /persisted candidates/);
      assert.equal(
        (await resumed.sim.calls({ model: "resume-member" })).length,
        0,
        `resume must not re-run a completed rollout: ${await resumed.sim.describeJournal()}`
      );
      assert.equal((await resumed.sim.calls({ model: "resume-judge" })).length, 2);
    } finally {
      await resumed.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
