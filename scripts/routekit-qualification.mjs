import assert from "node:assert/strict";

export const ROUTE_CASES = Object.freeze([
  {
    routeId: "route-openai-api",
    provider: "openai",
    door: "openai-chat",
    client: "routekit-http",
    credentialMode: "api-key",
    credentialReference: "OPENAI_API_KEY",
    protocolPath: "/v1/chat/completions",
    billingMode: "openai-api",
    aggregator: false,
    setupRestore: "not-applicable",
    maxProviderCalls: 1
  },
  {
    routeId: "route-anthropic-api",
    provider: "anthropic",
    door: "anthropic-messages",
    client: "routekit-http",
    credentialMode: "api-key",
    credentialReference: "ANTHROPIC_API_KEY",
    protocolPath: "/v1/messages",
    billingMode: "anthropic-api",
    aggregator: false,
    setupRestore: "not-applicable",
    maxProviderCalls: 1
  },
  {
    routeId: "route-openrouter-api",
    provider: "openrouter",
    door: "openai-chat",
    client: "routekit-http",
    credentialMode: "api-key",
    credentialReference: "OPENROUTER_API_KEY",
    protocolPath: "/v1/chat/completions",
    billingMode: "openrouter-credits",
    aggregator: true,
    setupRestore: "not-applicable",
    maxProviderCalls: 1
  },
  {
    routeId: "route-codex-subscription",
    provider: "codex",
    door: "codex-responses",
    client: "codex",
    credentialMode: "enrolled-subscription",
    credentialReference: "codex",
    protocolPath: "/v1/responses",
    billingMode: "codex-subscription",
    aggregator: false,
    setupRestore: "required",
    maxProviderCalls: 1
  },
  {
    routeId: "route-claude-code-subscription",
    provider: "claude-code",
    door: "anthropic-messages",
    client: "claude",
    credentialMode: "enrolled-subscription",
    credentialReference: "claude-code",
    protocolPath: "/v1/messages",
    billingMode: "claude-code-subscription",
    aggregator: false,
    setupRestore: "required",
    maxProviderCalls: 1
  },
  {
    routeId: "route-cursor-ide",
    provider: "openai",
    door: "cursor-ide",
    client: "cursor-ide",
    credentialMode: "cursor-login-plus-selected-route",
    credentialReference: "cursor-desktop",
    protocolPath: "/v1/cursor/chat/completions",
    billingMode: "selected-route",
    aggregator: false,
    setupRestore: "required",
    maxProviderCalls: 1,
    manual: true
  },
  {
    routeId: "route-cursor-agent",
    provider: "openai",
    door: "cursor",
    client: "cursor-agent",
    credentialMode: "cursor-login-plus-selected-route",
    credentialReference: "cursor-agent",
    protocolPath: "/v1/cursor/chat/completions",
    billingMode: "selected-route",
    aggregator: false,
    setupRestore: "required",
    maxProviderCalls: 2
  }
]);

export const ROUTE_IDS = Object.freeze(ROUTE_CASES.map((route) => route.routeId));

const SAFE_OUTCOMES = new Set(["pass", "fail"]);
const SAFE_CAPABILITY_OUTCOMES = new Set(["pass", "fail", "degraded", "not-applicable"]);
const SAFE_REASON_CODES = new Set([
  "qualified",
  "api-credential-unavailable",
  "client-unavailable",
  "account-unavailable",
  "manual-evidence-unavailable",
  "provider-discovery-failed",
  "provider-request-failed",
  "budget-insufficient",
  "setup-restore-failed",
  "matrix-case-missing",
  "matrix-case-duplicate",
  "matrix-top-level-error"
]);

export function routeById(routeId) {
  return ROUTE_CASES.find((route) => route.routeId === routeId);
}

export function selectedRoutes(routeIds) {
  if (routeIds === undefined) return ROUTE_CASES;
  const unique = [...new Set(routeIds)];
  for (const routeId of unique) {
    assert.ok(routeById(routeId), `unknown route filter "${routeId}"`);
  }
  return unique.map((routeId) => routeById(routeId));
}

export function routeForAutomatedCase(provider, door) {
  return ROUTE_CASES.find(
    (route) => route.manual !== true && route.provider === provider && route.door === door
  );
}

export function classifyFailure(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (/credential|api[_ -]?key|unauthori[sz]ed|forbidden|401|403/i.test(text)) {
    return "api-credential-unavailable";
  }
  if (/not installed|ENOENT|executable|command not found/i.test(text)) {
    return "client-unavailable";
  }
  if (/account|subscription|oauth|no models|discovered no models/i.test(text)) {
    return "account-unavailable";
  }
  if (/budget/i.test(text)) return "budget-insufficient";
  if (/discover|catalog|models/i.test(text)) return "provider-discovery-failed";
  return "provider-request-failed";
}

export function reserveRouteBudget(routes, authorizedMaximum) {
  const plannedMaximum = routes.reduce((sum, route) => sum + route.maxProviderCalls, 0);
  assert.ok(
    plannedMaximum <= authorizedMaximum,
    `selected routes reserve ${plannedMaximum} provider requests, above budget ${authorizedMaximum}`
  );
  return {
    authorizedMaximum,
    plannedMaximum,
    remaining: authorizedMaximum
  };
}

