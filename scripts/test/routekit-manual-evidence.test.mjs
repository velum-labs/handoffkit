import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  loadEvidenceMap,
  mappingDigest,
  promoteMatrixResults,
  routeIdsForCase
} from "../lib/routekit-l06-evidence.mjs";
import {
  applyReviewedManualRecords,
  createCursorIdeAttestation,
  deriveReviewedManualRecords,
  validateReviewedManualRecords
} from "../lib/routekit-manual-evidence.mjs";
import {
  prepareCursorAuthentication,
  snapshotCursorState,
  stageCursorState
} from "../lib/routekit-cursor-state.mjs";
import {
  cursorAuthTmuxSessionArgs,
  ensureTmuxCursorAuthUpdate,
  tmuxClientEnvironment
} from "../lib/routekit-tmux-auth.mjs";
import {
  loopbackGatewayTarget,
  proxyRequestPath,
  runActiveCursorIdeAttestation
} from "../lib/routekit-cursor-attestation-runner.mjs";
import { routeById } from "../routekit-qualification.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const mapping = loadEvidenceMap(ROOT);
const source = JSON.parse(
  readFileSync(join(ROOT, "spec", "routekit", "l06-evidence.json"), "utf8")
);
const REVISION = "1".repeat(40);

test("Cursor attestation proxy accepts only relative requests to literal loopback", () => {
  assert.equal(
    loopbackGatewayTarget("http://127.0.0.1:43123").origin,
    "http://127.0.0.1:43123"
  );
  for (const target of [
    "https://127.0.0.1:43123",
    "http://localhost:43123",
    "http://example.com:43123",
    "http://127.0.0.1",
    "http://127.0.0.1:43123/v1",
    "http://user:password@127.0.0.1:43123"
  ]) {
    assert.throws(() => loopbackGatewayTarget(target));
  }
  assert.equal(proxyRequestPath("/v1/models?limit=1"), "/v1/models?limit=1");
  for (const target of [
    "http://example.com/v1/models",
    "//example.com/v1/models"
  ]) {
    assert.throws(() => proxyRequestPath(target), /must be relative/);
  }
});

function result(caseId, overrides = {}) {
  const [phase, providerPart, door] = caseId.split(".");
  const provider = providerPart === "shared" ? null : providerPart;
  const identity = { phase, provider, door };
  return {
    caseId,
    routeIds: routeIdsForCase(mapping, identity),
    ...identity,
    routeId: null,
    status: "pass",
    reasonCode: "qualified",
    durationMs: 10,
    gatewayRequests: phase === "live" && door !== "pool" ? 1 : 0,
    artifact: null,
    model: phase === "live" ? `${provider}/test-model` : null,
    setupRestore: null,
    ...overrides
  };
}

function qualification(routeId, overrides = {}) {
  const route = routeById(routeId);
  const clientVersions = {
    "route-codex-subscription": "codex 1.2.3",
    "route-claude-code-subscription": "claude 4.5.6",
    "route-cursor-agent": "cursor-agent 7.8.9"
  };
  const model = {
    "route-codex-subscription": "codex/gpt-test",
    "route-claude-code-subscription": "claude-code/claude-test",
    "route-cursor-agent": "openrouter/test-model",
    "route-openai-api": "openai/gpt-test"
  }[routeId];
  const manual = route.manualEvidenceRequired === true;
  return {
    routeId,
    status: manual ? "fail" : "pass",
    reasonCode: manual ? "manual-evidence-unavailable" : "qualified",
    durationMs: 20,
    provider: {
      id: route.provider,
      model,
      apiRevision: "not-advertised",
      egressHost: route.egressHost,
      aggregator: route.aggregator
    },
    credential: {
      mode: route.credentialMode,
      reference: route.credentialReference,
      available: true
    },
    client: {
      id: route.client,
      version: clientVersions[routeId] ?? "0.8.0",
      integrationMode: route.door
    },
    protocol: {
      door: route.door,
      path: route.protocolPath,
      streaming: "pass",
      tools: "pass",
      reasoning: routeId.startsWith("route-cursor-") ? "degraded" : "pass"
    },
    behavior: {
      cancellation: "pass",
      failurePropagation: "pass",
      routekitFallback: "none",
      providerManagedRouting:
        route.aggregator ? "openrouter-upstream-routing" : "not-applicable"
    },
    billing: {
      mode: route.billingMode,
      attributionBasis: "namespaced-route-success",
      gatewayRequestsObserved: 1
    },
    setupRestore: {
      expectation: route.setupRestore,
      setup: route.setupRestore === "required" ? "pass" : "not-applicable",
      restore: route.setupRestore === "required" ? "pass" : "not-applicable"
    },
    evidence: ["trusted-matrix-case"],
    ...overrides
  };
}

