import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stringify as stringifyYaml } from "yaml";

import {
  loadRouterConfig,
  migrateLegacyState,
  projectRouterConfigPath,
  writeRouterConfig
} from "../config.js";

function config(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    endpoints: [
      {
        endpointId: id,
        model: `${id}-upstream`,
        baseUrl: "https://example.test/v1",
        apiKeyEnv: "TEST_API_KEY"
      }
    ],
    defaultEndpointId: id,
    ...extra
  };
}

test("project config overrides global and explicit config overrides both", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-test-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const nested = join(project, "src");
  mkdirSync(nested, { recursive: true });
  writeRouterConfig(join(home, ".config", "routekit", "router.yaml"), config("global", {
    cooldownMs: 10
  }));
  writeRouterConfig(projectRouterConfigPath(project), config("project"));
  const explicit = join(root, "explicit.yaml");
  writeRouterConfig(explicit, config("explicit"));

  const layered = loadRouterConfig({ cwd: nested, home, env: {} });
  assert.equal(layered.config.defaultEndpointId, "project");
  assert.equal(layered.config.cooldownMs, 10);
  assert.deepEqual(layered.sources, ["project", "global"]);

  const overridden = loadRouterConfig({
    cwd: nested,
    home,
    env: { ROUTEKIT_CONFIG: explicit }
  });
  assert.equal(overridden.config.defaultEndpointId, "explicit");
  assert.deepEqual(overridden.sources, ["environment"]);
});

test("project account overlays merge providers and individual policy fields", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-accounts-"));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  writeRouterConfig(
    join(home, ".config", "routekit", "router.yaml"),
    config("global", {
      accounts: {
        codex: {
          strategy: "round_robin",
          switchThreshold: 0.75
        }
      }
    })
  );
  writeRouterConfig(
    projectRouterConfigPath(project),
    config("project", {
      accounts: {
        claudeCode: { enabled: false },
        codex: { probeIntervalMs: 12_000 }
      }
    })
  );

  const loaded = loadRouterConfig({ cwd: project, home, env: {} });
  assert.equal(loaded.config.accounts?.["claude-code"]?.enabled, false);
  assert.equal(loaded.config.accounts?.codex?.strategy, "round_robin");
  assert.equal(loaded.config.accounts?.codex?.switchThreshold, 0.75);
  assert.equal(loaded.config.accounts?.codex?.probeIntervalMs, 12_000);
});

test("config rejects inline credentials and writes atomically with private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-safe-"));
  const path = join(root, "router.yaml");
  writeRouterConfig(path, config("safe"));
  assert.equal(statSync(path).mode & 0o777, 0o600);

  writeFileSync(
    path,
    stringifyYaml({
      endpoints: [
        {
          endpointId: "unsafe",
          model: "model",
          baseUrl: "https://example.test/v1",
          apiKey: "must-not-be-stored"
        }
      ]
    })
  );
  assert.throws(
    () => loadRouterConfig({ configPath: path, env: {} }),
    /inline credential field/
  );
  writeFileSync(
    path,
    stringifyYaml({
      endpoints: [
        {
          endpointId: "unsafe-google",
          model: "model",
          baseUrl: "https://example.test/v1beta",
          dialect: "google",
          headers: { "x-goog-api-key": "must-not-be-stored" }
        }
      ]
    })
  );
  assert.throws(
    () => loadRouterConfig({ configPath: path, env: {} }),
    /inline credential field "endpoints\[0\]\.headers\.x-goog-api-key"/
  );
});

test("migration is explicit, idempotent, and preserves private permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-migrate-test-"));
  const home = join(root, "home");
  const stateHome = join(root, "routekit-home");
  const source = join(home, ".fusionkit", "subscriptions", "codex");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "account.json"), "{}\n");

  const first = migrateLegacyState({ home, stateHome });
  assert.equal(first.filter((entry) => entry.action === "copied").length, 1);
  const destination = join(stateHome, "subscriptions", "codex", "account.json");
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.equal(statSync(join(stateHome, "subscriptions", "codex")).mode & 0o777, 0o700);

  const second = migrateLegacyState({ home, stateHome });
  assert.equal(second.some((entry) => entry.action === "copied"), false);
  assert.equal(second.some((entry) => entry.action === "skipped"), true);
});

test("legacy subscription directory aliases migrate canonically and reject collisions", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-migrate-alias-"));
  const home = join(root, "home");
  const stateHome = join(root, "routekit-home");
  const sourceRoot = join(home, ".fusionkit", "subscriptions");
  mkdirSync(join(sourceRoot, "claude"), { recursive: true });
  writeFileSync(join(sourceRoot, "claude", "primary.json"), "{}\n");
  const actions = migrateLegacyState({ home, stateHome });
  assert.equal(
    actions.some((entry) =>
      entry.destination.endsWith(
        join("subscriptions", "claude-code", "primary.json")
      )
    ),
    true
  );

  mkdirSync(join(sourceRoot, "claudeCode"), { recursive: true });
  assert.throws(
    () => migrateLegacyState({ home, stateHome: join(root, "other-state") }),
    /both map to "claude-code"/
  );
});
