import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Isolate consent state before importing the modules under test.
const stateDir = mkdtempSync(join(tmpdir(), "fusionkit-telemetry-"));
process.env.FUSIONKIT_TELEMETRY_PATH = join(stateDir, "telemetry.json");
delete process.env.FUSIONKIT_TELEMETRY;
delete process.env.DO_NOT_TRACK;
delete process.env.FUSIONKIT_POSTHOG_KEY;

const { clearTelemetryFile, disableTelemetry, enableTelemetry, resolveTelemetry } = await import(
  "../telemetry/consent.js"
);
const {
  captureCommand,
  durationBucket,
  initTelemetry,
  pendingSessionEventsForTest,
  resetTelemetryForTest,
  shutdownTelemetry
} = await import("../telemetry/telemetry.js");
const { initFusionTracing, jsonAttr, newSessionCarrier, startFusionSpan } = await import("@fusionkit/tracing");

initFusionTracing({ serviceName: "telemetry-test" });

test("telemetry is off by default and consent precedence holds", () => {
  clearTelemetryFile();
  assert.deepEqual(resolveTelemetry({}), { enabled: false, source: "default" });

  enableTelemetry();
  assert.equal(resolveTelemetry({}).enabled, true);
  assert.equal(resolveTelemetry({}).source, "config");
  assert.ok(resolveTelemetry({}).installId, "opt-in mints an install id");

  // Env kill switch beats stored consent; DO_NOT_TRACK beats everything.
  assert.deepEqual(resolveTelemetry({ FUSIONKIT_TELEMETRY: "0" }), { enabled: false, source: "env" });
  assert.equal(resolveTelemetry({ DO_NOT_TRACK: "1", FUSIONKIT_TELEMETRY: "1" }).enabled, false);
  assert.equal(resolveTelemetry({ DO_NOT_TRACK: "1", FUSIONKIT_TELEMETRY: "1" }).source, "do-not-track");

  disableTelemetry();
  const off = resolveTelemetry({});
  assert.equal(off.enabled, false);
  assert.equal(off.source, "config");
  assert.equal(off.installId, undefined, "opt-out deletes the install id");
});

test("no HTTP request is ever attempted while telemetry is disabled", async () => {
  clearTelemetryFile();
  resetTelemetryForTest();
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.env.FUSIONKIT_POSTHOG_KEY = "phc_test";
  process.env.FUSIONKIT_POSTHOG_HOST = `http://127.0.0.1:${port}`;
  try {
    initTelemetry();
    captureCommand({ command: "codex", cliVersion: "0.0.0", startedAt: Date.now(), exitKind: "ok" });
    // A full fused session's spans flow while disabled.
    const session = newSessionCarrier();
    const run = startFusionSpan("gateway", "fusion.run", session.carrier, {});
    run.end({ status: "succeeded" });
    await shutdownTelemetry();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(requests, 0, "disabled telemetry must never open a socket");
  } finally {
    delete process.env.FUSIONKIT_POSTHOG_KEY;
    delete process.env.FUSIONKIT_POSTHOG_HOST;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("fusion.session aggregates are allow-listed and carry no payload text", async () => {
  clearTelemetryFile();
  resetTelemetryForTest();
  enableTelemetry();
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  initTelemetry({ capture: (event, properties) => captured.push({ event, properties }) });

  const session = newSessionCarrier();
  const run = startFusionSpan("gateway", "fusion.run", session.carrier, {
    "fusion.dialect": "codex",
    "fusion.prompt_preview": "SECRET PROMPT TEXT",
    "fusion.environment": jsonAttr({
      repo: "/secret/path",
      harnesses: ["agent"],
      models: [
        { id: "gpt", model: "gpt-5.5", provider: "openai" },
        { id: "opus", model: "claude-opus-4-6", provider: "anthropic" }
      ]
    })
  });
  const candidate = startFusionSpan("panel-model", "fusion.candidate", run.carrier, {
    "fusion.candidate.id": "cand_gpt",
    "fusion.turn": 1
  });
  candidate.end({ status: "succeeded" });
  const call = startFusionSpan("panel-model", "chat gpt-5.5", run.carrier, {
    "gen_ai.usage.input_tokens": 800,
    "gen_ai.usage.output_tokens": 120,
    "fusion.final_output": "SECRET OUTPUT"
  });
  call.end({ status: "succeeded" });
  const judgeSpan = startFusionSpan("judge", "fusion.judge", run.carrier, {
    "fusion.decision": "synthesize",
    "fusion.final_output": "SECRET FUSED OUTPUT",
    "fusion.turn": 1
  });
  judgeSpan.end({ status: "succeeded" });
  run.end({ status: "succeeded" });

  const [pending] = pendingSessionEventsForTest();
  assert.ok(pending, "the session folded into an aggregate");
  // The exact allow-listed key set: any new field must be a reviewed diff here.
  assert.deepEqual(Object.keys(pending).sort(), [
    "candidate_failures",
    "duration_bucket",
    "harness",
    "input_tokens",
    "judge_decision",
    "output_tokens",
    "panel_size",
    "providers",
    "turn_count"
  ]);
  assert.deepEqual(pending.providers, ["anthropic", "openai"]);
  assert.equal(pending.judge_decision, "synthesize");
  assert.equal(pending.input_tokens, 800);
  assert.equal(pending.turn_count, 1);
  assert.ok(
    !JSON.stringify(pending).includes("SECRET"),
    "no prompt, path, or output text may reach a telemetry record"
  );

  await shutdownTelemetry();
  const sessionEvents = captured.filter((entry) => entry.event === "fusion.session");
  assert.equal(sessionEvents.length, 1, "the aggregate ships once at flush");
});

test("cli.command records the allow-listed invocation shape", async () => {
  clearTelemetryFile();
  resetTelemetryForTest();
  enableTelemetry();
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  initTelemetry({ capture: (event, properties) => captured.push({ event, properties }) });
  captureCommand({
    command: "codex",
    cliVersion: "1.2.3",
    startedAt: Date.now() - 3_000,
    exitKind: "ok",
    observe: true
  });
  const [entry] = captured;
  assert.ok(entry);
  assert.equal(entry.event, "cli.command");
  assert.deepEqual(Object.keys(entry.properties).sort(), [
    "arch",
    "cli_version",
    "command",
    "duration_bucket",
    "exit_kind",
    "is_ci",
    "local",
    "node_major",
    "observe",
    "os"
  ]);
  assert.equal(entry.properties.command, "codex");
  assert.equal(entry.properties.duration_bucket, "1-10s");
  assert.equal(entry.properties.observe, true);
  await shutdownTelemetry();
});

test("duration buckets are coarse", () => {
  assert.equal(durationBucket(500), "<1s");
  assert.equal(durationBucket(5_000), "1-10s");
  assert.equal(durationBucket(45_000), "10-60s");
  assert.equal(durationBucket(200_000), "1-5m");
  assert.equal(durationBucket(600_000), "5-30m");
  assert.equal(durationBucket(3_600_000), ">30m");
});

test.after(() => rmSync(stateDir, { recursive: true, force: true }));
