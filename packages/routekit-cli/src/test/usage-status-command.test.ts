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
              resetsAt: now / 1000 + 2 * 60 * 60
            }
          },
          planType: "pro",
          observedAt: now / 1000 - 3 * 60,
          source: "headers"
        }
      }]
    }]
  };
  const gatewayUsage = {
    accountSets: [{
      mode: "claude-code",
      strategy: "sticky",
      switchThreshold: 0.9,
      members: [{
        id: "gateway",
        mode: "claude-code",
        label: "gateway",
        sourcePath: "/private/gateway.json",
        active: true,
        models: ["claude-sonnet"],
        limits: {
          windows: {
            five_hour: {
              utilization: 0.17,
              status: "ok",
              resetsAt: now / 1000 + 60 * 60
            }
          },
          observedAt: now / 1000,
          source: "usage"
        }
      }]
    }]
  };
  let proxyHealthy = true;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/usage");
    assert.equal(request.headers.authorization, "Bearer test-token");
    if (!proxyHealthy) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(usage));
  });
  let gatewayHealthy = true;
  const gatewayServer = createServer((request, response) => {
    assert.equal(request.url, "/usage");
    assert.equal(request.headers.authorization, undefined);
    if (!gatewayHealthy) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(gatewayUsage));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveListen) =>
    gatewayServer.listen(0, "127.0.0.1", resolveListen)
  );
  const gatewayPort = (gatewayServer.address() as AddressInfo).port;
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
  writeFileSync(join(state, "services", "gateway.json"), JSON.stringify({
    product: "routekit",
    owner: "routekit",
    kind: "gateway",
    pid: process.pid,
    url: `http://127.0.0.1:${gatewayPort}`,
    port: gatewayPort,
    startedAt: new Date(now - 30_000).toISOString()
  }));
  writeFileSync(join(state, "catalog", "models.json"), JSON.stringify({
    updatedAt: new Date(now).toISOString(),
    defaultModel: "openai/gpt",
    models: [{ id: "openai/gpt", provider: "openai" }]
  }));
  const env = {
    ...process.env,
    HOME: root,
    ROUTEKIT_HOME: state,
    OPENAI_API_KEY: "test-key",
    ROUTEKIT_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    PORTLESS: "0"
  };
  try {
    const json = await run(["--config", config, "--json", "usage"], env);
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), gatewayUsage);

    const human = await run(["--config", config, "usage"], env);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stderr, /five_hour/);
    assert.match(human.stderr, /17%/);

    gatewayHealthy = false;
    const proxyFallback = await run(["--config", config, "--json", "usage"], env);
    assert.equal(proxyFallback.code, 0, proxyFallback.stderr);
    assert.deepEqual(JSON.parse(proxyFallback.stdout), usage);
    rmSync(join(state, "services", "gateway.json"));

    const status = await run(["--config", config, "--json", "status"], env);
    assert.equal(status.code, 0, status.stderr);
    const overview = JSON.parse(status.stdout) as {
      services: Array<{ kind: string; running: boolean; reachable?: boolean }>;
      models: { count: number; defaultModel: string };
      providers: Array<{ provider: string; credentialAvailable: boolean }>;
    };
    assert.equal(overview.services.find((entry) => entry.kind === "accounts")?.running, true);
    assert.equal(overview.models.count, 1);
    assert.equal(overview.models.defaultModel, "openai/gpt");
    assert.equal(overview.providers[0]?.credentialAvailable, true);

    const emptyKeyStatus = await run(
      ["--config", config, "--json", "status"],
      { ...env, OPENAI_API_KEY: "" }
    );
    assert.equal(emptyKeyStatus.code, 0, emptyKeyStatus.stderr);
    const emptyKeyOverview = JSON.parse(emptyKeyStatus.stdout) as {
      providers: Array<{ credentialAvailable: boolean }>;
    };
    assert.equal(emptyKeyOverview.providers[0]?.credentialAvailable, false);

    proxyHealthy = false;
    const unreachableStatus = await run(["--config", config, "--json", "status"], env);
    assert.equal(unreachableStatus.code, 0, unreachableStatus.stderr);
    const unreachableOverview = JSON.parse(unreachableStatus.stdout) as {
      services: Array<{ kind: string; reachable?: boolean }>;
      accounts: { usageError?: string };
    };
    assert.equal(
      unreachableOverview.services.find((entry) => entry.kind === "accounts")?.reachable,
      false
    );
    assert.match(unreachableOverview.accounts.usageError ?? "", /503/);

    rmSync(join(state, "services", "accounts.json"));
    const down = await run(["--config", config, "usage"], env);
    assert.equal(down.code, 0, down.stderr);
    assert.match(down.stderr, /no enrolled accounts/i);
    assert.doesNotMatch(down.stderr, /accounts proxy is not running/i);

    const localJson = await run(["--config", config, "--json", "usage"], env);
    assert.equal(localJson.code, 0, localJson.stderr);
    assert.deepEqual(
      (JSON.parse(localJson.stdout) as {
        accountSets: Array<{ mode: string; members: unknown[] }>;
      }).accountSets.map((entry) => ({ mode: entry.mode, members: entry.members })),
      [
        { mode: "claude-code", members: [] },
        { mode: "codex", members: [] }
      ]
    );

    const codexDirectory = join(state, "subscriptions", "codex");
    mkdirSync(codexDirectory, { recursive: true });
    writeFileSync(
      join(codexDirectory, "local.json"),
      JSON.stringify({
        tokens: {
          access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
          refresh_token: "refresh-local",
          account_id: "acct-local"
        }
      })
    );
    writeFileSync(
      join(codexDirectory, ".state.json"),
      JSON.stringify({
        members: [{
          id: "local",
          limits: {
            windows: { primary: { utilization: 0.64 } },
            observedAt: now / 1000,
            source: "usage"
          }
        }]
      })
    );
    const enrolledLocal = await run(["--config", config, "usage"], env);
    assert.equal(enrolledLocal.code, 0, enrolledLocal.stderr);
    assert.match(enrolledLocal.stderr, /local/);
    assert.match(enrolledLocal.stderr, /64%/);
  } finally {
    await Promise.all([
      new Promise<void>((resolveClose, reject) =>
        server.close((error) => error === undefined ? resolveClose() : reject(error))
      ),
      new Promise<void>((resolveClose, reject) =>
        gatewayServer.close((error) => error === undefined ? resolveClose() : reject(error))
      )
    ]);
    rmSync(root, { recursive: true, force: true });
  }
});
