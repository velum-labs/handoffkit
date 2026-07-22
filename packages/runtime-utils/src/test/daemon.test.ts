import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createServiceRecordStore,
  processAlive,
  serviceLogPath,
  startDaemon,
  stopDaemonProcess,
  upgradeDetachedDaemon,
  SERVICE_SUPERVISOR_ENV
} from "../index.js";

/**
 * A minimal daemon fixture: serves /health on an ephemeral loopback port and
 * writes its own service record — the same contract a real `gateway serve`
 * process fulfils. In "crash" mode it logs and exits before becoming ready.
 */
const FIXTURE = `
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.argv[2];
const mode = process.argv[3] ?? "ok";
if (mode === "crash") {
  console.error("boom: fixture failed to start");
  process.exit(3);
}
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ status: "ok" }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const processIdentity = process.platform === "linux"
    ? readFileSync("/proc/self/stat", "utf8").slice(readFileSync("/proc/self/stat", "utf8").lastIndexOf(")") + 2).split(" ")[19]
    : process.platform === "darwin"
      ? spawnSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim()
      : undefined;
  mkdirSync(join(home, "services"), { recursive: true });
  writeFileSync(
    join(home, "services", "svc.json"),
    JSON.stringify({
      product: "testkit",
      owner: "testkit",
      kind: "svc",
      pid: process.pid,
      url: "http://127.0.0.1:" + port,
      port,
      startedAt: new Date().toISOString(),
      processIdentity: processIdentity || undefined,
      supervisor: process.env.${SERVICE_SUPERVISOR_ENV}
    })
  );
  console.log("fixture serving on " + port);
});
process.on("SIGTERM", () => {
  // pid-guarded removal, like the product path: a blue-green successor's
  // record must survive this (old) process's shutdown.
  const recordPath = join(home, "services", "svc.json");
  try {
    const current = JSON.parse(readFileSync(recordPath, "utf8"));
    if (current.pid === process.pid) rmSync(recordPath, { force: true });
  } catch {}
  server.close();
  process.exit(0);
});
`;

function fixturePath(home: string): string {
  const path = join(home, "fixture.mjs");
  writeFileSync(path, FIXTURE);
  return path;
}

test("processAlive rejects pid reuse even when the pid belongs to another user", () => {
  // pid 1 always exists and (for an unprivileged user) kill(1, 0) fails with
  // EPERM — the same signature as a rebooted machine reusing a recorded pid
  // for a system process. A mismatched birth identity must win over EPERM.
  assert.equal(processAlive(1, "Mon Jan  1 00:00:00 2001"), false);
  // Without a recorded identity, EPERM still means "alive".
  assert.equal(processAlive(1), true);
});

test("startDaemon detaches, waits for record + health, is idempotent, and stop reaps", async () => {
  const home = mkdtempSync(join(tmpdir(), "daemon-lifecycle-"));
  const script = fixturePath(home);
  try {
    const spec = {
      product: "testkit",
      kind: "svc",
      home,
      version: "1.0.0",
      command: { execPath: process.execPath, args: [script, home] }
    };
    const started = await startDaemon(spec, { readyTimeoutMs: 15_000 });
    assert.equal(started.alreadyRunning, false);
    assert.notEqual(started.record.pid, process.pid);
    assert.ok(processAlive(started.record.pid));
    // The child inherited the supervisor stamp through the environment.
    assert.equal(started.record.supervisor, "detached");
    assert.match(readFileSync(serviceLogPath(home, "svc"), "utf8"), /fixture serving on/);

    const again = await startDaemon(spec, { readyTimeoutMs: 15_000 });
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.record.pid, started.record.pid);

    const stopped = await stopDaemonProcess(started.record, { graceMs: 5_000 });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.forced, false);
    const store = createServiceRecordStore({ home, product: "testkit" });
    assert.equal(store.read("svc"), undefined);
    assert.equal(processAlive(started.record.pid), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("blue-green upgrade starts the replacement before draining the old daemon", async () => {
  const home = mkdtempSync(join(tmpdir(), "daemon-blue-green-"));
  const script = fixturePath(home);
  const spec = {
    product: "testkit",
    kind: "svc",
    home,
    version: "2.0.0",
    command: { execPath: process.execPath, args: [script, home] }
  };
  try {
    const old = await startDaemon(spec, { readyTimeoutMs: 15_000 });
    const result = await upgradeDetachedDaemon({
      record: old.record,
      strategy: "blue-green",
      spec,
      drainGraceMs: 3_000,
      readyTimeoutMs: 15_000
    });
    assert.equal(result.strategy, "blue-green");
    assert.equal(result.previousPid, old.record.pid);
    assert.notEqual(result.record.pid, old.record.pid);
    assert.ok(processAlive(result.record.pid));
    assert.equal(processAlive(old.record.pid), false);
    // The replacement's record survived the old process's shutdown thanks to
    // the pid-guarded removal.
    const store = createServiceRecordStore({ home, product: "testkit" });
    assert.equal(store.read("svc")?.pid, result.record.pid);
    await stopDaemonProcess(result.record, { graceMs: 5_000 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a daemon that dies before readiness fails the start with its log tail", async () => {
  const home = mkdtempSync(join(tmpdir(), "daemon-crash-"));
  const script = fixturePath(home);
  try {
    await assert.rejects(
      startDaemon(
        {
          product: "testkit",
          kind: "svc",
          home,
          command: { execPath: process.execPath, args: [script, home, "crash"] }
        },
        { readyTimeoutMs: 15_000 }
      ),
      /boom: fixture failed to start/
    );
    const store = createServiceRecordStore({ home, product: "testkit" });
    assert.equal(store.read("svc"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