function matrixReport() {
  const caseIds = [
    "deterministic.shared.cancellation",
    "deterministic.openai.openai-chat",
    "deterministic.openai.failure-no-fallback-openai-chat",
    "deterministic.openai.tools-reasoning-openai-chat",
    "live.openai.openai-chat",
    "deterministic.codex.codex-responses",
    "deterministic.codex.codex",
    "deterministic.codex.failure-no-fallback-codex-responses",
    "deterministic.codex.tools-reasoning-codex-responses",
    "live.codex.codex-responses",
    "live.codex.codex",
    "deterministic.claude-code.anthropic-messages",
    "deterministic.claude-code.anthropic-thinking",
    "deterministic.claude-code.claude",
    "deterministic.claude-code.failure-no-fallback-anthropic-messages",
    "deterministic.claude-code.tools-reasoning-anthropic-messages",
    "live.claude-code.anthropic-messages",
    "live.claude-code.claude",
    "live.claude-code.pool",
    "deterministic.openrouter.cursor",
    "deterministic.openrouter.failure-no-fallback-openai-chat",
    "deterministic.openrouter.tools-reasoning-openai-chat",
    "live.openrouter.cursor"
  ];
  const results = caseIds.map((caseId) => result(caseId));
  for (const entry of results.filter(
    (candidate) =>
      candidate.phase === "live" &&
      ["codex", "claude-code", "openrouter"].includes(candidate.provider)
  )) {
    entry.setupRestore = {
      setup: "pass",
      restore: "pass",
      ...(entry.caseId === "live.openrouter.cursor"
        ? {
            evidence: {
              authSource: "env-key",
              unchanged: true
            }
          }
        : {})
    };
  }
  const caseCounts = {
    pass: results.length,
    fail: 0,
    skip: 0
  };
  const routeIds = [
    "route-openai-api",
    "route-codex-subscription",
    "route-claude-code-subscription",
    "route-cursor-ide",
    "route-cursor-agent"
  ];
  return {
    schemaVersion: 4,
    routekitVersion: "0.8.0",
    evidenceMappingSchemaVersion: mapping.schemaVersion,
    evidenceMappingDigest: mappingDigest(mapping),
    sourceRevision: REVISION,
    sourceDirty: false,
    startedAt: "2026-07-23T07:00:00.000Z",
    finishedAt: "2026-07-23T07:10:00.000Z",
    metadata: {
      routekitVersion: "0.8.0",
      routekitGitSha: REVISION,
      gitDirty: false,
      nodeVersion: "v22.22.2",
      platform: "darwin",
      architecture: "arm64",
      clients: {
        claude: "claude 4.5.6",
        codex: "codex 1.2.3",
        cursorAgent: "cursor-agent 7.8.9",
        cursorIde: "Cursor 9.9.9"
      }
    },
    liveAuthorized: true,
    filters: {
      routes: routeIds,
      providers: ["openai", "codex", "claude-code", "openrouter"],
      doors: ["openai-chat", "codex-responses", "codex", "anthropic-messages", "claude", "pool", "cursor"],
      timeoutMs: 120000,
      maxLiveCalls: 8
    },
    summary: {
      status: "fail",
      caseCounts,
      topLevelFailures: 0,
      routeCounts: { pass: 1, fail: 4 }
    },
    liveGatewayRequestsObserved: 6,
    results,
    qualification: {
      status: "fail",
      completeness: {
        complete: true,
        allPassed: false,
        expectedRouteIds: routeIds,
        missingRouteIds: [],
        duplicateRouteIds: [],
        failedRouteIds: routeIds.slice(1)
      },
      budget: {
        authorizedMaximum: 8,
        plannedMaximum: 8,
        gatewayRequestsObserved: 6,
        remaining: 2,
        exhausted: false
      },
      routes: routeIds.map((routeId) => qualification(routeId))
    },
    topLevelError: null
  };
}

