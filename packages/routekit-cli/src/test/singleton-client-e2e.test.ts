import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
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

