import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadFusionConfig } from "@fusionkit/config";
import { loadRouterConfig } from "@routekit/config";

const cli = fileURLToPath(new URL("../index.js", import.meta.url));

function run(args: readonly string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FUSIONKIT_NO_TUI: "1",
      PORTLESS: "0"
    }
  });
}

test("init, config, and ensemble commands persist only Fusion v4 endpoint ids", () => {
  const repo = mkdtempSync(join(tmpdir(), "fusionkit-v4-commands-"));
  try {
    run(["--no-input", "init", "--repo", repo]);
    const initial = loadFusionConfig(repo);
    assert.equal(initial?.version, "fusionkit.fusion.v4");
    assert.deepEqual(initial?.router, { config: ".routekit/router.yaml" });
    assert.deepEqual(initial?.ensembles.default?.members, ["default"]);

    const router = loadRouterConfig({
      configPath: join(repo, ".routekit", "router.yaml")
    });
    assert.equal(router.config.endpoints[0]?.apiKeyEnv, "PROVIDER_API_KEY");
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
      "default",
      "--judge",
      "default",
      "--repo",
      repo
    ]);
    run(["config", "set", "defaultEnsemble", "review", "--repo", repo]);

    const updated = loadFusionConfig(repo);
    assert.equal(updated?.budgetUsd, 3);
    assert.equal(updated?.defaultEnsemble, "review");
    assert.deepEqual(updated?.ensembles.review, {
      members: ["default"],
      judge: "default"
    });
    const persisted = JSON.parse(
      readFileSync(join(repo, ".fusionkit", "fusion.json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal("provider" in persisted, false);
    assert.equal("subscriptionAccounts" in persisted, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
