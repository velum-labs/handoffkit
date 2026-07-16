import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadFusionConfig } from "@fusionkit/config";
import { startProviderSim } from "@fusionkit/testkit";
import { loadRouterConfig } from "@routekit/config";

import { configuredDefaultToolArgv } from "../commands/palette.js";

const cli = fileURLToPath(new URL("../index.js", import.meta.url));

function run(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {}
): string {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      FUSIONKIT_NO_TUI: "1",
      PORTLESS: "0"
    }
  });
}

test("init, config, and ensemble commands persist only Fusion v4 model ids", async () => {
  const sim = await startProviderSim();
  await sim.queue("gpt-5.5", ["discovery fixture"]);
  const providerEnv = {
    OPENAI_API_KEY: "test-provider-key",
    OPENAI_BASE_URL: `${sim.url}/v1`
  };
  const repo = mkdtempSync(join(tmpdir(), "fusionkit-v4-commands-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    run(["--no-input", "init", "--repo", repo], providerEnv);
    const initial = loadFusionConfig(repo);
    assert.equal(initial?.version, "fusionkit.fusion.v4");
    assert.deepEqual(initial?.router, { config: ".routekit/router.yaml" });
    assert.deepEqual(initial?.ensembles.default?.members, ["openai/gpt-5.5"]);

    const router = loadRouterConfig({
      configPath: join(repo, ".routekit", "router.yaml")
    });
    assert.ok(router.config.providers.openai !== undefined);
    assert.doesNotMatch(
      readFileSync(router.path, "utf8"),
      /(?:apiKey|authorization|token):/
    );

    run(["config", "set", "budgetUsd", "3", "--repo", repo]);
    run([
      "ensemble",
      "add",
      "review",
      "--member",
      "openai/gpt-5.5",
      "--judge",
      "openai/gpt-5.5",
      "--repo",
      repo
    ]);
    run(["config", "set", "defaultEnsemble", "review", "--repo", repo]);
    run(["config", "set", "router.url", "http://127.0.0.1:9999", "--repo", repo]);
    assert.deepEqual(loadFusionConfig(repo)?.router, {
      url: "http://127.0.0.1:9999"
    });
    run([
      "config",
      "set",
      "router.config",
      ".routekit/router.yaml",
      "--repo",
      repo
    ]);
    run(["config", "set", "tool", "claude", "--repo", repo]);

    const updated = loadFusionConfig(repo);
    assert.equal(updated?.budgetUsd, 3);
    assert.equal(updated?.defaultEnsemble, "review");
    assert.deepEqual(updated?.router, { config: ".routekit/router.yaml" });
    assert.deepEqual(configuredDefaultToolArgv(repo), ["claude"]);
    assert.deepEqual(updated?.ensembles.review, {
      members: ["openai/gpt-5.5"],
      judge: "openai/gpt-5.5"
    });
    const persisted = JSON.parse(
      readFileSync(join(repo, ".fusionkit", "fusion.json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal("provider" in persisted, false);
    assert.equal("subscriptionAccounts" in persisted, false);
  } finally {
    await sim.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI rejects typo flags, gates passthrough behind --, and rejects interactive JSON", () => {
  const beforeDelimiter = spawnSync(process.execPath, [cli, "serve", "--typo"], {
    encoding: "utf8"
  });
  assert.notEqual(beforeDelimiter.status, 0);
  assert.match(beforeDelimiter.stderr, /unknown option.*--typo/i);

  const afterDelimiter = spawnSync(
    process.execPath,
    [cli, "serve", "--", "--typo"],
    { encoding: "utf8" }
  );
  assert.notEqual(afterDelimiter.status, 0);
  assert.match(afterDelimiter.stderr, /does not accept passthrough arguments/i);

  const interactiveJson = spawnSync(
    process.execPath,
    [cli, "--json", "codex"],
    { encoding: "utf8" }
  );
  assert.notEqual(interactiveJson.status, 0);
  assert.match(interactiveJson.stdout, /does not support --json/);
  assert.doesNotThrow(() => JSON.parse(interactiveJson.stdout));
});