function cursorLiveCase(report) {
  return report.results.find(
    (entry) => entry.caseId === "live.openrouter.cursor"
  );
}

function cursorkitSummary(overrides = {}) {
  return {
    status: "passed",
    results: [
      {
        id: "desktop-ui-experimental",
        suite: "desktop-ui-experimental",
        status: "passed",
        durationMs: 100,
        message: "machine result",
        details: {
          ckProfileMode: "isolated-seeded-from-default",
          signInRequired: false,
          workspaceOpened: true,
          composerVisible: true,
          modelPickerOpened: true,
          modelTextSeen: true,
          selectedModelTextSeen: true,
          desktopPromptSubmitted: true,
          desktopProbeTextSeen: true,
          desktopModelErrorSeen: false,
          modelBackendRequestSeen: true,
          modelBackendResponseComplete: true,
          cursorToolResultSeen: true,
          requiredCursorToolResultsSeen: true,
          localModelSeedStatus: "seeded",
          ...overrides
        }
      }
    ]
  };
}

function cursorMeasurements(overrides = {}) {
  const snapshot = { count: 1, digest: "a".repeat(64) };
  return {
    gateway: {
      requestsObserved: 1,
      attemptsObserved: 1,
      maxAllowed: 1,
      overBudget: false,
      modelMatched: true,
      ...(overrides.gateway ?? {})
    },
    defaultProfileState: {
      before: snapshot,
      after: { ...snapshot },
      unchanged: true,
      ...(overrides.defaultProfileState ?? {})
    },
    isolatedProfileRemoved: true,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => !["gateway", "defaultProfileState"].includes(key)
      )
    )
  };
}

test("reviewed records are a fixed projection of passing machine artifacts", () => {
  const report = matrixReport();
  const records = deriveReviewedManualRecords(mapping, report, { revision: REVISION });
  assert.deepEqual(Object.keys(records.routes), [
    "route-codex-subscription",
    "route-claude-code-subscription",
    "route-cursor-agent"
  ]);
  assert.ok(
    Object.values(records.routes).every(
      (route) =>
        route.qualificationStatus === "qualified" &&
        route.evidence.every((evidence) => evidence.status === "pass")
    )
  );
  validateReviewedManualRecords(mapping, report, records);
  const promoted = promoteMatrixResults(mapping, source, report, REVISION);
  const applied = applyReviewedManualRecords(
    mapping,
    promoted,
    report,
    records
  );
  assert.equal(
    applied.routes["route-codex-subscription"].qualificationStatus,
    "qualified"
  );

  const attestation = createCursorIdeAttestation(
    mapping,
    report,
    cursorkitSummary(),
    "Cursor 9.9.9",
    cursorMeasurements(),
    REVISION
  );
  const withCursor = deriveReviewedManualRecords(mapping, report, {
    revision: REVISION,
    cursorIdeAttestation: attestation
  });
  assert.equal(withCursor.routes["route-cursor-ide"].qualificationStatus, "qualified");
  assert.equal(attestation.observations.model, "openai/gpt-test");
  assert.equal(attestation.observations.gateway.requestsObserved, 1);
  assert.equal(attestation.observations.protocol.reasoning, "degraded");
  assert.equal(
    attestation.observations.behavior.sourceCases.cancellation,
    "deterministic.shared.cancellation"
  );
});

