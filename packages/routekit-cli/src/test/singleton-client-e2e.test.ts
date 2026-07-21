import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

function run(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env, timeout: 90_000 },
      (error, stdout, stderr) => {
        resolveRun({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr
        });
      }
    );
  });
}

test("concurrent product commands auto-start exactly one daemon and all use its gateway", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-singleton-clients-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const project = join(root, "project");
  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(home, ".config", "routekit", "router.yaml"),
    "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n"
  );
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
    } else {
      req.resume();
      req.on("end", () =>
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }))
      );
    }
  });
  await new Promise<void>((resolveListen) =>
    upstream.listen(0, "127.0.0.1", resolveListen)
  );
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: state,
    ROUTEKIT_PORTLESS: "0",
    ROUTEKIT_DAEMON_PORT: "0",
    OPENAI_API_KEY: "test",
    OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    NO_COLOR: "1"
  };
  let pid: number | undefined;
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, async () =>
        await run(["models", "list", "--json"], project, env)
      )
    );
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(
        (JSON.parse(result.stdout) as { models: string[] }).models,
        ["openai/mock-model"]
      );
    }
    const recordPath = join(state, "services", "daemon.json");
    assert.ok(existsSync(recordPath));
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      pid: number;
      controlToken?: string;
      dataUrl?: string;
    };
    pid = record.pid;
    assert.equal(typeof record.controlToken, "string");
    assert.equal(typeof record.dataUrl, "string");
    const status = await run(["daemon", "status", "--json"], project, env);
    assert.equal(status.code, 0, status.stderr);
    assert.equal((JSON.parse(status.stdout) as { pid: number }).pid, pid);
    const overviewResult = await run(["status", "--json"], project, env);
    assert.equal(overviewResult.code, 0, overviewResult.stderr);
    const overview = JSON.parse(overviewResult.stdout) as {
      daemon?: { pid?: number };
      services?: Array<{ kind?: string; running?: boolean }>;
      models?: { count?: number; defaultModel?: string };
      providers?: Array<{ provider?: string; credentialAvailable?: boolean }>;
      accounts?: { running?: boolean; accounts?: unknown[] };
    };
    assert.equal(overview.daemon?.pid, pid);
    assert.equal(
      overview.services?.find((service) => service.kind === "gateway")?.running,
      true
    );
    assert.equal(overview.models?.count, 1);
    assert.equal(overview.models?.defaultModel, "openai/mock-model");
    assert.equal(overview.providers?.[0]?.credentialAvailable, true);
    assert.equal(overview.accounts?.running, true);
    const warmOverride = await run(
      ["models", "list"],
      project,
      { ...env, ROUTEKIT_CONFIG: join(project, "other.yaml") }
    );
    assert.equal(warmOverride.code, 1);
    assert.match(warmOverride.stderr, /not supported by singleton daemon operations/);
    const serviceStatus = await run(
      ["daemon", "service", "status", "--json"],
      project,
      env
    );
    assert.equal(serviceStatus.code, 0, serviceStatus.stderr);
    assert.doesNotMatch(serviceStatus.stdout, new RegExp(record.controlToken!));
    assert.equal(serviceStatus.stdout.includes("controlToken"), false);
    const stopped = await run(["daemon", "stop", "--json"], project, env);
    assert.equal(stopped.code, 0, stopped.stderr);
    pid = undefined;
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("project overlays require explicit import into the canonical global config", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-singleton-import-"));
  const home = join(root, "home");
  const state = join(root, "state");
  const project = join(root, "project");
  mkdirSync(join(project, ".routekit"), { recursive: true });
  const overlay = join(project, ".routekit", "router.yaml");
  writeFileSync(
    overlay,
    "providers:\n  openai: {}\ndefaultModel: openai/mock-model\n"
  );
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: state,
    ROUTEKIT_PORTLESS: "0",
    OPENAI_API_KEY: "test",
    // Unreachable is fine for the first diagnostic; import startup will fail
    // discovery, so only verify the explicit migration guidance here.
    OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    NO_COLOR: "1"
  };
  try {
    const result = await run(["models", "list"], project, env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /config import --from/);
    assert.match(result.stderr, /\.routekit\/router\.yaml/);
    assert.equal(
      existsSync(join(home, ".config", "routekit", "router.yaml")),
      false,
      "the daemon must never silently adopt a project overlay"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit external gateway launch neither boots local daemon nor leaks its token", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-external-launch-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const codex = join(bin, "codex");
  writeFileSync(codex, "#!/bin/sh\nexit 0\n");
  chmodSync(codex, 0o755);
  const authorizations: Array<string | undefined> = [];
  const gateway = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: [{ id: "openai/external-model", capabilities: {} }]
      })
    );
  });
  await new Promise<void>((resolveListen) =>
    gateway.listen(0, "127.0.0.1", resolveListen)
  );
  const port = (gateway.address() as AddressInfo).port;
  const state = join(root, "state");
  try {
    const result = await run(
      [
        "codex",
        "openai/external-model",
        "--gateway-url",
        `http://127.0.0.1:${port}`,
        "--auth-token",
        "external-secret"
      ],
      root,
      {
        ...process.env,
        HOME: join(root, "home"),
        ROUTEKIT_HOME: state,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        NO_COLOR: "1"
      }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(authorizations, ["Bearer external-secret"]);
    assert.equal(existsSync(join(state, "services", "daemon.json")), false);
    assert.equal(existsSync(join(state, "secrets", "data-token")), false);
  } finally {
    await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

