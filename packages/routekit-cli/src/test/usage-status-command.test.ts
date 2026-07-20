import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

type Result = { code: number; stdout: string; stderr: string };

function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolveResult) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { env, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolveResult({
          code: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr
        });
      }
    );
  });
}

test("usage and status expose human and JSON snapshots from a stub accounts proxy", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-usage-command-"));
  const state = join(root, "state");
  const config = join(root, "router.yaml");
  const now = Date.now();
  const usage = {
    accountSets: [{
      mode: "codex",
      strategy: "sticky",
      switchThreshold: 0.9,
      members: [{
        id: "work",
        mode: "codex",
        label: "work",
        sourcePath: "/private/work.json",
        active: true,
        models: ["codex/gpt"],
        limits: {
          windows: {
            five_hour: {
              utilization: 0.52,
              status: "ok",
              resetsAt: now + 2 * 60 * 60 * 1000
            }
          },
          planType: "pro",
          observedAt: now - 3 * 60 * 1000,
          source: "headers"
        }
      }]
    }]
  };
  const server = createServer((request, response) => {
    assert.equal(request.url, "/usage");
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(usage));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(join(state, "services"), { recursive: true });
  mkdirSync(join(state, "catalog"), { recursive: true });
  writeFileSync(config, "providers:\n  openai: {}\ndefaultModel: openai/gpt\n");
  writeFileSync(join(state, "services", "accounts.json"), JSON.stringify({
    product: "routekit",
    owner: "routekit",
    kind: "accounts",
    pid: process.pid,
    url: `http://127.0.0.1:${port}`,
    port,
    startedAt: new Date(now - 60_000).toISOString(),
    authToken: "test-token"
  }));
  writeFileSync(join(state, "catalog", "models.json"), JSON.stringify({
    updatedAt: new Date(now).toISOString(),
    defaultModel: "openai/gpt",
    models: [{ id: "openai/gpt", provider: "openai" }]
  }));
  const env = {
    ...process.env,
    ROUTEKIT_HOME: state,
    OPENAI_API_KEY: "test-key",
    ROUTEKIT_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    PORTLESS: "0"
  };
  try {
    const json = await run(["--config", config, "--json", "usage"], env);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), usage);

    const human = await run(["--config", config, "usage"], env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stderr, /five_hour/);
    assert.match(human.stderr, /52%/);
    assert.match(human.stderr, /observed 3m ago via headers/);

    const status = await run(["--config", config, "--json", "status"], env);
    assert.equal(status.code, 0, status.stderr);
    const overview = JSON.parse(status.stdout) as {
      services: Array<{ kind: string; running: boolean }>;
      models: { count: number; defaultModel: string };
      providers: Array<{ provider: string; credentialAvailable: boolean }>;
    };
    assert.equal(overview.services.find((entry) => entry.kind === "accounts")?.running, true);
    assert.equal(overview.models.count, 1);
    assert.equal(overview.models.defaultModel, "openai/gpt");
    assert.equal(overview.providers[0]?.credentialAvailable, true);

    rmSync(join(state, "services", "accounts.json"));
    const down = await run(["--config", config, "usage"], env);
    assert.equal(down.code, 1);
    assert.match(down.stderr, /accounts proxy is not running/i);
    assert.match(down.stderr, /routekit accounts serve/);
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => error === undefined ? resolveClose() : reject(error))
    );
    rmSync(root, { recursive: true, force: true });
  }
});
