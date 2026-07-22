import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFailure,
  makeRouteResult,
  qualificationCompleteness,
  reserveRouteBudget,
  ROUTE_CASES,
  ROUTE_IDS,
  selectedRoutes
} from "../scripts/routekit-qualification.mjs";

test("qualification declares exactly the seven launch routes", () => {
  assert.equal(ROUTE_CASES.length, 7);
  assert.equal(new Set(ROUTE_IDS).size, 7);
  assert.deepEqual(ROUTE_IDS, [
    "route-openai-api",
    "route-anthropic-api",
    "route-openrouter-api",
    "route-codex-subscription",
    "route-claude-code-subscription",
    "route-cursor-ide",
    "route-cursor-agent"
  ]);
  assert.deepEqual(
    ROUTE_CASES.find((route) => route.routeId === "route-codex-subscription")
      .additionalDoors,
    ["codex"]
  );
  assert.deepEqual(
    ROUTE_CASES.find(
      (route) => route.routeId === "route-claude-code-subscription"
    ).additionalDoors,
    ["claude", "pool"]
  );
  assert.equal(
    ROUTE_CASES.find((route) => route.routeId === "route-cursor-agent").provider,
    "openrouter"
  );
  assert.deepEqual(
    ROUTE_CASES.filter((route) => route.manualEvidenceRequired).map(
      (route) => route.routeId
    ),
    ROUTE_IDS.slice(3)
  );
  assert.throws(() => selectedRoutes(["route-not-offered"]), /unknown route filter/);
});

test("route result is allowlisted and cannot serialize prompts or credentials", () => {
  const route = ROUTE_CASES[0];
  const secret = "sk-secret-value-that-must-not-appear";
  const prompt = "private prompt that must not appear";
  const result = makeRouteResult(route, {
    status: "fail",
    reasonCode: "unexpected-raw-error",
    model: "openai/gpt-test",
    clientVersion: "0.8.0",
    protocol: { streaming: "pass", tools: "pass", reasoning: "degraded" },
    behavior: {
      cancellation: "pass",
      failurePropagation: "pass",
      routekitFallback: "none"
    },
    setupRestore: { setup: "not-applicable", restore: "not-applicable" },
    rawError: `${secret}: ${prompt}`,
    messages: [{ role: "user", content: prompt }],
    credentialValue: secret
  });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, new RegExp(prompt));
  assert.equal(result.reasonCode, "provider-request-failed");
});

test("route results cannot persist free-form secrets or exceed their route budget", () => {
  const secret = "sk-secret-material";
  const route = ROUTE_CASES.find((candidate) => candidate.routeId === "route-cursor-ide");
  const failed = makeRouteResult(route, {
    status: "pass",
    reasonCode: "qualified",
    credentialAvailable: true,
    model: secret,
    clientVersion: secret,
    protocol: { streaming: "pass", tools: "pass", reasoning: "degraded" },
    behavior: {
      cancellation: "pass",
      failurePropagation: "pass",
      routekitFallback: "none"
    },
    attributionBasis: "manual-custom-endpoint-observation",
    gatewayRequestsObserved: 2,
    setupRestore: { setup: "pass", restore: "pass" },
    evidence: [secret, "private-prompt", "manual-preflight"]
  });
  assert.equal(failed.status, "fail");
  const serialized = JSON.stringify(failed);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /private-prompt/);
  assert.match(serialized, /manual-preflight/);
});

test("budget reservation and completeness are strict", () => {
  assert.throws(() => reserveRouteBudget(ROUTE_CASES, 1), /above budget/);
  const budget = reserveRouteBudget(ROUTE_CASES, 32);
  assert.ok(budget.plannedMaximum <= budget.authorizedMaximum);

  const routes = ROUTE_CASES.map((route) =>
    makeRouteResult(route, {
      status: "pass",
      credentialAvailable: true,
      model: `${route.provider}/test-model`,
      clientVersion: "test",
      protocol: { streaming: "pass", tools: "pass", reasoning: "pass" },
      behavior: {
        cancellation: "pass",
        failurePropagation: "pass",
        routekitFallback: "none"
      },
      setupRestore: {
        setup: route.setupRestore === "required" ? "pass" : "not-applicable",
        restore: route.setupRestore === "required" ? "pass" : "not-applicable"
      },
      attributionBasis:
        route.manual === true
          ? "manual-custom-endpoint-observation"
          : "namespaced-route-success",
      gatewayRequestsObserved: 1,
      evidence: ["qualification-test"]
    })
  );
  assert.deepEqual(qualificationCompleteness(routes), {
    complete: true,
    allPassed: false,
    expectedRouteIds: ROUTE_IDS,
    missingRouteIds: [],
    duplicateRouteIds: [],
    failedRouteIds: [
      "route-codex-subscription",
      "route-claude-code-subscription",
      "route-cursor-ide",
      "route-cursor-agent"
    ]
  });
  const automated = routes.slice(0, 3);
  assert.equal(
    qualificationCompleteness(automated, ROUTE_IDS.slice(0, 3)).allPassed,
    true
  );
  const incomplete = qualificationCompleteness(routes.slice(1));
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missingRouteIds, ["route-openai-api"]);
});

test("raw runtime failures collapse to stable reason codes", () => {
  assert.equal(classifyFailure(new Error("OPENAI_API_KEY missing")), "api-credential-unavailable");
  assert.equal(classifyFailure(new Error("cursor-agent is not installed")), "client-unavailable");
  assert.equal(classifyFailure(new Error("no subscription accounts")), "account-unavailable");
  assert.equal(classifyFailure(new Error("catalog returned 500")), "provider-discovery-failed");
  assert.equal(classifyFailure(new Error("arbitrary private detail")), "provider-request-failed");
});
