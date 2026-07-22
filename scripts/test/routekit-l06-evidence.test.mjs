import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyManualRecords,
  caseIdFor,
  durableEvidence,
  loadEvidenceMap,
  mappingDigest,
  promoteMatrixResults,
  renderEvidenceMarkdown,
  routeIdsForCase,
  validateEvidence
} from "../lib/routekit-l06-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mapping = loadEvidenceMap(ROOT);
const source = JSON.parse(
  readFileSync(join(ROOT, "spec", "routekit", "l06-evidence.json"), "utf8")
);
const REVISION = "ec72b7cb208059ca45e105552b49530d761ea203";

function matrixResult(overrides = {}) {
  return {
    caseId: "deterministic.openai.openai-chat",
    routeIds: ["route-openai-api"],
    phase: "deterministic",
    provider: "openai",
    door: "openai-chat",
    status: "pass",
    reason: null,
    durationMs: 10,
    billedCalls: 0,
    artifact: null,
    ...overrides
  };
}

function matrixReport(results = [matrixResult()], overrides = {}) {
  return {
    schemaVersion: 2,
    routekitVersion: "0.8.0",
    evidenceMappingDigest: mappingDigest(mapping),
    sourceRevision: REVISION,
    sourceDirty: false,
    finishedAt: "2026-07-22T20:00:00.000Z",
    liveAuthorized: false,
    counts: {
      pass: results.filter((result) => result.status === "pass").length,
      fail: results.filter((result) => result.status === "fail").length,
      skip: results.filter((result) => result.status === "skip").length
    },
    results,
    topLevelError: null,
    ...overrides
  };
}

test("the stable L05 row set is exact and excludes not-offered routes", () => {
  assert.deepEqual(
    mapping.routes.map((route) => route.id),
    [
      "route-openai-api",
      "route-anthropic-api",
      "route-openrouter-api",
      "route-codex-subscription",
      "route-claude-code-subscription",
      "route-cursor-ide",
      "route-cursor-agent"
    ]
  );
  assert.deepEqual(
    routeIdsForCase(mapping, {
      provider: "openrouter",
      door: "cursor"
    }),
    ["route-openrouter-api", "route-cursor-agent"]
  );
  assert.deepEqual(
    routeIdsForCase(mapping, {
      provider: "openrouter",
      door: "opencode"
    }),
    []
  );
  assert.equal(
    caseIdFor({ phase: "live", provider: "claude-code", door: "pool" }),
    "live.claude-code.pool"
  );
});

test("complete evidence validates and carries a mapping digest", () => {
  validateEvidence(mapping, source);
  const report = durableEvidence(mapping, source);
  assert.equal(report.mappingDigest, mappingDigest(mapping));
  assert.equal(report.mappingDigest.length, 64);
});

test("missing and stale mappings fail closed", () => {
  const missing = structuredClone(source);
  missing.routes["route-openai-api"].evidence = missing.routes[
    "route-openai-api"
  ].evidence.filter((item) => item.caseId !== "live.openai.openai-chat");
  assert.throws(
    () => validateEvidence(mapping, missing),
    /missing required case live\.openai\.openai-chat/
  );

  const staleMapping = structuredClone(mapping);
  staleMapping.routes[0].requiredCaseIds.push("live.openai.codex-responses");
  assert.notEqual(mappingDigest(staleMapping), mappingDigest(mapping));
  assert.throws(
    () => validateEvidence(staleMapping, source),
    /missing required case live\.openai\.codex-responses/
  );
});

test("qualification and sanitization reject unsupported claims and credentials", () => {
  const premature = structuredClone(source);
  premature.routes["route-cursor-ide"].qualificationStatus = "qualified";
  assert.throws(() => validateEvidence(mapping, premature), /cannot be qualified/);

  const leaked = structuredClone(source);
  leaked.routes["route-openai-api"].credentialMode = "authorization=Bearer secret-value";
  assert.throws(() => validateEvidence(mapping, leaked), /credential-shaped data/);

  for (const credential of [
    { headers: { "x-api-key": "secret-value" } },
    { apiKey: "secret-value" },
    { nested: { token: "secret-value" } },
    { authorization: "Basic dXNlcjpwYXNzd29yZA==" }
  ]) {
    const injected = structuredClone(source);
    injected.routes["route-openai-api"].injected = credential;
    assert.throws(() => validateEvidence(mapping, injected), /secret field|credential-shaped/);
  }

  const provisional = structuredClone(source);
  const cursorIde = provisional.routes["route-cursor-ide"];
  cursorIde.qualificationStatus = "qualified";
  cursorIde.evidence = cursorIde.evidence.map((item) => ({ ...item, status: "pass" }));
  cursorIde.outcomes = Object.fromEntries(
    Object.entries(cursorIde.outcomes).map(([name, outcome]) => [
      name,
      { ...outcome, status: "pass", summary: `${name} verified.` }
    ])
  );
  assert.throws(
    () => validateEvidence(mapping, provisional),
    /exact client\/provider versions/
  );
});

