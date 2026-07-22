import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildProgram } from "../cli.js";
import { completionCandidates } from "../completion.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "index.js"
);

async function runJson(args: readonly string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI_ENTRY, ...args],
    { env: process.env, encoding: "utf8" }
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("providers and models commands use the live namespaced catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-provider-command-"));
  const home = join(root, "home");
  const configPath = join(home, ".config", "routekit", "router.yaml");
  mkdirSync(join(home, ".config", "routekit"), { recursive: true });
  const previousOsHome = process.env.HOME;
  const previousHome = process.env.ROUTEKIT_HOME;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousPortless = process.env.ROUTEKIT_PORTLESS;
  const previousDaemonPort = process.env.ROUTEKIT_DAEMON_PORT;
  const previousNoSupervisor = process.env.ROUTEKIT_NO_SUPERVISOR;
  let providerHealthy = true;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    if (!providerHealthy) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: "gpt-live",
            capabilities: { streaming: "supported", tools: "degraded" }
          }
        ]
      })
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve)
  );
  const port = (server.address() as AddressInfo).port;
  writeFileSync(
    configPath,
    "providers:\n  openai: {}\ndefaultModel: openai/gpt-live\n"
  );
  process.env.ROUTEKIT_HOME = join(root, "state");
  process.env.HOME = home;
  process.env.ROUTEKIT_PORTLESS = "0";
  process.env.ROUTEKIT_DAEMON_PORT = "0";
  process.env.ROUTEKIT_NO_SUPERVISOR = "1";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const models = await runJson(["--json", "models"]);
    assert.equal(models.defaultModel, "openai/gpt-live");
    assert.deepEqual(models.models, ["openai/gpt-live"]);
    const filtered = await runJson([
      "--json",
      "models",
      "list",
      "--provider",
      "openai"
    ]);
    assert.deepEqual(filtered.models, ["openai/gpt-live"]);
    const info = await runJson([
      "--json",
      "models",
      "info",
      "openai/gpt-live"
    ]);
    assert.equal(info.provider, "openai");
    assert.equal(info.default, true);

    const status = await runJson([
      "--json",
      "providers",
      "status"
    ]);
    assert.deepEqual(
      (status.providers as Array<{ provider: string; models: string[] }>).map(
        (entry) => [entry.provider, entry.models]
      ),
      [["openai", ["openai/gpt-live"]]]
    );
    assert.deepEqual(
      completionCandidates(buildProgram(), ["codex", "openai/g"]),
      ["openai/gpt-live"]
    );

    await runJson([
      "--json",
      "providers",
      "add",
      "openai",
      "--strategy",
      "round_robin"
    ]);
    assert.match(readFileSync(configPath, "utf8"), /strategy: round_robin/);
    providerHealthy = false;
    await assert.rejects(
      runJson(["--json", "providers", "status"]),
      (error: unknown) => {
        const stdout =
          typeof error === "object" &&
          error !== null &&
          "stdout" in error
            ? String((error as { stdout?: unknown }).stdout)
            : "";
        assert.match(stdout, /503|discovery/i);
        return true;
      }
    );
    await runJson(["--json", "daemon", "stop"]);
  } finally {
    if (previousOsHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousOsHome;
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousPortless === undefined) delete process.env.ROUTEKIT_PORTLESS;
    else process.env.ROUTEKIT_PORTLESS = previousPortless;
    if (previousDaemonPort === undefined) delete process.env.ROUTEKIT_DAEMON_PORT;
    else process.env.ROUTEKIT_DAEMON_PORT = previousDaemonPort;
    if (previousNoSupervisor === undefined) delete process.env.ROUTEKIT_NO_SUPERVISOR;
    else process.env.ROUTEKIT_NO_SUPERVISOR = previousNoSupervisor;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    rmSync(root, { recursive: true, force: true });
  }
});
