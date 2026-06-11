import assert from "node:assert/strict";
import { test } from "node:test";

import { agents, toAgentSpec } from "../agents.js";
import { localFirst, planContinuation } from "../policy.js";
import { targets } from "../targets.js";

test("typed descriptors carry no magic strings", () => {
  const target = targets.pool("eng-prod");
  assert.deepEqual(target, {
    kind: "runtime-target",
    id: "pool:eng-prod",
    locality: "customer-runner",
    pool: "eng-prod"
  });
  assert.throws(() => targets.pool(""));

  assert.deepEqual(toAgentSpec(agents.mock()), { kind: "mock" });
  assert.deepEqual(toAgentSpec(agents.claudeCode({ version: ">=2.1" })), {
    kind: "claude-code",
    version: ">=2.1"
  });
  assert.deepEqual(toAgentSpec(agents.codex()), { kind: "codex" });
});

test("planner allows within policy and explains why", () => {
  const decision = planContinuation(localFirst({ allowPools: ["eng-prod"] }), {
    target: targets.pool("eng-prod"),
    secrets: ["NPM_TOKEN"],
    budget: {},
    parallelism: 1
  });
  assert.equal(decision.decision, "continue");
  assert.equal(decision.tier, "workspace");
  assert.ok(decision.reasons.some((r) => r.includes("eng-prod")));
  assert.ok(decision.reasons.some((r) => r.includes("NPM_TOKEN")));
});

test("planner fails closed on pool, budget, and parallelism violations", () => {
  const policy = localFirst({
    allowPools: ["eng-prod"],
    denyPools: ["prod-db"],
    maxSpendUsd: 10,
    maxDurationMin: 30,
    maxParallelRuns: 2
  });

  const denied = planContinuation(policy, {
    target: targets.pool("untrusted"),
    secrets: [],
    budget: {},
    parallelism: 1
  });
  assert.equal(denied.decision, "deny");
  assert.ok(denied.reasons.some((r) => r.includes("not in the continuation allowlist")));

  const hardDeny = planContinuation(policy, {
    target: targets.pool("prod-db"),
    secrets: [],
    budget: {},
    parallelism: 1
  });
  assert.equal(hardDeny.decision, "deny");
  assert.ok(hardDeny.reasons.some((r) => r.includes("denied by continuation policy")));

  const overBudget = planContinuation(policy, {
    target: targets.pool("eng-prod"),
    secrets: [],
    budget: { maxSpendUsd: 100 },
    parallelism: 1
  });
  assert.equal(overBudget.decision, "deny");

  const overDuration = planContinuation(policy, {
    target: targets.pool("eng-prod"),
    secrets: [],
    budget: { maxDurationMin: 120 },
    parallelism: 1
  });
  assert.equal(overDuration.decision, "deny");

  const tooParallel = planContinuation(policy, {
    target: targets.pool("eng-prod"),
    secrets: [],
    budget: {},
    parallelism: 3
  });
  assert.equal(tooParallel.decision, "deny");
  assert.ok(tooParallel.reasons.some((r) => r.includes("parallel")));
});

test("default policy allows any pool with bounded fan-out", () => {
  const policy = localFirst();
  assert.equal(policy.maxParallelRuns, 4);
  assert.equal(policy.disclosure, "minimal-context");
  const decision = planContinuation(policy, {
    target: targets.pool("anything"),
    secrets: [],
    budget: {},
    parallelism: 4
  });
  assert.equal(decision.decision, "continue");
});
