import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  agents,
  handoff,
  localFirst,
  reviewStrategies,
  targets
} from "@warrant/handoff";
import type { Handoff } from "@warrant/handoff";
import {
  hashCanonical,
  PolicyDeniedError,
  verifyReceiptBundle
} from "@warrant/protocol";
import type { HandoffEnvelope } from "@warrant/protocol";
import { git, makeRepo, startStack } from "@warrant/testkit";
import type { Stack } from "@warrant/testkit";

const SECRET_VALUE = "handoff-secret-value-9876";
const POOL = "eng-prod";

let stack: Stack;
let repoDir: string;
let h: Handoff;

before(async () => {
  stack = await startStack({
    pool: POOL,
    policy: (policy) => {
      policy.agents.allow = ["mock"];
      policy.secrets.releasable = [
        { name: "MOCK_SECRET", scope: "handoff-test", pools: [POOL] }
      ];
    },
    secrets: { MOCK_SECRET: SECRET_VALUE }
  });
  repoDir = makeRepo({
    files: { "README.md": "# handoff fixture\n", "src.txt": "original\n" }
  });
  h = handoff({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    actor: { kind: "human", id: "handoff-tester" },
    agent: agents.mock(),
    policy: localFirst({ allowPools: [POOL], maxParallelRuns: 3 }),
    secrets: ["MOCK_SECRET"]
  });
});

