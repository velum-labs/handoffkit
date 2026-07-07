import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the collector at a throwaway DB before importing it (db() caches the
// handle on first use, keyed off this env var).
process.env.SCOPEKIT_DB = join(mkdtempSync(join(tmpdir(), "scope-collector-")), "scope.db");

const { ingestSpan, getSpans, listSessions, getSession, spansByName } = await import("../lib/db");
const { parseOtlpExport } = await import("../lib/otlp");
const { deriveSession } = await import("../lib/sessions");
const { rollupModels } = await import("../lib/rollups");
const { syntheticSession, toOtlpExport } = await import("./fixture");

test("ingest + query round-trips a full session and derives detail", () => {
  const traceId = "22222222222222222222222222220001";
  const spans = syntheticSession(traceId);
  let accepted = 0;
  for (const span of spans) {
    if (ingestSpan(span) !== undefined) accepted += 1;
  }
  assert.equal(accepted, spans.length);

  // Idempotent per trace+span id: re-ingesting changes nothing.
  for (const span of spans) assert.equal(ingestSpan(span), undefined);

  const storedSpans = getSpans(traceId);
  assert.equal(storedSpans.length, spans.length);

  const session = getSession(traceId);
  assert.ok(session);
  assert.equal(session.status, "succeeded");
  assert.equal(session.repo, "/tmp/fusion-sample");
  assert.equal(session.prompt_preview, "Fix the add() sign bug so npm test passes.");
  assert.equal(session.span_count, spans.length);

  const detail = deriveSession(traceId, storedSpans);
  assert.equal(detail.candidates.length, 2);
  assert.equal(detail.judge.final?.decision, "synthesize");

  const rows = listSessions();
  assert.ok(rows.some((row) => row.trace_id === traceId));

  const calls = spansByName(["fusion.model_call.started", "chat"]);
  const rollup = rollupModels(calls);
  const gpt = rollup.find((entry) => entry.modelId === "gpt");
  assert.ok(gpt);
  assert.equal(gpt.succeeded, 1);
  assert.equal(gpt.totalTokens, 920);
  assert.equal(gpt.promptTokens, 800);
  assert.equal(gpt.completionTokens, 120);
});

test("an in-progress session (no terminal span yet) registers and lists as running", () => {
  // The --observe dashboard must show a session while the run is still in
  // flight: the first non-terminal spans alone create a `running` session row,
  // and the turn-info marker fills in the identity metadata.
  const traceId = "22222222222222222222222222220009";
  const spans = syntheticSession(traceId);
  const inFlight = spans.filter(
    (span) => span.name === "fusion.turn.info" || span.name === "fusion.candidate.started"
  );
  assert.ok(inFlight.length >= 2);
  for (const span of inFlight) assert.ok(ingestSpan(span));

  const session = getSession(traceId);
  assert.ok(session);
  assert.equal(session.status, "running");
  assert.equal(session.repo, "/tmp/fusion-sample");
  assert.equal(session.prompt_preview, "Fix the add() sign bug so npm test passes.");
  assert.ok(listSessions().some((row) => row.trace_id === traceId && row.status === "running"));

  // The terminal run span later settles the same session to its final status.
  const terminal = spans.find((span) => span.name === "fusion.run");
  assert.ok(terminal);
  assert.ok(ingestSpan(terminal));
  assert.equal(getSession(traceId)?.status, "succeeded");
});

test("parseOtlpExport decodes spec-shaped OTLP JSON (hex ids, int enums)", () => {
  const traceId = "22222222222222222222222222220002";
  const spans = syntheticSession(traceId);
  const parsed = parseOtlpExport(toOtlpExport(spans));
  assert.equal(parsed.length, spans.length);
  const judge = parsed.find((span) => span.name === "fusion.judge");
  assert.ok(judge);
  assert.equal(judge.trace_id, traceId);
  assert.equal(judge.component, "judge");
  assert.equal(judge.status, "ok");
  assert.equal(judge.attributes["fusion.decision"], "synthesize");
  assert.ok(judge.end_ms > judge.start_ms);
});

test("parseOtlpExport decodes the protobuf-JSON mapping (base64 ids, enum names, string int64)", () => {
  // The Python engine's exporter serializes via the protobuf JSON mapping.
  const traceHex = "22222222222222222222222222220003";
  const spanHex = "aaaaaaaaaaaaaa03";
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "fusionkit-router" } }]
        },
        scopeSpans: [
          {
            scope: { name: "fusionkit.synthesis" },
            spans: [
              {
                traceId: Buffer.from(traceHex, "hex").toString("base64"),
                spanId: Buffer.from(spanHex, "hex").toString("base64"),
                name: "fusion.fuse",
                kind: "SPAN_KIND_INTERNAL",
                startTimeUnixNano: "1750000000000000000",
                endTimeUnixNano: "1750000001000000000",
                attributes: [
                  { key: "fusion.decision", value: { stringValue: "synthesize" } },
                  { key: "fusion.terminal", value: { boolValue: true } },
                  { key: "gen_ai.usage.input_tokens", value: { intValue: "1800" } }
                ],
                status: { code: "STATUS_CODE_OK" }
              }
            ]
          }
        ]
      }
    ]
  };
  const [span] = parseOtlpExport(payload);
  assert.ok(span);
  assert.equal(span.trace_id, traceHex);
  assert.equal(span.span_id, spanHex);
  assert.equal(span.component, "synthesis");
  assert.equal(span.service, "fusionkit-router");
  assert.equal(span.status, "ok");
  assert.equal(span.attributes["gen_ai.usage.input_tokens"], 1800);
  assert.equal(span.start_ms, 1750000000000);
  assert.equal(span.end_ms, 1750000001000);
});

test("malformed spans are skipped, not fatal", () => {
  const parsed = parseOtlpExport({
    resourceSpans: [
      {
        scopeSpans: [
          {
            scope: { name: "fusionkit.gateway" },
            spans: [
              { name: "fusion.cost" }, // no ids
              { traceId: "zz", spanId: "zz", name: "fusion.cost" } // undecodable ids
            ]
          }
        ]
      }
    ]
  });
  assert.equal(parsed.length, 0);
});
