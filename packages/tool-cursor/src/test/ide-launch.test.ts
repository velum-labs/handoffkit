import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import type { ToolLaunchContext } from "@fusionkit/tools";

import { launchCursor } from "../launch.js";

/**
 * A stub for `cursorkit ck`: records the env + cwd it was launched with, prints
 * the readiness line `launchCursorIde` waits for, then idles until SIGTERM so
 * the disposer-driven teardown path is exercised.
 */
function writeCkStub(path: string, outFile: string): void {
  writeFileSync(
    path,
    [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  cwd: process.cwd(),",
      "  workspace: process.env.CK_WORKSPACE_PATH,",
      "  models: process.env.BRIDGE_MODELS_JSON,",
      "  modelBaseUrl: process.env.MODEL_BASE_URL,",
      "  modelApiKey: process.env.MODEL_API_KEY,",
      "  caCerts: process.env.NODE_EXTRA_CA_CERTS,",
      "  leakedBridge: process.env.BRIDGE_PORT",
      "}));",
      "process.stdout.write('ck ready\\n');",
      "const timer = setInterval(() => {}, 1000);",
      "process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });"
    ].join("\n")
  );
}

test("launchCursor --ide drives the desktop launcher with the gateway-wired model", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "cursor-ide-"));
  const repo = mkdtempSync(join(tmpdir(), "cursor-ide-repo-"));
  const logsDir = join(workdir, "logs");
  const stub = join(workdir, "ck-stub.cjs");
  const outFile = join(workdir, "ck-invocation.json");
  writeCkStub(stub, outFile);

  const previousOverride = process.env.FUSIONKIT_CURSORKIT_SERVE_CLI;
  // A leftover BRIDGE_* var that must be scrubbed before spawning the launcher.
  const previousLeak = process.env.BRIDGE_PORT;
  process.env.FUSIONKIT_CURSORKIT_SERVE_CLI = stub;
  process.env.BRIDGE_PORT = "59999";
  const disposers: Array<() => void | Promise<void>> = [];
  const logs: string[] = [];
  const ctx: ToolLaunchContext = {
    mode: "fusion",
    ide: true,
    gatewayUrl: "http://127.0.0.1:9999",
    modelLabel: "fusion-panel",
    nativeModels: ["gpt", "sonnet", "fusion-panel"],
    toolArgs: [],
    repo,
    caCertPath: "/tmp/portless-ca.pem",
    logsDir,
    log: (line) => logs.push(line),
    prepareForPassthrough: () => undefined,
    registerPort: (_name, port) => `http://127.0.0.1:${port}`,
    unregisterPort: () => undefined,
    registerDisposer: (dispose) => disposers.push(dispose)
  };

  try {
    const launched = launchCursor(ctx);
    try {
      // Wait until the launcher is fully up: a registered disposer means it
      // passed the readiness gate and recorded its teardown (the stub wrote its
      // invocation file before announcing readiness).
      for (let i = 0; i < 200 && disposers.length === 0; i++) {
        await delay(50);
      }
      assert.equal(disposers.length, 1);
      assert.ok(existsSync(outFile), "the ck stub should have been invoked");
      const invocation = JSON.parse(readFileSync(outFile, "utf8")) as {
        argv: string[];
        cwd: string;
        workspace?: string;
        models?: string;
        modelBaseUrl?: string;
        modelApiKey?: string;
        caCerts?: string;
        leakedBridge?: string;
      };

      assert.deepEqual(invocation.argv, ["ck"]);
      // Opens the user's repo but keeps state out of it (cwd is the scratch dir).
      assert.equal(invocation.workspace, repo);
      assert.notEqual(invocation.cwd, repo);
      assert.equal(invocation.modelBaseUrl, "http://127.0.0.1:9999/v1");
      assert.equal(invocation.modelApiKey, "local");
      assert.equal(invocation.caCerts, "/tmp/portless-ca.pem");
      // A parent's BRIDGE_* env is scrubbed; only our seeded models flow through.
      assert.equal(invocation.leakedBridge, undefined);
      const models = JSON.parse(invocation.models ?? "[]") as Array<{ id: string; baseUrl: string }>;
      assert.deepEqual(
        models.map((entry) => entry.id),
        ["fusion-panel", "gpt", "sonnet"]
      );
      assert.ok(models.every((entry) => entry.baseUrl === "http://127.0.0.1:9999/v1"));
    } finally {
      // Always tear the desktop launcher down so the launch promise resolves and
      // the test process can exit even when an assertion fails.
      for (const dispose of disposers) {
        await dispose();
      }
      const code = await launched;
      assert.equal(code, 0);
    }
  } finally {
    if (previousOverride === undefined) {
      delete process.env.FUSIONKIT_CURSORKIT_SERVE_CLI;
    } else {
      process.env.FUSIONKIT_CURSORKIT_SERVE_CLI = previousOverride;
    }
    if (previousLeak === undefined) {
      delete process.env.BRIDGE_PORT;
    } else {
      process.env.BRIDGE_PORT = previousLeak;
    }
    rmSync(workdir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
