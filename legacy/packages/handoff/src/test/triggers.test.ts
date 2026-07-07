import assert from "node:assert/strict";
import { test } from "node:test";

import { defineHandoffConfig, handoff } from "../handoff.js";
import { localFirst } from "../policy.js";
import { targets } from "../targets.js";
import { evaluateTriggers, triggers } from "../triggers.js";

function context(policy = localFirst()) {
  return handoff({
    workspace: ".",
    plane: { url: "http://127.0.0.1:9", adminToken: "unused" },
    policy
  });
}

test("evaluateTriggers fires deterministically against observable state", () => {
  const list = [
    triggers.userRequested(),
    triggers.toolFailed(),
    triggers.slowTools({ thresholdMs: 1000 }),
    triggers.modelEscalated()
  ];

  const idle = evaluateTriggers(list, {
    userRequested: false,
    toolFailures: 0,
    totalToolDurationMs: 0,
    modelEscalations: 0
  });
  assert.deepEqual(idle, []);

  const busy = evaluateTriggers(list, {
    userRequested: true,
    toolFailures: 2,
    totalToolDurationMs: 5000,
    modelEscalations: 1
  });
  assert.deepEqual(
    busy.map((f) => f.trigger.id).sort(),
    ["model-escalated", "slow-tools", "tool-failed", "user-requested"]
  );
  for (const fired of busy) {
    assert.ok(fired.reason.length > 0, "every fired trigger explains itself");
  }
});

test("needs() honors continueWhen: allowed pool but no fired trigger means no", async () => {
  const h = context(
    localFirst({
      allowPools: ["eng-prod"],
      continueWhen: [triggers.toolFailed(), triggers.userRequested()]
    })
  );
  const target = targets.pool("eng-prod");

  assert.equal(h.needs(target), false, "no trigger has fired yet");
  assert.deepEqual(h.firedTriggers(), []);

  // A journaled tool failure flips the answer.
  const tools = h.tools({
    flaky: {
      execute: async () => {
        throw new Error("network blip");
      }
    }
  });
  await assert.rejects(() => Promise.resolve(tools.flaky.execute()));
  assert.equal(h.needs(target), true);
  assert.equal(h.firedTriggers()[0]?.trigger.id, "tool-failed");

  // Policy still fails closed on a disallowed pool, triggers or not.
  assert.equal(h.needs(targets.pool("untrusted")), false);
});

test("requestContinuation is the explicit user gesture", () => {
  const h = context(
    localFirst({ continueWhen: [triggers.userRequested()] })
  );
  assert.equal(h.needs(targets.pool("anywhere")), false);
  h.requestContinuation("user closed the laptop lid");
  assert.equal(h.needs(targets.pool("anywhere")), true);
  const requested = h
    .trace()
    .find((event) => event.type === "continuation.requested");
  assert.ok(requested && requested.type === "continuation.requested");
  assert.equal(requested.reason, "user closed the laptop lid");
});

test("model escalation decisions feed triggers and the trace", async () => {
  const h = context(
    localFirst({ continueWhen: [triggers.modelEscalated()] })
  );
  assert.equal(h.needs(targets.pool("anywhere")), false);

  h.noteModelDecision({
    model: "local-small",
    route: "local",
    escalated: false,
    reason: "local-first policy"
  });
  assert.equal(h.needs(targets.pool("anywhere")), false, "local routes do not fire");

  h.noteModelDecision({
    model: "cloud-frontier",
    route: "cloud",
    escalated: true,
    reason: "local model failed (context-overflow)"
  });
  assert.equal(h.needs(targets.pool("anywhere")), true);

  const summary = await h.summary();
  assert.deepEqual(summary.modelRoutes, { local: 1, cloud: 1, escalations: 1 });
});

test("defineHandoffConfig supplies defaults; explicit config wins", () => {
  defineHandoffConfig({
    plane: { url: "http://127.0.0.1:9", adminToken: "from-defaults" },
    policy: localFirst({ allowPools: ["from-defaults"] })
  });
  try {
    const fromDefaults = handoff({ workspace: "." });
    assert.equal(fromDefaults.needs(targets.pool("from-defaults")), true);
    assert.equal(fromDefaults.needs(targets.pool("other")), false);

    const explicit = handoff({
      workspace: ".",
      policy: localFirst({ allowPools: ["explicit"] })
    });
    assert.equal(explicit.needs(targets.pool("explicit")), true);
    assert.equal(explicit.needs(targets.pool("from-defaults")), false);
  } finally {
    defineHandoffConfig({});
  }
});

test("handoff without a plane anywhere fails loudly", () => {
  assert.throws(() => handoff({ workspace: "." }), /requires a plane/);
});
