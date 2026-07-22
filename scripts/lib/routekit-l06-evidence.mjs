import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const EVIDENCE_DIMENSIONS = [
  "protocolBehavior",
  "billingAttribution",
  "failureBehavior",
  "setupRestore"
];

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])])
    );
  }
  return value;
}

export function mappingDigest(mapping) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(mapping)))
    .digest("hex");
}

export function loadEvidenceMap(root) {
  return JSON.parse(
    readFileSync(join(root, "spec", "routekit", "l06-evidence-map.json"), "utf8")
  );
}

export function caseIdFor({ phase, provider, door }) {
  return [phase, provider ?? "shared", door].join(".");
}

export function routeIdsForCase(mapping, { provider, door }) {
  if (mapping.excludedDoors.includes(door)) return [];
  const ids = [];
  if (provider === undefined || provider === null) {
    ids.push(...(mapping.specialCaseRouteIds[door] ?? []));
  } else {
    const providerRouteId = mapping.providerRouteIds[provider];
    if (providerRouteId !== undefined) ids.push(providerRouteId);
  }
  ids.push(...(mapping.doorRouteIds[door] ?? []));
  return [...new Set(ids)];
}

export function assertSanitized(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    /Bearer\s+(?!\[REDACTED\])\S+/i,
    /(?:authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*(?!\[REDACTED\])\S+/i,
    /\bsk-[A-Za-z0-9_-]{8,}\b/,
    /\b(?:sess|sk-ant)-[A-Za-z0-9_-]{8,}\b/
  ]) {
    assert.doesNotMatch(serialized, forbidden, "L06 evidence contains credential-shaped data");
  }
}

export function validateEvidence(mapping, source) {
  assert.equal(mapping.schemaVersion, 1, "unsupported L06 mapping schema");
  assert.equal(source.schemaVersion, 1, "unsupported L06 evidence schema");
  assert.match(source.testedRevision, /^[0-9a-f]{40}$/, "testedRevision must be a full SHA");
  assert.match(source.evidenceDate, /^20\d{2}-\d{2}-\d{2}$/, "evidenceDate must be ISO-8601");
  assert.ok(typeof source.routekitVersion === "string" && source.routekitVersion.length > 0);

  const expectedIds = mapping.routes.map((route) => route.id);
  assert.deepEqual(
    Object.keys(source.routes),
    expectedIds,
    "L06 evidence routes must exactly match the stable mapping order"
  );
  for (const route of mapping.routes) {
    const evidence = source.routes[route.id];
    assert.equal(evidence.title, route.title, `${route.id} title drifted`);
    assert.ok(
      ["pending", "qualified", "failed"].includes(evidence.qualificationStatus),
      `${route.id} has invalid qualificationStatus`
    );
    for (const field of ["credentialMode", "clientProviderVersion"]) {
      assert.ok(
        typeof evidence[field] === "string" && evidence[field].trim().length > 0,
        `${route.id} is missing ${field}`
      );
    }
    for (const dimension of EVIDENCE_DIMENSIONS) {
      const outcome = evidence.outcomes[dimension];
      assert.ok(outcome !== undefined, `${route.id} is missing ${dimension}`);
      assert.ok(
        ["pending", "pass", "fail", "not-applicable"].includes(outcome.status),
        `${route.id} has invalid ${dimension} status`
      );
      assert.ok(
        typeof outcome.summary === "string" && outcome.summary.trim().length > 0,
        `${route.id} is missing ${dimension} summary`
      );
    }
    assert.ok(Array.isArray(evidence.evidence) && evidence.evidence.length > 0);
    const caseIds = new Set();
    for (const item of evidence.evidence) {
      assert.ok(["automated", "manual"].includes(item.type), `${route.id} evidence type`);
      assert.ok(["pending", "pass", "fail"].includes(item.status), `${route.id} evidence status`);
      assert.ok(
        typeof item.reference === "string" && item.reference.trim().length > 0,
        `${route.id} has evidence without a reference`
      );
      if (item.caseId !== undefined) caseIds.add(item.caseId);
    }
    for (const caseId of route.requiredCaseIds) {
      assert.ok(caseIds.has(caseId), `${route.id} is missing required case ${caseId}`);
    }
    if (route.manualEvidenceRequired) {
      assert.ok(
        evidence.evidence.some((item) => item.type === "manual"),
        `${route.id} requires manual evidence`
      );
    }
    if (evidence.qualificationStatus === "qualified") {
      assert.ok(
        evidence.evidence.every((item) => item.status === "pass") &&
          EVIDENCE_DIMENSIONS.every((dimension) =>
            ["pass", "not-applicable"].includes(evidence.outcomes[dimension].status)
          ),
        `${route.id} cannot be qualified while evidence is pending or failed`
      );
    }
  }
  assertSanitized(source);
}