test("cursor reviewed credential mode derives only the safe auth-source enum", () => {
  for (const authSource of ["env-key", "staged-config"]) {
    const report = matrixReport();
    cursorLiveCase(report).setupRestore.evidence.authSource = authSource;
    const records = deriveReviewedManualRecords(mapping, report, {
      revision: REVISION
    });
    const cursorRecord = records.routes["route-cursor-agent"];
    assert.equal(
      cursorRecord.credentialMode,
      `Authenticated cursor-agent using ${authSource}.`
    );
    assert.equal(
      JSON.stringify(cursorRecord).includes('"authSource"'),
      false
    );
    assert.equal(JSON.stringify(cursorRecord).includes('"unchanged"'), false);
  }
});

test("cursor reviewed evidence rejects absent, unknown, changed, and forged auth sources", () => {
  for (const [label, mutate, expected] of [
    [
      "missing evidence",
      (entry) => delete entry.setupRestore.evidence,
      /setup\/restore has untrusted fields/
    ],
    [
      "missing source",
      (entry) => delete entry.setupRestore.evidence.authSource,
      /auth evidence has untrusted fields/
    ],
    [
      "unknown source",
      (entry) => {
        entry.setupRestore.evidence.authSource = "none";
      },
      /absent or unknown auth source/
    ],
    [
      "changed source state",
      (entry) => {
        entry.setupRestore.evidence.unchanged = false;
      },
      /auth source state changed/
    ],
    [
      "forged private fields",
      (entry) => {
        entry.setupRestore.evidence.path = "/private/cursor-config";
        entry.setupRestore.evidence.digest = "a".repeat(64);
        entry.setupRestore.evidence.tokenValue = "forged-value";
      },
      /auth evidence has untrusted fields|secret field/
    ]
  ]) {
    const report = matrixReport();
    mutate(cursorLiveCase(report));
    assert.throws(
      () =>
        deriveReviewedManualRecords(mapping, report, {
          revision: REVISION
        }),
      expected,
      label
    );
  }
});

test("stale, dirty, and forged mappings fail closed", () => {
  assert.throws(
    () => deriveReviewedManualRecords(mapping, matrixReport(), { revision: "2".repeat(40) }),
    /must equal the matrix source revision/
  );
  const dirty = matrixReport();
  dirty.sourceDirty = true;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, dirty, { revision: REVISION }),
    /dirty-worktree/
  );
  const forged = matrixReport();
  forged.evidenceMappingDigest = "f".repeat(64);
  assert.throws(
    () => deriveReviewedManualRecords(mapping, forged, { revision: REVISION }),
    /stale L05 mapping/
  );
});

test("missing and failed required cases cannot generate records", () => {
  const missing = matrixReport();
  missing.results = missing.results.filter(
    (entry) => entry.caseId !== "live.codex.codex"
  );
  missing.summary.caseCounts.pass -= 1;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, missing, { revision: REVISION }),
    /required matrix case live\.codex\.codex is missing/
  );

  const failed = matrixReport();
  failed.results.find(
    (entry) => entry.caseId === "deterministic.claude-code.anthropic-thinking"
  ).status = "fail";
  failed.summary.caseCounts.pass -= 1;
  failed.summary.caseCounts.fail += 1;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, failed, { revision: REVISION }),
    /did not pass/
  );
});

