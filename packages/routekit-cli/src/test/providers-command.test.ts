import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const configPath = join(root, "router.yaml");
  const previousHome = process.env.ROUTEKIT_HOME;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
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
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  try {
    const models = await runJson([
      "--config",
      configPath,
      "--json",
      "models"
    ]);
    assert.equal(models.defaultModel, "openai/gpt-live");
    assert.deepEqual(models.models, ["openai/gpt-live"]);
    const explanation = await runJson([
      "--config",
      configPath,
      "--json",
      "models",
      "explain",
      "openai/gpt-live"
    ]);
    assert.deepEqual(explanation, {
      model: "openai/gpt-live",
      provider: "openai",
      nativeModel: "gpt-live",
      billingMode: "api_key",
      configuredDefault: true,
      capabilities: { streaming: "supported", tools: "degraded" },
      reasoning: null
    });

    const status = await runJson([
      "--config",
      configPath,
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
      "--config",
      configPath,
      "--json",
      "providers",
      "add",
      "codex",
      "--strategy",
      "round_robin"
    ]);
    assert.match(readFileSync(configPath, "utf8"), /codex:\n    strategy: round_robin/);
    await runJson([
      "--config",
      configPath,
      "--json",
      "providers",
      "remove",
      "codex"
    ]);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /codex:/);
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
    rmSync(root, { recursive: true, force: true });
  }
});
