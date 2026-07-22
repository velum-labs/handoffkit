import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  caseIdFor,
  durableEvidence,
  loadEvidenceMap,
  mappingDigest,
  promoteMatrixResults,
  routeIdsForCase,
  validateEvidence
} from "../lib/routekit-l06-evidence.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const mapping = loadEvidenceMap(ROOT);
const source = JSON.parse(
  readFileSync(join(ROOT, "spec", "routekit", "l06-evidence.json"), "utf8")
);

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
});

test("matrix promotion updates only exact mapped cases", () => {
  const promoted = promoteMatrixResults(
    mapping,
    source,
    {
      schemaVersion: 2,
      routekitVersion: "0.8.0",
      evidenceMappingDigest: mappingDigest(mapping),
      finishedAt: "2026-07-22T20:00:00.000Z",
      results: [
        {
          caseId: "deterministic.openai.openai-chat",
          routeIds: ["route-openai-api"],
          phase: "deterministic",
          provider: "openai",
          door: "openai-chat",
          status: "pass",
          reason: null,
          durationMs: 10,
          billedCalls: 0,
          artifact: null
        }
      ]
    },
    "ec72b7cb208059ca45e105552b49530d761ea203"
  );
  const openAi = promoted.routes["route-openai-api"].evidence;
  assert.equal(
    openAi.find((item) => item.caseId === "deterministic.openai.openai-chat").status,
    "pass"
  );
  assert.equal(
    openAi.find((item) => item.caseId === "live.openai.openai-chat").status,
    "pending"
  );
});
