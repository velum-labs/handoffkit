import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { gitText } from "@fusionkit/workspace";

import {
  buildFusionStatusPayload,
  fetchLast24hRoutingStats,
  formatSubscriptionEntry,
  parseRoutingDecisionSse,
  renderFusionStatusReport,
  runFusionStatus,
  summarizeLast24h
} from "../commands/fusion-status.js";
import { FUSION_CONFIG_VERSION, writeFusionConfig } from "../fusion-config.js";

const tmpRoots: string[] = [];

function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-status-"));
  tmpRoots.push(root);
  gitText(root, ["init", "--quiet", "--initial-branch=main"]);
  gitText(root, ["config", "user.email", "status@test.local"]);
  gitText(root, ["config", "user.name", "status"]);
  return root;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("formatSubscriptionEntry shows days remaining and unavailable states", () => {
  const nowSec = 1_700_000_000;
  assert.equal(
    formatSubscriptionEntry("Claude Code", { mode: "claude-code", available: true, expired: false, expiresAt: nowSec + 47 * 86_400 }, nowSec),
    "Claude Code ✅ (47d)"
  );
  assert.equal(
    formatSubscriptionEntry("Codex", { mode: "codex", available: false, expired: false }, nowSec),
    "Codex ❌"
  );
  assert.equal(
    formatSubscriptionEntry("Codex", { mode: "codex", available: true, expired: true, expiresAt: nowSec - 1 }, nowSec),
    "Codex ⚠️ (expired)"
  );
});

test("parseRoutingDecisionSse extracts routing.decision payloads", () => {
  const body = [
    "event: routing.decision",
    'data: {"scenario":"default","target":{"model":"m"},"tokenCount":1,"reason":"r","fallbackIndex":0,"ts":100}',
    "",
    'data: {"scenario":"background","target":{"model":"m2"},"tokenCount":2,"reason":"r2","fallbackIndex":0,"ts":200}'
  ].join("\n");
  const events = parseRoutingDecisionSse(body);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.scenario, "default");
  assert.equal(events[1]?.ts, 200);
});

test("summarizeLast24h counts requests and picks top scenario", () => {
  const nowMs = 200_000 * 1000;
  const stats = summarizeLast24h(
    [
      { scenario: "default", ts: 199_000 },
      { scenario: "default", ts: 199_500 },
      { scenario: "background", ts: 199_100 }
    ],
    nowMs
  );
  assert.equal(stats.count, 3);
  assert.equal(stats.topScenario, "default");
  assert.equal(stats.topCount, 2);
});

test("renderFusionStatusReport formats routing rules and placeholder cost line", () => {
  const report = renderFusionStatusReport({
    configPath: "./.fusionkit/fusion.json",
    subscriptionsLine: "Claude Code ✅ (47d), Codex ✅ (12d)",
    routes: {
      routes: {
        default: "claude-sub,claude-sonnet-4-5",
        background: "groq-fast",
        longContext: "google/gemini-2.0-pro",
        reasoning: "codex-sub",
        webSearch: "google/gemini-2.0-pro"
      },
      providers: [{ id: "claude-sub", provider: "anthropic" }]
    },
    stats: { count: 42, topScenario: "default", topCount: 30 }
  });
  assert.match(report, /📊 Smart Routing Status/);
  assert.match(report, /Active config: \.\/\.fusionkit\/fusion\.json/);
  assert.match(report, /Claude Code ✅ \(47d\), Codex ✅ \(12d\)/);
  assert.match(report, /default\s+→ claude-sub/);
  assert.match(report, /background\s+→ groq-fast/);
  assert.match(report, /Last 24h: 42 requests routed/);
  assert.match(report, /Top scenario: default \(30 requests\)/);
  assert.match(report, /Cost tracking: coming in v0\.6/);
});

test("renderFusionStatusReport shows dashboard-not-running line", () => {
  const report = renderFusionStatusReport({
    configPath: "./.fusionkit/fusion.json",
    subscriptionsLine: "Claude Code ❌, Codex ❌",
    routes: undefined,
    dashboardDown: true
  });
  assert.match(report, /Last 24h: dashboard not running/);
  assert.doesNotMatch(report, /Top scenario:/);
});

test("fetchLast24hRoutingStats returns undefined when dashboard is down", async () => {
  const stats = await fetchLast24hRoutingStats("http://127.0.0.1:1/api/routing/decisions");
  assert.equal(stats, undefined);
});

test("fetchLast24hRoutingStats parses SSE replay from a mock fetch", async () => {
  const nowMs = 200_000_000_000;
  const nowSec = nowMs / 1000;
  const body = `data: {"scenario":"reasoning","target":{"model":"m"},"tokenCount":1,"reason":"r","fallbackIndex":0,"ts":${nowSec - 3600}}\n\n`;
  const stats = await fetchLast24hRoutingStats("http://example.test/decisions", {
    fetchImpl: async () =>
      ({
        ok: true,
        text: async () => body
      }) as Response,
    now: () => nowMs
  });
  assert.deepEqual(stats, { count: 1, topScenario: "reasoning", topCount: 1 });
});

test("runFusionStatus renders against a sample config with dashboard down", async () => {
  const repo = freshRepo();
  writeFusionConfig(repo, {
    version: FUSION_CONFIG_VERSION,
    routing: {
      routes: { default: "claude-sub,claude-sonnet-4-5" },
      providers: [{ id: "claude-sub", provider: "anthropic" }]
    }
  });
  const lines: string[] = [];
  const code = await runFusionStatus({
    repo,
    cwd: repo,
    fetchImpl: async () => {
      throw new Error("dashboard down");
    },
    log: (line) => lines.push(line)
  });
  assert.equal(code, 0);
  const report = lines.join("\n");
  assert.match(report, /Smart Routing Status/);
  assert.match(report, /dashboard not running/);
});

test("runFusionStatus --json emits valid structured payload", async () => {
  const repo = freshRepo();
  writeFusionConfig(repo, {
    version: FUSION_CONFIG_VERSION,
    routing: {
      routes: { default: "claude-sub,claude-sonnet-4-5" },
      providers: [{ id: "claude-sub", provider: "anthropic" }]
    }
  });
  const lines: string[] = [];
  const code = await runFusionStatus({
    repo,
    cwd: repo,
    json: true,
    fetchImpl: async () => {
      throw new Error("dashboard down");
    },
    log: (line) => lines.push(line)
  });
  assert.equal(code, 0);
  const payload = JSON.parse(lines.join("\n")) as Record<string, unknown>;
  assert.equal(typeof payload.activeConfig, "string");
  assert.deepEqual(Object.keys(payload.subscriptions as object).sort(), ["claudeCode", "codex"]);
  assert.ok(payload.routing);
  assert.deepEqual(payload.last24h, { dashboardDown: true });
  assert.equal(payload.costTracking, "deferred-to-v0.6");
});

test("buildFusionStatusPayload contains expected keys", () => {
  const payload = buildFusionStatusPayload({
    configPath: "./.fusionkit/fusion.json",
    subscriptions: {
      "claude-code": { mode: "claude-code", available: true, expired: false },
      codex: { mode: "codex", available: false, expired: false }
    },
    nowSec: 1_700_000_000,
    routes: {
      routes: { default: "claude-sub,claude-sonnet-4-5" },
      providers: [{ id: "claude-sub", provider: "anthropic" }]
    },
    dashboardDown: true
  });
  assert.equal(payload.activeConfig, "./.fusionkit/fusion.json");
  assert.equal(payload.costTracking, "deferred-to-v0.6");
  assert.deepEqual(payload.last24h, { dashboardDown: true });
});