test("matrix promotion updates only exact mapped cases", () => {
  const stale = structuredClone(source);
  const live = stale.routes["route-openai-api"].evidence.find(
    (item) => item.caseId === "live.openai.openai-chat"
  );
  live.status = "pass";
  live.result = { phase: "live", provider: "openai", door: "openai-chat" };
  stale.routes["route-openai-api"].outcomes.protocolBehavior.status = "pass";
  const promoted = promoteMatrixResults(mapping, stale, matrixReport(), REVISION);
  const openAi = promoted.routes["route-openai-api"].evidence;
  assert.equal(
    openAi.find((item) => item.caseId === "deterministic.openai.openai-chat").status,
    "pass"
  );
  assert.equal(
    openAi.find((item) => item.caseId === "live.openai.openai-chat").status,
    "pending"
  );
  assert.equal(promoted.routes["route-openai-api"].outcomes.protocolBehavior.status, "pending");
  assert.equal(promoted.routes["route-openai-api"].qualificationStatus, "pending");
  assert.match(
    promoted.routes["route-openai-api"].clientProviderVersion,
    new RegExp(REVISION)
  );
});

test("matrix promotion accepts schemaVersion 4 gateway request reports", () => {
  const report = matrixReport([
    matrixResult({
      gatewayRequests: 1,
      billedCalls: undefined,
      reason: undefined,
      reasonCode: "qualified"
    })
  ]);
  report.schemaVersion = 4;
  report.summary = { caseCounts: report.counts };
  delete report.counts;
  const promoted = promoteMatrixResults(mapping, source, report, REVISION);
  const item = promoted.routes["route-openai-api"].evidence.find(
    (evidence) => evidence.caseId === "deterministic.openai.openai-chat"
  );
  assert.equal(item.result.gatewayRequests, 1);
  assert.equal(item.summary, undefined);
});

test("matrix promotion rejects incomplete, dirty, and forged reports", () => {
  assert.throws(
    () =>
      promoteMatrixResults(
        mapping,
        source,
        matrixReport([], { topLevelError: "gateway crashed" }),
        REVISION
      ),
    /incomplete matrix report/
  );
  assert.throws(
    () =>
      promoteMatrixResults(
        mapping,
        source,
        matrixReport([], { sourceDirty: true }),
        REVISION
      ),
    /dirty-worktree/
  );
  assert.throws(
    () => promoteMatrixResults(mapping, source, matrixReport(), "f".repeat(40)),
    /must equal the matrix source revision/
  );
  assert.throws(
    () =>
      promoteMatrixResults(
        mapping,
        source,
        matrixReport([matrixResult({ provider: "anthropic" })]),
        REVISION
      ),
    /forged matrix identity/
  );
  assert.throws(
    () =>
      promoteMatrixResults(
        mapping,
        source,
        matrixReport([matrixResult({ routeIds: ["route-cursor-agent"] })]),
        REVISION
      ),
    /forged route IDs/
  );
  assert.throws(
    () =>
      promoteMatrixResults(
        mapping,
        source,
        matrixReport([matrixResult()], { counts: { pass: 0, fail: 0, skip: 0 } }),
        REVISION
      ),
    /counts do not match/
  );
});

test("rendered reports preserve skip reasons and one final newline", () => {
  const promoted = promoteMatrixResults(
    mapping,
    source,
    matrixReport([
      matrixResult({
        status: "skip",
        reason: "client is not installed"
      })
    ]),
    REVISION
  );
  const markdown = renderEvidenceMarkdown(mapping, promoted);
  assert.match(markdown, /Skipped; qualification remains pending: client is not installed/);
  assert.ok(markdown.endsWith("\n"));
  assert.ok(!markdown.endsWith("\n\n"));
});

test("manual evidence is bound to the exact tested revision", () => {
  const manualRecords = {
    schemaVersion: 1,
    testedRevision: REVISION,
    evidenceDate: "2026-07-23",
    routes: {
      "route-cursor-ide": {
        credentialMode: "Logged-in Cursor desktop account with an isolated local endpoint.",
        clientProviderVersion: "Cursor IDE 1.99; OpenRouter provider snapshot 2026-07-23.",
        evidence: [
          {
            status: "pending",
            label: "Revision-bound Cursor IDE review",
            reference: "review:cursor-ide-2026-07-23"
          }
        ]
      }
    }
  };
  assert.throws(
    () =>
      applyManualRecords(mapping, source, {
        ...manualRecords,
        testedRevision: "f".repeat(40)
      }),
    /different revision/
  );
  const revisionSource = structuredClone(source);
  revisionSource.testedRevision = REVISION;
  const applied = applyManualRecords(mapping, revisionSource, manualRecords);
  assert.equal(applied.evidenceDate, "2026-07-23");
  assert.equal(
    applied.routes["route-cursor-ide"].clientProviderVersion,
    "Cursor IDE 1.99; OpenRouter provider snapshot 2026-07-23."
  );
});

test("the unfiltered live matrix gateway limit covers all five providers", () => {
  const script = readFileSync(join(ROOT, "scripts", "routekit-e2e-matrix.mjs"), "utf8");
  const docs = readFileSync(join(ROOT, "docs", "routekit-e2e-matrix.md"), "utf8");
  assert.match(script, /ROUTEKIT_E2E_MAX_LIVE_CALLS \?\? 48/);
  assert.match(docs, /default hard limit is 48 client-to-RouteKit model requests/);
});
