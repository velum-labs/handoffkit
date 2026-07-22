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
    egressHost: "api.openai.com",
    billingMode: "openai-api",
    aggregator: false,
    setupRestore: "not-applicable",
    maxGatewayRequests: 1
  },
  {
    routeId: "route-anthropic-api",
    provider: "anthropic",
    door: "anthropic-messages",
    client: "routekit-http",
    credentialMode: "api-key",
    credentialReference: "ANTHROPIC_API_KEY",
    protocolPath: "/v1/messages",
    egressHost: "api.anthropic.com",
    billingMode: "anthropic-api",
    aggregator: false,
    setupRestore: "not-applicable",
    maxGatewayRequests: 1
  },
  {
    routeId: "route-openrouter-api",
    provider: "openrouter",
    door: "openai-chat",
    client: "routekit-http",
    credentialMode: "api-key",
    credentialReference: "OPENROUTER_API_KEY",
    protocolPath: "/v1/chat/completions",
    egressHost: "openrouter.ai",
    billingMode: "openrouter-credits",
    aggregator: true,
    setupRestore: "not-applicable",
    maxGatewayRequests: 1
  },
  {
    routeId: "route-codex-subscription",
    provider: "codex",
    door: "codex-responses",
    client: "codex",
    credentialMode: "enrolled-subscription",
    credentialReference: "codex",
    protocolPath: "/v1/responses",
    egressHost: "chatgpt.com",
    billingMode: "codex-subscription",
    aggregator: false,
    setupRestore: "required",
    maxGatewayRequests: 1
  },
  {
    routeId: "route-claude-code-subscription",
    provider: "claude-code",
    door: "anthropic-messages",
    client: "claude",
    credentialMode: "enrolled-subscription",
    credentialReference: "claude-code",
    protocolPath: "/v1/messages",
    egressHost: "api.anthropic.com",
    billingMode: "claude-code-subscription",
    aggregator: false,
    setupRestore: "required",
    maxGatewayRequests: 1
  },
  {
    routeId: "route-cursor-ide",
    provider: "openai",
    door: "cursor-ide",
    client: "cursor-ide",
    credentialMode: "cursor-login-plus-selected-route",
    credentialReference: "cursor-desktop",
    protocolPath: "/v1/cursor/chat/completions",
    egressHost: "api.openai.com",
    billingMode: "selected-route",
    aggregator: false,
    setupRestore: "required",
    maxGatewayRequests: 1,
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
    egressHost: "api.openai.com",
    billingMode: "selected-route",
    aggregator: false,
    setupRestore: "required",
    maxGatewayRequests: 2
  }
]);

export const ROUTE_IDS = Object.freeze(ROUTE_CASES.map((route) => route.routeId));

const SAFE_CAPABILITY_OUTCOMES = new Set(["pass", "fail", "degraded", "not-applicable"]);
const SAFE_ATTRIBUTION_BASES = new Set([
  "namespaced-route-success",
  "manual-custom-endpoint-observation",
  "not-observed"
]);
const SAFE_EVIDENCE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+() _/-]{0,159}$/;
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
  const plannedMaximum = routes.reduce((sum, route) => sum + route.maxGatewayRequests, 0);
  assert.ok(
    plannedMaximum <= authorizedMaximum,
    `selected routes reserve ${plannedMaximum} gateway requests, above budget ${authorizedMaximum}`
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

function safeReasonCode(value, status) {
  if (status === "pass") return "qualified";
  return SAFE_REASON_CODES.has(value) && value !== "qualified"
    ? value
    : "provider-request-failed";
}

function safeIdentifier(value, pattern) {
  if (
    typeof value !== "string" ||
    !pattern.test(value) ||
    /(?:sk-|bearer|secret|token|credential)/i.test(value) ||
    value.includes("..")
  ) {
    return "unavailable";
  }
  return value;
}

function safeEvidenceIds(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry) =>
          typeof entry === "string" &&
          SAFE_EVIDENCE_ID.test(entry) &&
          !/(?:secret|token|prompt|response|credential|authorization)/i.test(entry)
      )
    )
  ];
}

function passRequirements(route, input, protocol, behavior, setupRestore) {
  const reasoningPass =
    protocol.reasoning === "pass" ||
    (route.routeId.startsWith("route-cursor-") && protocol.reasoning === "degraded");
  const setupRestorePass =
    route.setupRestore === "not-applicable"
      ? setupRestore.setup === "not-applicable" && setupRestore.restore === "not-applicable"
      : setupRestore.setup === "pass" && setupRestore.restore === "pass";
  const model = safeIdentifier(input.model, SAFE_MODEL_ID);
  const modelPass =
    model !== "unavailable" &&
    model.includes("/") &&
    (route.routeId.startsWith("route-cursor-") ||
      model.startsWith(`${route.provider}/`));
  const attributionPass =
    route.manual === true
      ? input.attributionBasis === "manual-custom-endpoint-observation"
      : input.attributionBasis === "namespaced-route-success";
  return (
    input.credentialAvailable === true &&
    modelPass &&
    safeIdentifier(input.clientVersion, SAFE_VERSION) !== "unavailable" &&
    protocol.streaming === "pass" &&
    protocol.tools === "pass" &&
    reasoningPass &&
    behavior.cancellation === "pass" &&
    behavior.failurePropagation === "pass" &&
    behavior.routekitFallback === "none" &&
    setupRestorePass &&
    Number.isInteger(input.gatewayRequestsObserved) &&
    input.gatewayRequestsObserved > 0 &&
    input.gatewayRequestsObserved <= route.maxGatewayRequests &&
    attributionPass &&
    safeEvidenceIds(input.evidence).length > 0
  );
}

export function makeRouteResult(route, input) {
  assert.ok(route !== undefined, "route descriptor is required");
  const protocol = input.protocol ?? {};
  const behavior = input.behavior ?? {};
  const setupRestore = input.setupRestore ?? {};
  const requestedPass = input.status === "pass";
  const status = requestedPass && passRequirements(route, input, protocol, behavior, setupRestore)
    ? "pass"
    : "fail";
  const reasonCode =
    status === "pass"
      ? "qualified"
      : requestedPass && route.setupRestore === "required" &&
          (setupRestore.setup !== "pass" || setupRestore.restore !== "pass")
        ? "setup-restore-failed"
        : safeReasonCode(input.reasonCode, "fail");
  return {
    routeId: route.routeId,
    status,
    reasonCode,
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0,
    provider: {
      id: route.provider,
      model: safeIdentifier(input.model, SAFE_MODEL_ID),
      apiRevision: safeIdentifier(
        input.apiRevision ?? "not-advertised",
        SAFE_VERSION
      ),
      egressHost: route.egressHost,
      aggregator: route.aggregator
    },
    credential: {
      mode: route.credentialMode,
      reference: route.credentialReference,
      available: input.credentialAvailable === true
    },
    client: {
      id: route.client,
      version: safeIdentifier(input.clientVersion, SAFE_VERSION),
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
      attributionBasis: SAFE_ATTRIBUTION_BASES.has(input.attributionBasis)
        ? input.attributionBasis
        : "not-observed",
      gatewayRequestsObserved: Number.isInteger(input.gatewayRequestsObserved)
        ? Math.max(0, input.gatewayRequestsObserved)
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
    evidence: safeEvidenceIds(input.evidence)
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
