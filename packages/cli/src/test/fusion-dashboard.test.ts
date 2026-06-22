import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isScopeDashboardUp,
  parseDashboardPort,
  resolveFusionDashboardHealthUrl,
  resolveFusionDashboardUrl,
  runFusionDashboard
} from "../commands/fusion-dashboard.js";
import { SCOPE_DASHBOARD_PORT } from "../fusion/observability.js";

test("resolveFusionDashboardUrl honours default port and env override", () => {
  assert.equal(resolveFusionDashboardUrl({}), `http://127.0.0.1:${SCOPE_DASHBOARD_PORT}/routing`);
  assert.equal(
    resolveFusionDashboardUrl({ FUSION_ROUTING_SCOPE_URL: "http://localhost:9999/" }),
    "http://localhost:9999/routing"
  );
  assert.equal(resolveFusionDashboardUrl({}, 5555), "http://127.0.0.1:5555/routing");
});

test("resolveFusionDashboardHealthUrl builds decisions endpoint", () => {
  assert.equal(
    resolveFusionDashboardHealthUrl({ FUSION_ROUTING_SCOPE_URL: "http://scope.test" }),
    "http://scope.test/api/routing/decisions"
  );
});

test("parseDashboardPort parses numeric port", () => {
  assert.equal(parseDashboardPort("4318"), 4318);
  assert.equal(parseDashboardPort(undefined), undefined);
});

test("isScopeDashboardUp returns true when HEAD succeeds", async () => {
  const up = await isScopeDashboardUp("http://example.test/health", {
    fetchImpl: async () => ({ ok: true }) as Response
  });
  assert.equal(up, true);
});

test("isScopeDashboardUp returns false when fetch fails", async () => {
  const up = await isScopeDashboardUp("http://example.test/health", {
    fetchImpl: async () => {
      throw new Error("connection refused");
    }
  });
  assert.equal(up, false);
});

test("runFusionDashboard --no-open skips browser when already up", async () => {
  const lines: string[] = [];
  const code = await runFusionDashboard({
    noOpen: true,
    fetchImpl: async () => ({ ok: true }) as Response,
    log: (line) => lines.push(line)
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /Opening http:\/\/127\.0\.0\.1:4317\/routing/);
});

test("runFusionDashboard spawns scope when port is down then opens URL", async () => {
  const lines: string[] = [];
  let calls = 0;
  const code = await runFusionDashboard({
    noOpen: true,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return { ok: true } as Response;
    },
    spawnImpl: (() =>
      ({
        pid: 4242,
        unref: () => undefined
      }) as import("node:child_process").ChildProcess) as typeof import("node:child_process").spawn,
    sleepMs: async () => undefined,
    log: (line) => lines.push(line)
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /pid 4242/);
  assert.match(lines.join("\n"), /Opening/);
});
