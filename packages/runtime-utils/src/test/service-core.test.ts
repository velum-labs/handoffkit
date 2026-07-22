import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createServiceRecordStore,
  launchdAgentPlist,
  planUpgrade,
  rotateLogFile,
  supervisorFromEnv,
  systemdServiceUnit,
  detectSupervisor,
  SERVICE_SUPERVISOR_ENV
} from "../index.js";
import type { CommandRunner, ServiceRecord } from "../index.js";

function sampleRecord(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    product: "testkit",
    owner: "testkit",
    kind: "svc",
    pid: process.pid,
    url: "http://127.0.0.1:43210",
    port: 43210,
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

test("service records round-trip with version/args stamps and 0600 permissions", () => {
  const home = mkdtempSync(join(tmpdir(), "service-records-"));
  try {
    const store = createServiceRecordStore({ home, product: "testkit" });
    store.write({
      kind: "svc",
      pid: process.pid,
      url: "http://127.0.0.1:43210",
      port: 43210,
      startedAt: "2026-01-01T00:00:00.000Z",
      version: "1.2.3",
      binPath: "/usr/local/bin/testkit",
      args: ["gateway", "serve", "--port", "43210"],
      cwd: "/somewhere",
      supervisor: "detached"
    });
    const record = store.read("svc");
    assert.equal(record?.product, "testkit");
    assert.equal(record?.owner, "testkit");
    assert.equal(record?.version, "1.2.3");
    assert.equal(record?.binPath, "/usr/local/bin/testkit");
    assert.deepEqual(record?.args, ["gateway", "serve", "--port", "43210"]);
    assert.equal(record?.cwd, "/somewhere");
    assert.equal(record?.supervisor, "detached");
    assert.equal(statSync(store.path("svc")).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a record whose pid is gone is reaped on read", () => {
  const home = mkdtempSync(join(tmpdir(), "service-records-stale-"));
  try {
    const store = createServiceRecordStore({ home, product: "testkit" });
    // A pid that cannot be running: beyond the default pid_max on Linux, and
    // long-dead on other platforms.
    store.write({
      kind: "svc",
      pid: 2 ** 22 + 12345,
      url: "http://127.0.0.1:1",
      port: 1,
      startedAt: "2026-01-01T00:00:00.000Z"
    });
    assert.equal(store.read("svc"), undefined);
    assert.equal(store.read("svc"), undefined);
    assert.equal(
      existsSync(store.path("svc")),
      true,
      "read-only liveness checks must not race-delete a replacement record"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pid-guarded removal protects a successor's record", () => {
  const home = mkdtempSync(join(tmpdir(), "service-records-guard-"));
  try {
    const store = createServiceRecordStore({ home, product: "testkit" });
    store.write({
      kind: "svc",
      pid: process.pid,
      url: "http://127.0.0.1:2",
      port: 2,
      startedAt: "2026-01-01T00:00:00.000Z"
    });
    // The "old" process (a different pid) must not remove the new record.
    store.remove("svc", { ifPid: process.pid + 1 });
    assert.equal(store.read("svc")?.pid, process.pid);
    store.remove("svc", { ifPid: process.pid });
    assert.equal(store.read("svc")?.pid, process.pid);
    store.remove("svc");
    assert.equal(store.read("svc"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("supervisorFromEnv defaults to detached and reads the stamp", () => {
  assert.equal(supervisorFromEnv({}), "detached");
  assert.equal(supervisorFromEnv({ [SERVICE_SUPERVISOR_ENV]: "systemd" }), "systemd");
  assert.equal(supervisorFromEnv({ [SERVICE_SUPERVISOR_ENV]: "launchd" }), "launchd");
  assert.equal(supervisorFromEnv({ [SERVICE_SUPERVISOR_ENV]: "nonsense" }), "detached");
});

test("systemd unit generation quotes arguments and aligns the stop timeout to the drain grace", () => {
  const unit = systemdServiceUnit({
    product: "routekit",
    kind: "gateway",
    description: "RouteKit model gateway",
    command: {
      execPath: "/usr/bin/node",
      args: ["/opt/route kit/bin.js", "gateway", "serve", "--port", "8080"]
    },
    workingDirectory: "/home/user/project",
    environmentFile: "/home/user/.routekit/env/gateway.env",
    drainGraceMs: 30_000
  });
  assert.match(unit, /Description=RouteKit model gateway/);
  assert.match(
    unit,
    /ExecStart=\/usr\/bin\/node "\/opt\/route kit\/bin\.js" gateway serve --port 8080/
  );
  assert.match(unit, /Restart=always/);
  // 30s drain + 10s margin.
  assert.match(unit, /TimeoutStopSec=40/);
  assert.match(unit, new RegExp(`Environment="?${SERVICE_SUPERVISOR_ENV}=systemd"?`));
  assert.match(unit, /EnvironmentFile=-\/home\/user\/\.routekit\/env\/gateway\.env/);
  assert.match(unit, /WorkingDirectory=\/home\/user\/project/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("systemd unit generation rejects unsafe environment names", () => {
  assert.throws(() =>
    systemdServiceUnit({
      product: "routekit",
      kind: "gateway",
      description: "x",
      command: { execPath: "/usr/bin/node", args: [] },
      env: { "BAD NAME": "value" }
    })
  );
});

test("launchd plist generation embeds the program, keep-alive, env stamp, and log paths", () => {
  const plist = launchdAgentPlist({
    product: "routekit",
    kind: "gateway",
    description: "RouteKit model gateway",
    command: {
      execPath: "/usr/local/bin/node",
      args: ["/opt/routekit/bin.js", "gateway", "serve"]
    },
    env: { OPENAI_API_KEY: "a<b&c" },
    logFile: "/Users/user/.routekit/logs/gateway.log",
    drainGraceMs: 20_000
  });
  assert.match(plist, /<string>com\.routekit\.gateway<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n\s*<true\/>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\n\s*<integer>30<\/integer>/);
  assert.match(plist, new RegExp(`<key>${SERVICE_SUPERVISOR_ENV}</key>`));
  assert.match(plist, /<string>a&lt;b&amp;c<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key>/);
});

test("launchd controller creates log directories and manages the agent lifecycle", async () => {
  const home = mkdtempSync(join(tmpdir(), "launchd-install-"));
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  try {
    const controller = await detectSupervisor("routekit", "daemon", {
      platform: "darwin",
      runner,
      home,
      uid: 501
    });
    assert.ok(controller !== undefined);
    const logFile = join(home, "state", "logs", "daemon.log");
    await controller.install({
      product: "routekit",
      kind: "daemon",
      description: "RouteKit singleton daemon",
      command: { execPath: "/usr/local/bin/node", args: ["/bin.js", "daemon", "run"] },
      logFile
    });
    assert.equal(statSync(join(home, "state", "logs")).isDirectory(), true);
    assert.equal(statSync(controller.unitPath).mode & 0o777, 0o600);
    assert.deepEqual(
      calls.map((call) => call.slice(1)),
      [
        ["version"],
        ["bootout", "gui/501/com.routekit.daemon"],
        ["bootstrap", "gui/501", controller.unitPath],
        ["enable", "gui/501/com.routekit.daemon"]
      ]
    );
    assert.equal(await controller.uninstall(), true);
    assert.equal(existsSync(controller.unitPath), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("launchd restart retries a transient bootstrap EIO after bootout", async () => {
  const home = mkdtempSync(join(tmpdir(), "launchd-restart-"));
  const calls: string[][] = [];
  let bootstrapAttempts = 0;
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "bootstrap" && bootstrapAttempts++ === 0) {
      return {
        exitCode: 5,
        stdout: "",
        stderr: "Bootstrap failed: 5: Input/output error"
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  try {
    const controller = await detectSupervisor("routekit", "daemon", {
      platform: "darwin",
      runner,
      home,
      uid: 501
    });
    assert.ok(controller !== undefined);
    await controller.restart({ timeoutMs: 5_000 });
    assert.equal(bootstrapAttempts, 2);
    assert.deepEqual(
      calls.map((call) => call.slice(1)),
      [
        ["version"],
        ["bootout", "gui/501/com.routekit.daemon"],
        ["bootstrap", "gui/501", controller.unitPath],
        ["bootstrap", "gui/501", controller.unitPath]
      ]
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("supervisor detection uses the platform and a live user manager", async () => {
  const calls: string[][] = [];
  const runnerFor =
    (stdout: string, exitCode = 0): CommandRunner =>
    async (command, args) => {
      calls.push([command, ...args]);
      return { exitCode, stdout, stderr: "" };
    };

  const systemd = await detectSupervisor("routekit", "gateway", {
    platform: "linux",
    runner: runnerFor("running")
  });
  assert.equal(systemd?.kind, "systemd");
  assert.equal(systemd?.unitName, "routekit-gateway.service");

  // "degraded" (some unrelated unit failed) still means the manager works.
  const degraded = await detectSupervisor("routekit", "gateway", {
    platform: "linux",
    runner: runnerFor("degraded", 1)
  });
  assert.equal(degraded?.kind, "systemd");

  // "offline" means there is no user manager to talk to (containers).
  const offline = await detectSupervisor("routekit", "gateway", {
    platform: "linux",
    runner: runnerFor("offline", 1)
  });
  assert.equal(offline, undefined);

  const launchd = await detectSupervisor("routekit", "gateway", {
    platform: "darwin",
    runner: runnerFor("launchctl version x")
  });
  assert.equal(launchd?.kind, "launchd");
  assert.equal(launchd?.unitName, "com.routekit.gateway");

  const unsupported = await detectSupervisor("routekit", "gateway", {
    platform: "win32",
    runner: runnerFor("")
  });
  assert.equal(unsupported, undefined);
});

test("systemd controller install writes the unit and drives systemctl", async () => {
  const home = mkdtempSync(join(tmpdir(), "systemd-install-"));
  const calls: string[][] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    return { exitCode: 0, stdout: command === "systemctl" && args.includes("is-active") ? "active" : "running", stderr: "" };
  };
  try {
    const controller = await detectSupervisor("routekit", "gateway", {
      platform: "linux",
      runner,
      home
    });
    assert.ok(controller !== undefined);
    await controller.install({
      product: "routekit",
      kind: "gateway",
      description: "RouteKit model gateway",
      command: { execPath: "/usr/bin/node", args: ["/bin.js", "gateway", "serve"] },
      drainGraceMs: 30_000
    });
    const unit = readFileSync(controller.unitPath, "utf8");
    assert.match(unit, /ExecStart=\/usr\/bin\/node \/bin\.js gateway serve/);
    assert.equal(statSync(controller.unitPath).mode & 0o777, 0o600);
    assert.deepEqual(
      calls.filter((call) => call[0] === "systemctl").map((call) => call.slice(1)),
      [
        ["--user", "is-system-running"],
        ["--user", "is-active", "routekit-gateway.service"],
        ["--user", "daemon-reload"],
        ["--user", "enable", "routekit-gateway.service"],
        ["--user", "restart", "routekit-gateway.service"]
      ]
    );
    assert.ok(calls.some((call) => call[0] === "loginctl" && call[1] === "enable-linger"));

    const status = await controller.status();
    assert.deepEqual(status, { installed: true, active: true, detail: "active" });

    assert.equal(await controller.uninstall(), true);
    assert.throws(() => statSync(controller.unitPath));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("log rotation shifts files once the size cap is hit", () => {
  const home = mkdtempSync(join(tmpdir(), "log-rotate-"));
  try {
    const path = join(home, "svc.log");
    writeFileSync(path, "x".repeat(100));
    rotateLogFile(path, { maxBytes: 50, keep: 2 });
    assert.equal(readFileSync(`${path}.1`, "utf8").length, 100);
    writeFileSync(path, "y".repeat(100));
    rotateLogFile(path, { maxBytes: 50, keep: 2 });
    assert.equal(readFileSync(`${path}.1`, "utf8")[0], "y");
    assert.equal(readFileSync(`${path}.2`, "utf8")[0], "x");
    // Below the cap: no rotation.
    writeFileSync(path, "z");
    rotateLogFile(path, { maxBytes: 50, keep: 2 });
    assert.equal(readFileSync(path, "utf8"), "z");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("planUpgrade picks the strategy from record state", () => {
  assert.equal(planUpgrade({ record: undefined, version: "2.0.0" }), "start");
  assert.equal(
    planUpgrade({ record: sampleRecord({ version: "2.0.0" }), version: "2.0.0" }),
    "up-to-date"
  );
  assert.equal(
    planUpgrade({ record: sampleRecord({ version: "2.0.0" }), version: "2.0.0", force: true }),
    "drain-restart"
  );
  assert.equal(
    planUpgrade({ record: sampleRecord({ version: "1.0.0" }), version: "2.0.0" }),
    "drain-restart"
  );
  assert.equal(
    planUpgrade({
      record: sampleRecord({ version: "1.0.0", url: "https://gateway.routekit.localhost" }),
      version: "2.0.0"
    }),
    "blue-green"
  );
  assert.equal(
    planUpgrade({
      record: sampleRecord({ version: "1.0.0", supervisor: "systemd" }),
      version: "2.0.0"
    }),
    "supervisor-restart"
  );
});
