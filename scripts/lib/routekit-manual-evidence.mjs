import assert from "node:assert/strict";

import {
  assertSanitized,
  mappingDigest,
  validateEvidence,
  validateMatrixReport
} from "./routekit-l06-evidence.mjs";
import { routeById } from "../routekit-qualification.mjs";

const REVIEWED_ROUTE_IDS = Object.freeze([
  "route-codex-subscription",
  "route-claude-code-subscription",
  "route-cursor-agent"
]);
const CURSOR_IDE_ROUTE_ID = "route-cursor-ide";
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+() _/-]{0,159}$/;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function exactKeys(value, keys, label) {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has untrusted fields`);
}

function exactVersion(value, label) {
  assert.ok(
    typeof value === "string" &&
      SAFE_VERSION.test(value) &&
      !/\b(?:unavailable|pending|unknown|tbd|awaiting)\b/i.test(value),
    `${label} is unavailable`
  );
  return value;
}

function namespacedModel(value, label) {
  assert.ok(
    typeof value === "string" &&
      SAFE_MODEL.test(value) &&
      value.includes("/") &&
      !/(?:sk-|bearer|secret|token|credential)/i.test(value),
    `${label} must be an exact namespaced model`
  );
  return value;
}

function passCase(byCaseId, caseId) {
  const result = byCaseId.get(caseId);
  assert.ok(result !== undefined, `required matrix case ${caseId} is missing`);
  assert.equal(result.status, "pass", `required matrix case ${caseId} did not pass`);
  return result;
}

function matrixFoundation(mapping, report, revision) {
  const byCaseId = validateMatrixReport(mapping, report, revision, {
    supportedSchemas: [4]
  });
  assert.equal(report.evidenceMappingSchemaVersion, mapping.schemaVersion);
  assert.equal(report.liveAuthorized, true, "reviewed evidence requires an authorized live matrix");
  assert.equal(report.metadata?.routekitGitSha, revision, "matrix metadata names a stale revision");
  assert.equal(report.metadata?.gitDirty, false, "matrix metadata reports dirty sources");
  assert.equal(report.metadata?.routekitVersion, report.routekitVersion);
  exactVersion(report.routekitVersion, "RouteKit version");
  assert.match(report.finishedAt, /^20\d{2}-\d{2}-\d{2}T/, "matrix finishedAt is invalid");
  assert.ok(report.qualification !== null && typeof report.qualification === "object");
  assert.ok(Array.isArray(report.qualification.routes), "matrix qualification routes are missing");
  assert.ok(
    Number.isInteger(report.liveGatewayRequestsObserved) &&
      report.liveGatewayRequestsObserved > 0,
    "matrix observed zero live gateway requests"
  );
  const budget = report.qualification.budget;
  assert.ok(budget !== null && typeof budget === "object", "matrix qualification budget is missing");
  assert.ok(
    Number.isInteger(budget.authorizedMaximum) &&
      Number.isInteger(budget.plannedMaximum) &&
      Number.isInteger(budget.gatewayRequestsObserved),
    "matrix qualification budget is invalid"
  );
  assert.equal(
    budget.gatewayRequestsObserved,
    report.liveGatewayRequestsObserved,
    "matrix gateway observations are inconsistent"
  );
  assert.ok(
    budget.plannedMaximum <= budget.authorizedMaximum &&
      budget.gatewayRequestsObserved <= budget.authorizedMaximum,
    "matrix gateway observations exceed the authorized budget"
  );
  return byCaseId;
}

function qualificationRoute(report, routeId) {
  const matches = report.qualification.routes.filter((route) => route.routeId === routeId);
  assert.equal(matches.length, 1, `matrix must contain exactly one ${routeId} qualification`);
  return matches[0];
}

function assertSupportingCases(byCaseId, route) {
  const protocolDoor =
    route.door === "cursor" || route.door === "cursor-ide"
      ? "openai-chat"
      : route.door;
  const cases = {
    cancellation: "deterministic.shared.cancellation",
    failurePropagation:
      `deterministic.${route.provider}.failure-no-fallback-${protocolDoor}`,
    protocol: `deterministic.${route.provider}.tools-reasoning-${protocolDoor}`
  };
  const observed = Object.fromEntries(
    Object.entries(cases).map(([name, caseId]) => [
      name,
      passCase(byCaseId, caseId)
    ])
  );
  return {
    cases,
    behavior: {
      cancellation: observed.cancellation.status,
      failurePropagation: observed.failurePropagation.status,
      routekitFallback:
        observed.failurePropagation.status === "pass" ? "none" : "unverified"
    }
  };
}

function assertMappedCases(mappingRoute, route, byCaseId) {
  for (const caseId of mappingRoute.requiredCaseIds) {
    const result = passCase(byCaseId, caseId);
    if (
      result.phase === "live" &&
      result.door !== "pool"
    ) {
      assert.ok(
        Number.isInteger(result.gatewayRequests) &&
          result.gatewayRequests > 0 &&
          result.gatewayRequests <= route.maxGatewayRequests,
        `${caseId} has a zero or over-budget gateway observation`
      );
    }
  }
}

function assertReviewedQualification(mapping, report, byCaseId, routeId) {
  const route = routeById(routeId);
  const mappingRoute = mapping.routes.find((candidate) => candidate.id === routeId);
  assert.ok(route !== undefined && mappingRoute !== undefined);
  const result = qualificationRoute(report, routeId);
  assert.equal(result.status, "fail", `${routeId} must retain manual-evidence gating`);
  assert.equal(result.reasonCode, "manual-evidence-unavailable");
  assert.equal(result.provider?.id, route.provider);
  assert.equal(result.provider?.egressHost, route.egressHost);
  assert.equal(result.provider?.aggregator, route.aggregator);
  const model = namespacedModel(result.provider?.model, `${routeId} model`);
  assert.ok(
    routeId.startsWith("route-cursor-") || model.startsWith(`${route.provider}/`),
    `${routeId} model uses the wrong namespace`
  );
  assert.equal(result.credential?.mode, route.credentialMode);
  assert.equal(result.credential?.reference, route.credentialReference);
  assert.equal(result.credential?.available, true, `${routeId} credential is unavailable`);
  assert.equal(result.client?.id, route.client);
  const clientVersion = exactVersion(result.client?.version, `${routeId} client version`);
  const metadataClient = {
    "route-codex-subscription": report.metadata?.clients?.codex,
    "route-claude-code-subscription": report.metadata?.clients?.claude,
    "route-cursor-agent": report.metadata?.clients?.cursorAgent
  }[routeId];
  assert.equal(clientVersion, metadataClient, `${routeId} client version disagrees with metadata`);
  assert.equal(result.protocol?.door, route.door);
  assert.equal(result.protocol?.path, route.protocolPath);
  assert.equal(result.protocol?.streaming, "pass", `${routeId} streaming failed`);
  assert.equal(result.protocol?.tools, "pass", `${routeId} tools failed`);
  assert.ok(
    result.protocol?.reasoning === "pass" ||
      (routeId.startsWith("route-cursor-") && result.protocol?.reasoning === "degraded"),
    `${routeId} reasoning failed`
  );
  assert.equal(result.behavior?.cancellation, "pass", `${routeId} cancellation failed`);
  assert.equal(result.behavior?.failurePropagation, "pass", `${routeId} failure propagation failed`);
  assert.equal(result.behavior?.routekitFallback, "none", `${routeId} RouteKit fallback was observed`);
  assert.equal(result.billing?.mode, route.billingMode);
  assert.equal(result.billing?.attributionBasis, "namespaced-route-success");
  assert.ok(
    Number.isInteger(result.billing?.gatewayRequestsObserved) &&
      result.billing.gatewayRequestsObserved > 0 &&
      result.billing.gatewayRequestsObserved <= route.maxGatewayRequests,
    `${routeId} has a zero or over-budget gateway observation`
  );
  assert.equal(result.setupRestore?.expectation, "required");
  assert.equal(result.setupRestore?.setup, "pass", `${routeId} setup failed`);
  assert.equal(result.setupRestore?.restore, "pass", `${routeId} restore failed`);
  assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  assertSupportingCases(byCaseId, route);
  assertMappedCases(mappingRoute, route, byCaseId);
  return { route, result, model, clientVersion };
}

function reviewedRecord({ route, result, model, clientVersion, report, reportDigest }) {
  const reasoning = result.protocol.reasoning;
  const requests = result.billing.gatewayRequestsObserved;
  return {
    credentialMode: {
      "route-codex-subscription":
        "Enrolled Codex subscription account staged into isolated RouteKit state.",
      "route-claude-code-subscription":
        "Enrolled Claude Code subscription account staged into isolated RouteKit state.",
      "route-cursor-agent":
        "Authenticated cursor-agent state staged into an isolated Cursor configuration directory.",
      "route-cursor-ide":
        "Authenticated Cursor desktop state used through an isolated Cursorkit profile."
    }[route.routeId],
    clientProviderVersion:
      `${clientVersion}; RouteKit ${report.routekitVersion}; model ${model}.`,
    qualificationStatus: "qualified",
    evidence: [
      {
        status: "pass",
        label: `${route.routeId} trusted machine review`,
        reference: `reviewed-matrix:${reportDigest.slice(0, 20)}:${route.routeId}`,
        summary:
          "Derived from revision-bound allowlisted matrix and harness observations; no raw transcript was retained."
      }
    ],
    outcomes: {
      protocolBehavior: {
        status: "pass",
        summary:
          `${result.protocol.door} streaming and tools passed; reasoning ${reasoning}.`
      },
      billingAttribution: {
        status: "pass",
        summary:
          `${requests} bounded gateway request${requests === 1 ? "" : "s"} reached namespaced model ${model}.`
      },
      failureBehavior: {
        status: "pass",
        summary:
          "Cancellation and selected-route failure propagation passed with no RouteKit fallback."
      },
      setupRestore: {
        status: "pass",
        summary: "Isolated setup passed and the allowlisted source state was unchanged after cleanup."
      }
    }
  };
}

function cursorTarget(report) {
  const route = routeById(CURSOR_IDE_ROUTE_ID);
  const source = qualificationRoute(report, "route-openai-api");
  assert.equal(source.status, "pass", "Cursor IDE target route did not pass");
  assert.equal(source.reasonCode, "qualified");
  const model = namespacedModel(source.provider?.model, "Cursor IDE target model");
  assert.equal(source.provider?.id, route.provider);
  return { route, model };
}

export function cursorIdeAttestationContext(mapping, report, revision) {
  const byCaseId = matrixFoundation(mapping, report, revision);
  const { route, model } = cursorTarget(report);
  const support = assertSupportingCases(byCaseId, route);
  return {
    model,
    maxGatewayRequests: route.maxGatewayRequests,
    supportCases: support.cases,
    behavior: support.behavior
  };
}

export function createCursorIdeAttestation(
  mapping,
  report,
  cursorkitSummary,
  cursorVersion,
  measurements,
  revision = report.sourceRevision
) {
  const context = cursorIdeAttestationContext(mapping, report, revision);
  assertSanitized(cursorkitSummary);
  assert.equal(cursorkitSummary.status, "passed", "Cursorkit harness summary did not pass");
  assert.ok(Array.isArray(cursorkitSummary.results), "Cursorkit summary results are missing");
  const matches = cursorkitSummary.results.filter(
    (result) =>
      result.id === "desktop-ui-experimental" &&
      result.suite === "desktop-ui-experimental"
  );
  assert.equal(matches.length, 1, "Cursorkit summary must contain one desktop-ui-experimental result");
  const harness = matches[0];
  assert.equal(harness.status, "passed", "Cursorkit desktop-ui-experimental did not pass");
  const details = harness.details;
  assert.ok(details !== null && typeof details === "object");
  for (const [field, expected] of Object.entries({
    ckProfileMode: "isolated-seeded-from-default",
    signInRequired: false,
    workspaceOpened: true,
    composerVisible: true,
    modelPickerOpened: true,
    modelTextSeen: true,
    selectedModelTextSeen: true,
    desktopPromptSubmitted: true,
    desktopProbeTextSeen: true,
    desktopModelErrorSeen: false
  })) {
    assert.equal(details[field], expected, `Cursorkit desktop observation ${field} failed`);
  }
  const protocol = {
    streaming:
      details.modelBackendRequestSeen === true &&
      details.modelBackendResponseComplete === true
        ? "pass"
        : "fail",
    tools:
      details.cursorToolResultSeen === true &&
      details.requiredCursorToolResultsSeen === true
        ? "pass"
        : "fail",
    reasoning: "degraded"
  };
  assert.equal(protocol.streaming, "pass", "Cursorkit desktop streaming failed");
  assert.equal(protocol.tools, "pass", "Cursorkit desktop tools failed");
  exactVersion(cursorVersion, "Cursor IDE version");
  exactKeys(
    measurements,
    ["gateway", "defaultProfileState", "isolatedProfileRemoved"],
    "Cursor IDE measurements"
  );
  exactKeys(
    measurements.gateway,
    [
      "requestsObserved",
      "attemptsObserved",
      "maxAllowed",
      "overBudget",
      "modelMatched"
    ],
    "Cursor IDE gateway measurements"
  );
  assert.ok(
    Number.isInteger(measurements.gateway.requestsObserved) &&
      measurements.gateway.requestsObserved > 0,
    "Cursor IDE gateway observed zero model calls"
  );
  assert.equal(
    measurements.gateway.maxAllowed,
    context.maxGatewayRequests,
    "Cursor IDE gateway used the wrong route budget"
  );
  assert.ok(
    measurements.gateway.requestsObserved <= context.maxGatewayRequests,
    "Cursor IDE gateway observations exceeded the route budget"
  );
  assert.equal(
    measurements.gateway.attemptsObserved,
    measurements.gateway.requestsObserved,
    "Cursor IDE gateway observed an over-budget model-call attempt"
  );
  assert.equal(measurements.gateway.overBudget, false);
  assert.equal(
    measurements.gateway.modelMatched,
    true,
    "Cursor IDE gateway observed the wrong namespaced model"
  );
  exactKeys(
    measurements.defaultProfileState,
    ["before", "after", "unchanged"],
    "Cursor default-profile measurements"
  );
  for (const [label, snapshot] of [
    ["before", measurements.defaultProfileState.before],
    ["after", measurements.defaultProfileState.after]
  ]) {
    exactKeys(snapshot, ["count", "digest"], `Cursor default-profile ${label} snapshot`);
    assert.ok(
      Number.isInteger(snapshot.count) && snapshot.count > 0,
      `Cursor default-profile ${label} snapshot is unavailable`
    );
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
  }
  assert.equal(
    measurements.defaultProfileState.unchanged,
    true,
    "Cursor default-profile state changed"
  );
  assert.deepEqual(
    measurements.defaultProfileState.after,
    measurements.defaultProfileState.before,
    "Cursor default-profile state changed"
  );
  assert.equal(
    measurements.isolatedProfileRemoved,
    true,
    "Cursorkit isolated profile was not removed"
  );
  const setupRestore = {
    setup: details.localModelSeedStatus === "seeded" ? "pass" : "fail",
    restore:
      measurements.defaultProfileState.unchanged === true &&
      measurements.isolatedProfileRemoved === true
        ? "pass"
        : "fail"
  };
  assert.equal(setupRestore.setup, "pass", "Cursorkit isolated profile setup failed");
  assert.equal(setupRestore.restore, "pass", "Cursorkit isolated profile restore failed");
  const reportDigest = mappingDigest(report);
  return {
    schemaVersion: 1,
    kind: "routekit-cursor-ide-attestation",
    producer: "scripts/generate-routekit-cursor-attestation.mjs",
    testedRevision: revision,
    evidenceMappingSchemaVersion: mapping.schemaVersion,
    evidenceMappingDigest: mappingDigest(mapping),
    matrixReportDigest: reportDigest,
    cursorkitSummaryDigest: mappingDigest(cursorkitSummary),
    harness: {
      resultId: "desktop-ui-experimental",
      suite: "desktop-ui-experimental",
      status: "passed"
    },
    observations: {
      credentialAvailable: true,
      cursorVersion,
      model: context.model,
      protocol,
      behavior: {
        ...context.behavior,
        sourceCases: {
          cancellation: context.supportCases.cancellation,
          failurePropagation: context.supportCases.failurePropagation,
          routekitFallback: context.supportCases.failurePropagation
        }
      },
      attributionBasis: "manual-custom-endpoint-observation",
      gateway: structuredClone(measurements.gateway),
      setupRestore: {
        ...setupRestore,
        defaultProfileState: structuredClone(
          measurements.defaultProfileState
        ),
        isolatedProfileRemoved: true
      }
    }
  };
}

function validateCursorAttestation(mapping, report, attestation, revision) {
  exactKeys(
    attestation,
    [
      "schemaVersion",
      "kind",
      "producer",
      "testedRevision",
      "evidenceMappingSchemaVersion",
      "evidenceMappingDigest",
      "matrixReportDigest",
      "cursorkitSummaryDigest",
      "harness",
      "observations"
    ],
    "Cursor IDE attestation"
  );
  assert.equal(attestation.schemaVersion, 1);
  assert.equal(attestation.kind, "routekit-cursor-ide-attestation");
  assert.equal(attestation.producer, "scripts/generate-routekit-cursor-attestation.mjs");
  assert.equal(attestation.testedRevision, revision, "Cursor attestation names a stale revision");
  assert.equal(attestation.evidenceMappingSchemaVersion, mapping.schemaVersion);
  assert.equal(attestation.evidenceMappingDigest, mappingDigest(mapping));
  assert.equal(attestation.matrixReportDigest, mappingDigest(report));
  assert.match(attestation.cursorkitSummaryDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(attestation.harness, {
    resultId: "desktop-ui-experimental",
    suite: "desktop-ui-experimental",
    status: "passed"
  });
  const context = cursorIdeAttestationContext(mapping, report, revision);
  assert.deepEqual(attestation.observations, {
    credentialAvailable: true,
    cursorVersion: exactVersion(
      attestation.observations?.cursorVersion,
      "Cursor IDE version"
    ),
    model: context.model,
    protocol: {
      streaming: "pass",
      tools: "pass",
      reasoning: "degraded"
    },
    behavior: {
      ...context.behavior,
      sourceCases: {
        cancellation: context.supportCases.cancellation,
        failurePropagation: context.supportCases.failurePropagation,
        routekitFallback: context.supportCases.failurePropagation
      }
    },
    attributionBasis: "manual-custom-endpoint-observation",
    gateway: {
      requestsObserved: attestation.observations.gateway?.requestsObserved,
      attemptsObserved: attestation.observations.gateway?.attemptsObserved,
      maxAllowed: context.maxGatewayRequests,
      overBudget: false,
      modelMatched: true
    },
    setupRestore: {
      setup: "pass",
      restore: "pass",
      defaultProfileState:
        attestation.observations.setupRestore?.defaultProfileState,
      isolatedProfileRemoved: true
    }
  });
  const gateway = attestation.observations.gateway;
  exactKeys(
    gateway,
    [
      "requestsObserved",
      "attemptsObserved",
      "maxAllowed",
      "overBudget",
      "modelMatched"
    ],
    "Cursor IDE attested gateway measurements"
  );
  assert.ok(
    Number.isInteger(gateway.requestsObserved) &&
      gateway.requestsObserved > 0 &&
      gateway.requestsObserved <= context.maxGatewayRequests
  );
  assert.equal(gateway.attemptsObserved, gateway.requestsObserved);
  const setupRestore = attestation.observations.setupRestore;
  exactKeys(
    setupRestore,
    [
      "setup",
      "restore",
      "defaultProfileState",
      "isolatedProfileRemoved"
    ],
    "Cursor IDE attested setup/restore"
  );
  const state = setupRestore.defaultProfileState;
  exactKeys(
    state,
    ["before", "after", "unchanged"],
    "Cursor IDE attested default-profile state"
  );
  exactKeys(state.before, ["count", "digest"], "Cursor IDE attested before state");
  exactKeys(state.after, ["count", "digest"], "Cursor IDE attested after state");
  assert.deepEqual(state.after, state.before);
  assert.equal(state.unchanged, true);
  assert.match(state.before.digest, /^[0-9a-f]{64}$/);
  assert.ok(Number.isInteger(state.before.count) && state.before.count > 0);
  return {
    route: routeById(CURSOR_IDE_ROUTE_ID),
    result: {
      protocol: {
        door: routeById(CURSOR_IDE_ROUTE_ID).door,
        ...attestation.observations.protocol
      },
      billing: {
        gatewayRequestsObserved: gateway.requestsObserved
      }
    },
    model: context.model,
    clientVersion: `Cursor IDE ${attestation.observations.cursorVersion}`
  };
}

export function deriveReviewedManualRecords(mapping, report, options = {}) {
  const revision = options.revision ?? report.sourceRevision;
  const byCaseId = matrixFoundation(mapping, report, revision);
  const reportDigest = mappingDigest(report);
  const routes = {};
  for (const routeId of REVIEWED_ROUTE_IDS) {
    routes[routeId] = reviewedRecord({
      ...assertReviewedQualification(mapping, report, byCaseId, routeId),
      report,
      reportDigest
    });
  }
  let cursorIdeAttestation = null;
  if (options.cursorIdeAttestation !== undefined) {
    cursorIdeAttestation = structuredClone(options.cursorIdeAttestation);
    routes[CURSOR_IDE_ROUTE_ID] = reviewedRecord({
      ...validateCursorAttestation(
        mapping,
        report,
        cursorIdeAttestation,
        revision
      ),
      report,
      reportDigest
    });
  }
  const records = {
    schemaVersion: 2,
    kind: "routekit-reviewed-manual-records",
    producer: "scripts/generate-routekit-manual-records.mjs",
    testedRevision: revision,
    evidenceDate: report.finishedAt.slice(0, 10),
    evidenceMappingSchemaVersion: mapping.schemaVersion,
    evidenceMappingDigest: mappingDigest(mapping),
    matrixReportDigest: reportDigest,
    cursorIdeAttestation,
    routes
  };
  assertSanitized(records);
  return records;
}

export function validateReviewedManualRecords(mapping, report, records) {
  exactKeys(
    records,
    [
      "schemaVersion",
      "kind",
      "producer",
      "testedRevision",
      "evidenceDate",
      "evidenceMappingSchemaVersion",
      "evidenceMappingDigest",
      "matrixReportDigest",
      "cursorIdeAttestation",
      "routes"
    ],
    "reviewed manual records"
  );
  const expected = deriveReviewedManualRecords(mapping, report, {
    revision: records.testedRevision,
    ...(records.cursorIdeAttestation === null
      ? {}
      : { cursorIdeAttestation: records.cursorIdeAttestation })
  });
  assert.deepEqual(records, expected, "manual records are not the trusted matrix projection");
}

export function applyReviewedManualRecords(mapping, source, report, records) {
  validateReviewedManualRecords(mapping, report, records);
  assert.equal(
    records.testedRevision,
    source.testedRevision,
    "manual records were reviewed against a different revision"
  );
  const next = structuredClone(source);
  next.evidenceDate = records.evidenceDate;
  for (const [routeId, record] of Object.entries(records.routes)) {
    const row = next.routes[routeId];
    row.credentialMode = record.credentialMode;
    row.clientProviderVersion = record.clientProviderVersion;
    row.qualificationStatus = record.qualificationStatus;
    row.outcomes = { ...row.outcomes, ...record.outcomes };
    row.evidence = [
      ...row.evidence.filter((item) => item.type !== "manual"),
      ...record.evidence.map((item) => ({ ...item, type: "manual" }))
    ];
  }
  validateEvidence(mapping, next);
  return next;
}