function capability(value, fallback = "fail") {
  return SAFE_CAPABILITY_OUTCOMES.has(value) ? value : fallback;
}

function safeVersion(value) {
  if (typeof value !== "string" || value.trim() === "") return "unavailable";
  return value.trim().replaceAll(/[\r\n\t]/g, " ").slice(0, 160);
}

function safeReasonCode(value, status) {
  if (status === "pass") return "qualified";
  return SAFE_REASON_CODES.has(value) ? value : "provider-request-failed";
}

export function makeRouteResult(route, input) {
  assert.ok(route !== undefined, "route descriptor is required");
  const status = SAFE_OUTCOMES.has(input.status) ? input.status : "fail";
  const protocol = input.protocol ?? {};
  const behavior = input.behavior ?? {};
  const setupRestore = input.setupRestore ?? {};
  return {
    routeId: route.routeId,
    status,
    reasonCode: safeReasonCode(input.reasonCode, status),
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0,
    provider: {
      id: route.provider,
      model: safeVersion(input.model),
      apiRevision: safeVersion(input.apiRevision ?? "not-advertised"),
      egressHost: safeVersion(input.egressHost ?? "not-observed"),
      aggregator: route.aggregator
    },
    credential: {
      mode: route.credentialMode,
      reference: route.credentialReference,
      available: input.credentialAvailable === true
    },
    client: {
      id: route.client,
      version: safeVersion(input.clientVersion),
      integrationMode: route.manual === true ? "custom-endpoint-desktop" : route.door
    },
    protocol: {
      door: route.door,
      path: route.protocolPath,
      streaming: capability(protocol.streaming),
      tools: capability(protocol.tools),
      reasoning: capability(protocol.reasoning)
    },
    behavior: {
      cancellation: capability(behavior.cancellation),
      failurePropagation: capability(behavior.failurePropagation),
      routekitFallback: behavior.routekitFallback === "none" ? "none" : "unverified",
      providerManagedRouting:
        route.aggregator === true ? "openrouter-upstream-routing" : "not-applicable"
    },
    billing: {
      mode: route.billingMode,
      attributionBasis: safeVersion(input.attributionBasis ?? "request-observation"),
      providerRequestsObserved: Number.isInteger(input.providerRequestsObserved)
        ? Math.max(0, input.providerRequestsObserved)
        : 0
    },
    setupRestore: {
      expectation: route.setupRestore,
      setup: capability(
        setupRestore.setup,
        route.setupRestore === "not-applicable" ? "not-applicable" : "fail"
      ),
      restore: capability(
        setupRestore.restore,
        route.setupRestore === "not-applicable" ? "not-applicable" : "fail"
      )
    },
    evidence: Array.isArray(input.evidence)
      ? input.evidence.filter((value) => typeof value === "string").map(safeVersion)
      : []
  };
}

export function validateManualEvidence(raw, expectedRouteId = "route-cursor-ide") {
  assert.equal(raw?.routeId, expectedRouteId, `manual evidence must target ${expectedRouteId}`);
  assert.ok(SAFE_OUTCOMES.has(raw.status), "manual evidence status must be pass or fail");
  assert.ok(
    raw.status === "pass" || SAFE_REASON_CODES.has(raw.reasonCode),
    "manual evidence failure needs a known reasonCode"
  );
  return {
    status: raw.status,
    reasonCode: safeReasonCode(raw.reasonCode, raw.status),
    durationMs: raw.durationMs,
    model: raw.model,
    apiRevision: raw.apiRevision,
    egressHost: raw.egressHost,
    credentialAvailable: raw.credentialAvailable,
    clientVersion: raw.clientVersion,
    protocol: raw.protocol,
    behavior: raw.behavior,
    attributionBasis: raw.attributionBasis,
    providerRequestsObserved: raw.providerRequestsObserved,
    setupRestore: raw.setupRestore,
    evidence: raw.evidence
  };
}

export function qualificationCompleteness(routes, expectedRouteIds = ROUTE_IDS) {
  const counts = new Map();
  for (const route of routes) {
    counts.set(route.routeId, (counts.get(route.routeId) ?? 0) + 1);
  }
  const missingRouteIds = expectedRouteIds.filter((routeId) => !counts.has(routeId));
  const duplicateRouteIds = expectedRouteIds.filter((routeId) => (counts.get(routeId) ?? 0) > 1);
  const failedRouteIds = routes
    .filter((route) => expectedRouteIds.includes(route.routeId) && route.status === "fail")
    .map((route) => route.routeId);
  return {
    complete: missingRouteIds.length === 0 && duplicateRouteIds.length === 0,
    allPassed:
      missingRouteIds.length === 0 &&
      duplicateRouteIds.length === 0 &&
      failedRouteIds.length === 0,
    expectedRouteIds,
    missingRouteIds,
    duplicateRouteIds,
    failedRouteIds
  };
}