test("credentials, unavailable versions, and arbitrary Pass claims are rejected", () => {
  const credential = matrixReport();
  credential.metadata.injected = { token: "sk-secret-value" };
  assert.throws(
    () => deriveReviewedManualRecords(mapping, credential, { revision: REVISION }),
    /secret field|credential-shaped/
  );

  const unavailable = matrixReport();
  unavailable.metadata.clients.codex = "unavailable";
  unavailable.qualification.routes.find(
    (route) => route.routeId === "route-codex-subscription"
  ).client.version = "unavailable";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, unavailable, { revision: REVISION }),
    /client version is unavailable/
  );

  const report = matrixReport();
  const attestation = createCursorIdeAttestation(
    mapping,
    report,
    cursorkitSummary(),
    "Cursor 9.9.9",
    cursorMeasurements(),
    REVISION
  );
  attestation.claim = "Pass because a reviewer said so";
  assert.throws(
    () =>
      deriveReviewedManualRecords(mapping, report, {
        revision: REVISION,
        cursorIdeAttestation: attestation
      }),
    /untrusted fields/
  );
});

test("zero and over-budget gateway observations are rejected", () => {
  const zero = matrixReport();
  zero.qualification.routes.find(
    (route) => route.routeId === "route-cursor-agent"
  ).billing.gatewayRequestsObserved = 0;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, zero, { revision: REVISION }),
    /zero or over-budget/
  );

  const over = matrixReport();
  over.liveGatewayRequestsObserved = 9;
  over.qualification.budget.gatewayRequestsObserved = 9;
  assert.throws(
    () => deriveReviewedManualRecords(mapping, over, { revision: REVISION }),
    /exceed the authorized budget/
  );

  const report = matrixReport();
  for (const count of [0, 2]) {
    const measurements = cursorMeasurements({
      gateway: {
        requestsObserved: count,
        attemptsObserved: count
      }
    });
    assert.throws(
      () =>
        createCursorIdeAttestation(
          mapping,
          report,
          cursorkitSummary(),
          "Cursor 9.9.9",
          measurements,
          REVISION
        ),
      /zero model calls|exceeded the route budget/
    );
  }
});

test("failed Cursor desktop harness and setup/restore cannot attest", () => {
  const report = matrixReport();
  const failedHarness = cursorkitSummary();
  failedHarness.status = "failed";
  failedHarness.results[0].status = "failed";
  assert.throws(
    () =>
      createCursorIdeAttestation(
        mapping,
        report,
        failedHarness,
        "Cursor 9.9.9",
        cursorMeasurements(),
        REVISION
      ),
    /summary did not pass/
  );
  assert.throws(
    () =>
      createCursorIdeAttestation(
        mapping,
        report,
        cursorkitSummary({ requiredCursorToolResultsSeen: false }),
        "Cursor 9.9.9",
        cursorMeasurements(),
        REVISION
      ),
    /desktop tools failed/
  );
  assert.throws(
    () =>
      createCursorIdeAttestation(
        mapping,
        report,
        cursorkitSummary({ localModelSeedStatus: "state-missing" }),
        "Cursor 9.9.9",
        cursorMeasurements(),
        REVISION
      ),
    /isolated profile setup failed/
  );
  const restoreFailed = matrixReport();
  restoreFailed.qualification.routes.find(
    (route) => route.routeId === "route-cursor-agent"
  ).setupRestore.restore = "fail";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, restoreFailed, { revision: REVISION }),
    /restore failed/
  );

  const protocolFailed = matrixReport();
  protocolFailed.qualification.routes.find(
    (route) => route.routeId === "route-codex-subscription"
  ).protocol.tools = "fail";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, protocolFailed, { revision: REVISION }),
    /tools failed/
  );

  const behaviorFailed = matrixReport();
  behaviorFailed.qualification.routes.find(
    (route) => route.routeId === "route-claude-code-subscription"
  ).behavior.routekitFallback = "unverified";
  assert.throws(
    () => deriveReviewedManualRecords(mapping, behaviorFailed, { revision: REVISION }),
    /fallback was observed/
  );
});

