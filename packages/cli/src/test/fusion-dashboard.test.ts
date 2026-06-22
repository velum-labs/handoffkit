import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  isScopeDashboardUp,
  parseDashboardPort,
  resolveFusionDashboardHealthUrl,
  resolveFusionDashboardUrl,
  runFusionDashboard,
  scopeDashboardManualStartHint,
  spawnScopeDev
} from "../commands/fusion-dashboard.js";
import { SCOPE_DASHBOARD_PORT } from "../fusion/observability.js";

const tmpRoots: string[] = [];

function fakeScopeDir(withBuild = true): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-dashboard-scope-"));
  tmpRoots.push(root);
  const nextBin = join(root, "node_modules", ".bin", "next");
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(nextBin, "#!/bin/sh\nexit 0\n");
  chmodSync(nextBin, 0o755);
  if (withBuild) {
    mkdirSync(join(root, ".next"), { recursive: true });
    writeFileSync(join(root, ".next", "BUILD_ID"), "test-build");
  }
  return root;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

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

test("runFusionDashboard spawns next start when port is down then opens URL", async () => {
  const scopeDir = fakeScopeDir(true);
  const lines: string[] = [];
  let calls = 0;
  const spawned: { command: string; args: string[] }[] = [];
  const code = await runFusionDashboard({
    noOpen: true,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("down");
      return { ok: true } as Response;
    },
    spawnImpl: ((command: string, args: readonly string[]) => {
      spawned.push({ command, args: [...args] });
      return {
        pid: 4242,
        unref: () => undefined
      } as import("node:child_process").ChildProcess;
    }) as typeof import("node:child_process").spawn,
    sleepMs: async () => undefined,
    log: (line) => lines.push(line),
    scopeDir
  });
  assert.equal(code, 0);
  assert.match(lines.join("\n"), /pid 4242/);
  assert.match(lines.join("\n"), /Opening/);
  assert.ok(
    spawned.some(
      (entry) =>
        entry.command.endsWith("/next") &&
        entry.args.includes("start") &&
        entry.args.includes("-p") &&
        entry.args.includes(String(SCOPE_DASHBOARD_PORT))
    ),
    `expected next start spawn, got ${JSON.stringify(spawned)}`
  );
});

test("spawnScopeDev throws when next binary is missing", () => {
  const scopeDir = mkdtempSync(join(tmpdir(), "fusion-dashboard-missing-next-"));
  tmpRoots.push(scopeDir);
  assert.throws(
    () =>
      spawnScopeDev({
        scopeDir,
        spawnImpl: (() => ({ pid: 1, unref: () => undefined }) as import("node:child_process").ChildProcess) as typeof import(
          "node:child_process"
        ).spawn
      }),
    /Install its dependencies once/
  );
});

test("spawnScopeDev runs next start on the configured port", () => {
  const scopeDir = fakeScopeDir(true);
  const spawned: { command: string; args: string[] }[] = [];
  const result = spawnScopeDev({
    scopeDir,
    port: 5555,
    spawnImpl: ((command: string, args: readonly string[]) => {
      spawned.push({ command, args: [...args] });
      return { pid: 99, unref: () => undefined } as import("node:child_process").ChildProcess;
    }) as typeof import("node:child_process").spawn
  });
  assert.equal(result.pid, 99);
  assert.deepEqual(spawned[0]?.args, ["start", "-p", "5555"]);
});

test("scopeDashboardManualStartHint prefers next start when build exists", () => {
  const scopeDir = fakeScopeDir(true);
  const hint = scopeDashboardManualStartHint(scopeDir, 4317);
  assert.match(hint, /next start -p 4317/);
});

test("scopeDashboardManualStartHint mentions dev:app when no build exists", () => {
  const scopeDir = fakeScopeDir(false);
  const hint = scopeDashboardManualStartHint(scopeDir, 4317);
  assert.match(hint, /pnpm dev:app/);
});