export function durableEvidence(mapping, source) {
  validateEvidence(mapping, source);
  return {
    ...source,
    mappingSchemaVersion: mapping.schemaVersion,
    mappingDigest: mappingDigest(mapping)
  };
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderEvidenceMarkdown(mapping, source) {
  const report = durableEvidence(mapping, source);
  const lines = [
    "<!-- Generated by scripts/generate-routekit-l06-evidence.mjs. Do not edit. -->",
    "",
    "# RouteKit L06 qualification evidence",
    "",
    "Audience: maintainers reviewing the first-launch RouteKit support contract.",
    "",
    `- **RouteKit version:** ${report.routekitVersion}`,
    `- **Tested revision:** [\`${report.testedRevision}\`](https://github.com/velum-labs/handoffkit/commit/${report.testedRevision})`,
    `- **Evidence date:** ${report.evidenceDate}`,
    `- **Mapping schema:** ${report.mappingSchemaVersion}`,
    `- **Mapping digest:** \`${report.mappingDigest}\``,
    "",
    "A `pending` or `failed` row is not publicly Supported. Raw credentials and",
    "prompts are intentionally excluded; case summaries below are the durable,",
    "sanitized record.",
    ""
  ];
  for (const route of mapping.routes) {
    const row = report.routes[route.id];
    lines.push(
      `<a id="${route.id}"></a>`,
      "",
      `## ${route.title}`,
      "",
      `- **Qualification:** ${row.qualificationStatus}`,
      `- **Credential/account mode:** ${row.credentialMode}`,
      `- **Client/provider version:** ${row.clientProviderVersion}`,
      "",
      "| Evidence | Type | Status | Reference | Result details |",
      "| --- | --- | --- | --- | --- |",
      ...row.evidence.map(
        (item) => {
          const result =
            item.result === undefined
              ? item.summary ?? "—"
              : `${item.result.phase}/${item.result.provider ?? "shared"}/${item.result.door}; ${item.result.durationMs} ms; ${item.result.billedCalls} billed calls${item.result.artifact === null ? "" : `; ${item.result.artifact}`}`;
          return `| ${escapeCell(item.caseId ?? item.label)} | ${item.type} | ${item.status} | ${escapeCell(item.reference)} | ${escapeCell(result)} |`;
        }
      ),
      "",
      "| Required outcome | Status | Sanitized result |",
      "| --- | --- | --- |",
      ...EVIDENCE_DIMENSIONS.map((dimension) => {
        const outcome = row.outcomes[dimension];
        return `| ${dimension} | ${outcome.status} | ${escapeCell(outcome.summary)} |`;
      }),
      ""
    );
  }
  lines.push(
    "## Excluded from launch qualification",
    "",
    `The mapping deliberately excludes: ${mapping.excludedRouteNames.map((name) => `\`${name}\``).join(", ")}.`,
    ""
  );
  return `${lines.join("\n")}\n`;
}

export function promoteMatrixResults(mapping, source, matrixReport, revision) {
  assert.equal(matrixReport.schemaVersion, 2, "matrix report must use schemaVersion 2");
  assert.equal(
    matrixReport.evidenceMappingDigest,
    mappingDigest(mapping),
    "matrix report was produced with a stale L05 mapping"
  );
  assert.match(revision, /^[0-9a-f]{40}$/, "promotion revision must be a full SHA");
  assertSanitized(matrixReport);
  const next = structuredClone(source);
  next.testedRevision = revision;
  next.routekitVersion = matrixReport.routekitVersion;
  next.evidenceDate = matrixReport.finishedAt.slice(0, 10);
  const byCaseId = new Map(matrixReport.results.map((result) => [result.caseId, result]));
  for (const route of mapping.routes) {
    const row = next.routes[route.id];
    row.evidence = row.evidence.map((item) => {
      if (item.caseId === undefined) return item;
      const result = byCaseId.get(item.caseId);
      if (result === undefined) return item;
      assert.ok(result.routeIds.includes(route.id), `${item.caseId} does not map to ${route.id}`);
      return {
        ...item,
        status: result.status === "skip" ? "pending" : result.status,
        reference: `matrix:${result.caseId}`,
        result: {
          phase: result.phase,
          provider: result.provider,
          door: result.door,
          durationMs: result.durationMs,
          billedCalls: result.billedCalls,
          artifact: result.artifact
        },
        ...(result.reason === null
          ? {}
          : {
              summary:
                result.status === "skip"
                  ? `Skipped; qualification remains pending: ${result.reason}`
                  : result.reason
            })
      };
    });
  }
  validateEvidence(mapping, next);
  return next;
}

export function applyManualRecords(mapping, source, manualRecords) {
  assert.equal(manualRecords.schemaVersion, 1, "manual records must use schemaVersion 1");
  assertSanitized(manualRecords);
  const next = structuredClone(source);
  for (const [routeId, record] of Object.entries(manualRecords.routes ?? {})) {
    assert.ok(
      mapping.routes.some((route) => route.id === routeId),
      `manual evidence names unknown route ${routeId}`
    );
    const row = next.routes[routeId];
    for (const field of ["credentialMode", "clientProviderVersion", "qualificationStatus"]) {
      if (record[field] !== undefined) row[field] = record[field];
    }
    if (record.outcomes !== undefined) {
      row.outcomes = { ...row.outcomes, ...record.outcomes };
    }
    if (record.evidence !== undefined) {
      row.evidence = [
        ...row.evidence.filter((item) => item.type !== "manual"),
        ...record.evidence.map((item) => ({ ...item, type: "manual" }))
      ];
    }
  }
  validateEvidence(mapping, next);
  return next;
}
