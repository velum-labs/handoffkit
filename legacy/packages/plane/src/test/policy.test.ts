import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultPolicy, evaluatePolicy } from "../policy.js";
import { PolicyDeniedError } from "@fusionkit/protocol";
import type { Policy } from "@fusionkit/protocol";

function policyFixture(): Policy {
  const policy = defaultPolicy();
  policy.runners.allowPools = ["eng-prod"];
  policy.agents.allow = ["mock", "claude-code"];
  policy.network.allowHosts = ["registry.npmjs.org"];
  policy.secrets.releasable = [
    { name: "MOCK_SECRET", scope: "test", pools: ["eng-prod"] }
  ];
  return policy;
}

test("policy allows a compliant run", () => {
  const decision = evaluatePolicy(policyFixture(), {
    agentKind: "mock",
    pool: "eng-prod",
    secretNames: ["MOCK_SECRET"],
    allowHosts: ["registry.npmjs.org"]
  });
  assert.equal(decision.decision, "allow");
});

test("policy fails closed on disallowed agent, pool, secret, host, and budget", () => {
  const policy = policyFixture();

  assert.throws(
    () =>
      evaluatePolicy(policy, {
        agentKind: "codex",
        pool: "eng-prod",
        secretNames: [],
        allowHosts: []
      }),
    PolicyDeniedError
  );

  assert.throws(
    () =>
      evaluatePolicy(policy, {
        agentKind: "mock",
        pool: "other-pool",
        secretNames: [],
        allowHosts: []
      }),
    PolicyDeniedError
  );

  assert.throws(
    () =>
      evaluatePolicy(policy, {
        agentKind: "mock",
        pool: "eng-prod",
        secretNames: ["UNKNOWN_SECRET"],
        allowHosts: []
      }),
    PolicyDeniedError
  );

  assert.throws(
    () =>
      evaluatePolicy(policy, {
        agentKind: "mock",
        pool: "eng-prod",
        secretNames: [],
        allowHosts: ["exfil.example.com"]
      }),
    PolicyDeniedError
  );

  assert.throws(
    () =>
      evaluatePolicy(policy, {
        agentKind: "mock",
        pool: "eng-prod",
        secretNames: [],
        allowHosts: [],
        maxSpendUsd: 10_000
      }),
    PolicyDeniedError
  );
});

test("policy returns ask when a consent rule matches", () => {
  const policy = policyFixture();
  policy.consent = [{ when: "secret-release", approvers: ["security-team"] }];

  const withSecret = evaluatePolicy(policy, {
    agentKind: "mock",
    pool: "eng-prod",
    secretNames: ["MOCK_SECRET"],
    allowHosts: []
  });
  assert.equal(withSecret.decision, "ask");
  assert.deepEqual(withSecret.consentRequirements, [
    "secret-release:MOCK_SECRET"
  ]);

  const withoutSecret = evaluatePolicy(policy, {
    agentKind: "mock",
    pool: "eng-prod",
    secretNames: [],
    allowHosts: []
  });
  assert.equal(withoutSecret.decision, "allow");
});