after(async () => {
  await stack.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

test("dry run discloses the continuation and moves nothing", async () => {
  const { report, envelope, decision } = await h.dryRun(targets.pool(POOL), {
    task: "dry probe",
    reason: "what would move?"
  });
  assert.equal(decision.decision, "continue");
  assert.equal(report.dryRun, true);
  assert.ok(report.continuation);
  assert.equal(report.continuation.checkpointId, envelope.checkpoint.checkpointId);
  assert.equal(report.continuation.envelopeHash, hashCanonical(envelope));
  assert.deepEqual(report.secrets.map((s) => s.name), ["MOCK_SECRET"]);

  const { runs } = await stack.client.listRuns();
  assert.equal(runs.length, 0, "dry run must not create a run");
});

test("continueIn hands local work to a governed runner with full provenance", async () => {
  writeFileSync(join(repoDir, "src.txt"), "locally modified before handoff\n");
  const transcript = "user: please finish this refactor\nagent: continuing in eng-prod";

  const run = await h.continueIn(targets.pool(POOL), {
    task: "continue the refactor and touch files",
    reason: "local machine is going offline",
    transcript
  });
  assert.match(run.runId, /^run_/);
  assert.equal(run.envelope.target.pool, POOL);
  assert.equal(run.envelope.checkpoint.tier, "workspace");
  assert.ok(run.envelope.checkpoint.semantic?.transcriptHash);

  // The envelope itself is stored content-addressed on the plane.
  const envelopeBlob = await stack.client.getBlob(run.envelopeHash);
  const storedEnvelope = JSON.parse(envelopeBlob.toString("utf8")) as HandoffEnvelope;
  assert.equal(hashCanonical(storedEnvelope), run.envelopeHash);
  assert.equal(storedEnvelope.envelopeId, run.envelope.envelopeId);

  // The transcript moved as semantic state, content-addressed.
  const transcriptHash = run.envelope.checkpoint.semantic?.transcriptHash ?? "";
  const storedTranscript = await stack.client.getBlob(transcriptHash);
  assert.equal(storedTranscript.toString("utf8"), transcript);

  // Execute on the runner and wait for the terminal state.
  assert.equal(await stack.runOnce(), run.runId);
  const outcome = await run.wait({ timeoutMs: 30_000 });
  assert.equal(outcome.status, "completed");

  // The signed contract pins the envelope hash; the chain records the checkpoint.
  const bundle = await run.receipt();
  assert.ok(bundle.contract.continuation);
  assert.equal(bundle.contract.continuation.envelopeHash, run.envelopeHash);
  assert.equal(
    bundle.contract.continuation.checkpointId,
    run.envelope.checkpoint.checkpointId
  );
  assert.ok(
    bundle.events.some(
      (e) =>
        e.event.type === "checkpoint.created" &&
        e.event.checkpointId === run.envelope.checkpoint.checkpointId
    )
  );

  // Offline verification still holds, and the secret value never leaked.
  const verification = verifyReceiptBundle(bundle);
  assert.deepEqual(verification.problems, []);
  assert.deepEqual(bundle.receipt.secretsReleased.map((s) => s.name), ["MOCK_SECRET"]);
  assert.ok(!JSON.stringify(bundle).includes(SECRET_VALUE));
  assert.ok(!JSON.stringify(run.envelope).includes(SECRET_VALUE));

  // Pull the results back. The run's output diff is computed against the
  // contract base ref and includes our pre-handoff dirty edit; discard the
  // local copy of that edit so the clean fast path applies.
  git(repoDir, ["checkout", "--", "."]);
  const pulled = await run.pull();
  assert.equal(pulled.mode, "applied");
  const agentOutput = readFileSync(join(repoDir, "MOCK_AGENT.md"), "utf8");
  assert.ok(agentOutput.includes("continue the refactor"));

  // The local trace explains the whole continuation.
  const types = h.trace().map((event) => event.type);
  assert.ok(types.includes("checkpoint.created"));
  assert.ok(types.includes("continuation.planned"));
  assert.ok(types.includes("envelope.created"));
  assert.ok(types.includes("run.requested"));
  assert.ok(types.includes("run.terminal"));
  assert.ok(types.includes("results.pulled"));
});

test("parallel fan-out shares one checkpoint and review picks a winner", async () => {
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "--quiet", "-m", "absorb first continuation"]);

  const runs = await h.parallel(
    [
      "attempt one: smallest safe fix",
      "attempt two: compatibility-preserving refactor",
      "attempt three: aggressive cleanup with much more verbose output"
    ],
    targets.pool(POOL),
    { reason: "explore three strategies" }
  );
  assert.equal(runs.length, 3);
  const checkpointIds = new Set(
    runs.map((run) => run.envelope.checkpoint.checkpointId)
  );
  assert.equal(checkpointIds.size, 1, "fan-out must share one checkpoint");
  assert.equal(new Set(runs.map((run) => run.runId)).size, 3);

  for (let i = 0; i < runs.length; i++) {
    assert.ok(await stack.runOnce(), "runner must process each attempt");
  }
  for (const run of runs) {
    const outcome = await run.wait({ timeoutMs: 30_000 });
    assert.equal(outcome.status, "completed");
  }

  const review = await h.review(runs, { choose: reviewStrategies.smallestDiff() });
  assert.equal(review.candidates.length, 3);
  assert.ok(review.reason.includes("smallest output diff"));
  assert.ok(runs.some((run) => run.runId === review.chosen.run.runId));

  // Diverge the local workspace, then pull: isolation lands on a branch.
  writeFileSync(join(repoDir, "local-edit.txt"), "concurrent local work\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "--quiet", "-m", "diverge"]);
  const pulled = await review.chosen.run.pull();
  assert.equal(pulled.mode, "branch");

  const first = await h.review(runs, { choose: reviewStrategies.firstCompleted() });
  assert.ok(first.reason.includes("first attempt to complete"));
});

test("continuation policy fails closed before anything moves", async () => {
  await assert.rejects(
    () => h.continueIn(targets.pool("untrusted-pool"), { task: "exfiltrate" }),
    (error: unknown) => {
      assert.ok(error instanceof PolicyDeniedError);
      assert.ok(error.reasons.some((r) => r.includes("untrusted-pool")));
      return true;
    }
  );
  const denied = h
    .trace()
    .filter((e) => e.type === "continuation.planned" && e.decision === "deny");
  assert.ok(denied.length >= 1, "the denial must be visible in the trace");
});

test("plane org policy independently denies disallowed agents", async () => {
  const rogue = handoff({
    workspace: repoDir,
    plane: { url: stack.planeUrl, adminToken: stack.adminToken },
    agent: agents.codex(),
    policy: localFirst()
  });
  await assert.rejects(
    () => rogue.continueIn(targets.pool(POOL), { task: "use a disallowed agent" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /not allowed/);
      return true;
    }
  );
});