async function startAttestationUpstream() {
  const authorizations = [];
  const server = createServer((request, response) => {
    void (async () => {
      authorizations.push(request.headers.authorization);
      for await (const _chunk of request) {
        // Consume without retaining request content.
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.url === "/v1/models"
          ? JSON.stringify({ data: [{ id: "openai/gpt-test" }] })
          : JSON.stringify({ choices: [{ message: { content: "ok" } }] })
      );
    })();
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen)
  );
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    authorizations,
    close: async () =>
      await new Promise((resolveClose) => server.close(resolveClose))
  };
}

function createDefaultProfile(root) {
  const profile = join(root, "profile");
  const storage = join(profile, "User", "globalStorage");
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, "state.vscdb"), "machine-profile-state");
  return profile;
}

async function runMeasuredAttestation(input = {}) {
  const root = mkdtempSync(join(tmpdir(), "routekit-active-attestation-test-"));
  const upstream = await startAttestationUpstream();
  const profileDirectory = createDefaultProfile(root);
  const activeTemporaryRoot = join(root, "active-run");
  mkdirSync(activeTemporaryRoot);
  let runCalled = false;
  try {
    const attestation = await runActiveCursorIdeAttestation(
      {
        root: ROOT,
        mapping,
        report: input.report ?? matrixReport(),
        revision: input.revision ?? REVISION,
        gatewayUrl: upstream.url,
        authToken: "test-upstream-token",
        timeoutMs: 1_000,
        profileDirectory
      },
      {
        cursorVersion: () => "Cursor 9.9.9",
        makeTemporaryRoot: () => activeTemporaryRoot,
        runHarness: async ({ proxyUrl, model }) => {
          runCalled = true;
          if (input.mutateState) {
            writeFileSync(
              join(profileDirectory, "User", "globalStorage", "state.vscdb"),
              "mutated-machine-profile-state"
            );
          }
          if (input.childFailure) throw new Error("mock harness child failed");
          for (let index = 0; index < (input.calls ?? 1); index += 1) {
            await fetch(`${proxyUrl}/v1/chat/completions`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer routekit-attestation-local`
              },
              body: JSON.stringify({ model })
            });
          }
          const summary = cursorkitSummary();
          if (input.failedHarness) {
            summary.status = "failed";
            summary.results[0].status = "failed";
          }
          return summary;
        }
      }
    );
    return { attestation, upstream, runCalled };
  } catch (error) {
    error.runCalled = runCalled;
    error.isolatedRemoved = !existsSync(activeTemporaryRoot);
    throw error;
  } finally {
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("active Cursor wrapper measures one authenticated gateway call", async () => {
  const { attestation, upstream } = await runMeasuredAttestation();
  assert.equal(attestation.observations.gateway.requestsObserved, 1);
  assert.equal(attestation.observations.gateway.attemptsObserved, 1);
  assert.equal(attestation.observations.setupRestore.restore, "pass");
  assert.ok(
    upstream.authorizations.every(
      (authorization) => authorization === "Bearer test-upstream-token"
    )
  );
  assert.doesNotMatch(
    JSON.stringify(attestation),
    /test-upstream-token|state\.vscdb|settings\.json/
  );
});

test("active Cursor wrapper fails on zero, over-budget, state, harness, and child failures", async () => {
  await assert.rejects(
    runMeasuredAttestation({ calls: 0 }),
    /observed zero model calls/
  );
  await assert.rejects(
    runMeasuredAttestation({ calls: 2 }),
    /over-budget model-call attempt/
  );
  await assert.rejects(
    runMeasuredAttestation({ mutateState: true }),
    /default-profile state changed/
  );
  await assert.rejects(
    runMeasuredAttestation({ failedHarness: true }),
    /summary did not pass/
  );
  await assert.rejects(
    runMeasuredAttestation({ childFailure: true }),
    (error) => {
      assert.match(error.message, /mock harness child failed/);
      assert.equal(error.isolatedRemoved, true);
      return true;
    }
  );
  await assert.rejects(
    runMeasuredAttestation({ revision: "2".repeat(40) }),
    (error) => {
      assert.match(error.message, /must equal the matrix source revision/);
      assert.equal(error.runCalled, false);
      return true;
    }
  );
});

test("Cursor state snapshots expose only aggregate hashes and detect mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-cursor-state-test-"));
  try {
    const source = join(root, "source");
    const stagedDirectory = join(root, "staged");
    mkdirSync(source);
    writeFileSync(join(source, "cli-config.json"), '{"auth":"private"}\n');
    const before = snapshotCursorState(source);
    assert.deepEqual(Object.keys(before), ["count", "digest"]);
    assert.equal(before.count, 1);
    assert.equal(before.digest.length, 64);
    assert.doesNotMatch(JSON.stringify(before), /cli-config|private/);

    const staged = stageCursorState(source, stagedDirectory);
    assert.equal(staged.stagedCount, 1);
    assert.equal(readFileSync(join(stagedDirectory, "cli-config.json"), "utf8"), '{"auth":"private"}\n');
    assert.equal(staged.verify().unchanged, true);
    writeFileSync(join(source, "cli-config.json"), '{"auth":"mutated"}\n');
    assert.equal(staged.verify().unchanged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor authentication supports env keys, staged config, and absent auth safely", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-cursor-auth-test-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    writeFileSync(join(source, "cli-config.json"), '{"auth":"private"}\n');

    const envKey = prepareCursorAuthentication(
      source,
      join(root, "env-staged"),
      { CURSOR_API_KEY: "cursor-test-key" }
    );
    assert.equal(envKey.authSource, "env-key");
    assert.equal(envKey.directory, undefined);
    assert.deepEqual(envKey.verify(), {
      authSource: "env-key",
      unchanged: true
    });

    const staged = prepareCursorAuthentication(
      source,
      join(root, "config-staged"),
      {}
    );
    assert.equal(staged.authSource, "staged-config");
    assert.equal(
      readFileSync(join(staged.directory, "cli-config.json"), "utf8"),
      '{"auth":"private"}\n'
    );
    const stagedEvidence = staged.verify();
    assert.deepEqual(stagedEvidence, {
      authSource: "staged-config",
      unchanged: true
    });
    assert.deepEqual(Object.keys(stagedEvidence), ["authSource", "unchanged"]);
    assert.doesNotMatch(
      JSON.stringify(stagedEvidence),
      /private|digest|directory|[/\\]/
    );

    const emptySource = join(root, "empty-source");
    mkdirSync(emptySource);
    const absent = prepareCursorAuthentication(
      emptySource,
      join(root, "empty-staged"),
      {}
    );
    assert.equal(absent.authSource, "none");
    assert.equal(absent.directory, undefined);
    assert.deepEqual(absent.verify(), {
      authSource: "none",
      unchanged: true
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const tmuxAvailable =
  spawnSync("tmux", ["-V"], {
    stdio: "ignore",
    timeout: 15_000
  }).status === 0;

test(
  "Cursor auth forwarding refreshes stale tmux state and clears absent auth",
  { skip: !tmuxAvailable },
  () => {
    const root = mkdtempSync(join(tmpdir(), "routekit-tmux-auth-test-"));
    const socket = `routekit-auth-test-${process.pid}-${Date.now()}`;
    const child = join(root, "observe-auth.cjs");
    writeFileSync(
      child,
      [
        'const { spawnSync } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        "const state = process.env.CURSOR_API_KEY === 'cursor-test-fresh'",
        "  ? 'env-key'",
        "  : process.env.CURSOR_API_KEY ? 'unexpected' : 'none';",
        "writeFileSync(process.env.RESULT_PATH, state);",
        `spawnSync("tmux", ["-L", ${JSON.stringify(socket)}, "wait-for", "-S", process.env.WAIT_CHANNEL]);`
      ].join("\n")
    );
    const runWith = (env) => (...args) =>
      spawnSync("tmux", ["-L", socket, ...args], {
        encoding: "utf8",
        timeout: 15_000,
        env: tmuxClientEnvironment(env)
      });
    const stale = runWith({
      ...process.env,
      CURSOR_API_KEY: "cursor-test-stale"
    });
    const fresh = runWith({
      ...process.env,
      CURSOR_API_KEY: "cursor-test-fresh"
    });
    const absentEnv = {
      ...process.env,
      CURSOR_API_KEY: undefined,
      UNRELATED_SECRET: "must-not-leak"
    };
    const absent = runWith(absentEnv);
    try {
      const noServerSocket = `${socket}-unused`;
      const noServer = (...args) =>
        spawnSync("tmux", ["-L", noServerSocket, ...args], {
          encoding: "utf8",
          timeout: 15_000,
          env: tmuxClientEnvironment(absentEnv)
        });
      assert.doesNotThrow(() => ensureTmuxCursorAuthUpdate(noServer));
      assert.equal(
        stale("new-session", "-d", "-s", "seed", "sleep", "30").status,
        0
      );
      ensureTmuxCursorAuthUpdate(fresh);

      for (const [label, run, expected] of [
        ["fresh", fresh, "env-key"],
        ["absent", absent, "none"]
      ]) {
        const resultPath = join(root, `${label}.txt`);
        const channel = `${socket}-${label}`;
        const args = [
          "new-session",
          "-d",
          "-s",
          label,
          ...cursorAuthTmuxSessionArgs(),
          "-e",
          `RESULT_PATH=${resultPath}`,
          "-e",
          `WAIT_CHANNEL=${channel}`,
          "--",
          process.execPath,
          child
        ];
        assert.doesNotMatch(args.join(" "), /cursor-test-(?:fresh|stale)/);
        assert.equal(run(...args).status, 0);
        assert.equal(run("wait-for", channel).status, 0);
        assert.equal(readFileSync(resultPath, "utf8"), expected);
      }
      assert.equal(tmuxClientEnvironment(absentEnv).UNRELATED_SECRET, undefined);
      assert.equal(tmuxClientEnvironment({ CURSOR_API_KEY: "" }).CURSOR_API_KEY, undefined);
    } finally {
      stale("kill-server");
      rmSync(root, { recursive: true, force: true });
    }
  }
);

const cursorAgentAvailable =
  spawnSync("cursor-agent", ["--version"], {
    stdio: "ignore",
    timeout: 15_000
  }).status === 0;

test(
  "official cursor-agent status honors CURSOR_CONFIG_DIR isolation",
  { skip: !cursorAgentAvailable },
  () => {
    const isolated = mkdtempSync(join(tmpdir(), "routekit-cursor-config-contract-"));
    try {
      const status = spawnSync("cursor-agent", ["status"], {
        env: { ...process.env, CURSOR_CONFIG_DIR: isolated },
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"]
      });
      const output = `${status.stdout}\n${status.stderr}`;
      assert.equal(
        /not logged|not authenticated|log in|login/i.test(output),
        true,
        "cursor-agent did not report isolated unauthenticated state"
      );
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  }
);

test("manual-record CLI writes only the caller path and does not echo artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-manual-cli-test-"));
  try {
    const reportPath = join(root, "report.json");
    const outputPath = join(root, "records.json");
    writeFileSync(reportPath, JSON.stringify(matrixReport()));
    const generated = spawnSync(
      process.execPath,
      [
        join(ROOT, "scripts", "generate-routekit-manual-records.mjs"),
        "--matrix-report",
        reportPath,
        "--revision",
        REVISION,
        "--output",
        outputPath
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(generated.status, 0, generated.stderr);
    assert.match(generated.stdout, /^WROTE /);
    assert.doesNotMatch(generated.stdout, /machine result|credentialMode|\{"schemaVersion"/);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).schemaVersion, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
