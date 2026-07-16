import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseRouterConfig } from "@routekit/gateway";

import {
  assertEndpointIdsConfigured,
  configuredEndpointIds,
  globalRouterConfigPath,
  loadRouterConfig,
  missingEndpointIds,
  projectRouterConfigPath,
  resolveEndpointId,
  updateEffectiveRouterConfig,
  writeRouterConfig
} from "../index.js";

test("router config discovery and IO are reusable outside the CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-sdk-"));
  try {
    const path = projectRouterConfigPath(directory);
    writeRouterConfig(path, {
      endpoints: [
        {
          endpointId: "opaque",
          model: "provider-model",
          baseUrl: "https://example.test",
          dialect: "openai",
          apiKeyEnv: "EXAMPLE_API_KEY"
        }
      ],
      defaultEndpointId: "opaque"
    });
    const persisted = readFileSync(path, "utf8");
    assert.doesNotMatch(persisted, /cooldownMs|strategy|accounts/);
    const loaded = loadRouterConfig({ cwd: directory, home: directory, env: {} });
    assert.equal(loaded.path, path);
    assert.equal(loaded.config.endpoints[0]?.endpointId, "opaque");
    assert.deepEqual(loaded.sources, ["project"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("router config rejects inline credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-sdk-"));
  try {
    assert.throws(
      () =>
        writeRouterConfig(join(directory, "router.yaml"), {
          endpoints: [
            {
              endpointId: "opaque",
              model: "provider-model",
              baseUrl: "https://example.test",
              dialect: "openai",
              apiKey: "secret"
            }
          ]
        }),
      /inline credential/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy account aliases normalize while sparse project mutations stay sparse", () => {
  const directory = mkdtempSync(join(tmpdir(), "routekit-config-layers-"));
  const home = join(directory, "home");
  const project = join(directory, "project");
  try {
    mkdirSync(project, { recursive: true });
    writeRouterConfig(globalRouterConfigPath(home), {
      endpoints: [
        {
          endpointId: "global",
          model: "upstream",
          baseUrl: "https://example.test/v1"
        }
      ],
      strategy: "round_robin"
    });
    const projectPath = projectRouterConfigPath(project);
    mkdirSync(join(project, ".routekit"), { recursive: true });
    writeFileSync(projectPath, "accounts:\n  claudeCode:\n    enabled: false\n");

    const loaded = loadRouterConfig({ cwd: project, home, env: {} });
    assert.equal(loaded.config.accounts?.["claude-code"]?.enabled, false);
    updateEffectiveRouterConfig({ cwd: project, home, env: {} }, (draft) => {
      draft.accounts = {
        ...(draft.accounts as Record<string, unknown>),
        "claude-code": { enabled: true }
      };
    });

    const persisted = readFileSync(projectPath, "utf8");
    assert.match(persisted, /claude-code:/);
    assert.doesNotMatch(persisted, /claudeCode|endpoints|strategy|cooldownMs/);
    assert.equal(
      loadRouterConfig({ cwd: project, home, env: {} }).config.accounts?.[
        "claude-code"
      ]?.enabled,
      true
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const endpointConfig = parseRouterConfig({
  endpoints: [
    {
      endpointId: "alpha",
      instanceId: "alpha-primary",
      model: "upstream-a",
      baseUrl: "https://example.test/a",
      dialect: "openai"
    },
    {
      endpointId: "beta",
      model: "upstream-b",
      baseUrl: "https://example.test/b",
      dialect: "openai"
    },
    {
      endpointId: "alpha",
      instanceId: "alpha-secondary",
      model: "upstream-a",
      baseUrl: "https://example.test/a-secondary",
      dialect: "openai"
    }
  ],
  defaultEndpointId: "beta"
});

test("configuredEndpointIds returns unique ids in declaration order", () => {
  assert.deepEqual(configuredEndpointIds(endpointConfig), ["alpha", "beta"]);
});

test("resolveEndpointId accepts explicit ids and resolves configured defaults", () => {
  assert.equal(resolveEndpointId(endpointConfig), "beta");
  assert.equal(resolveEndpointId(endpointConfig, "alpha"), "alpha");

  const withoutDefault = parseRouterConfig({ endpoints: endpointConfig.endpoints });
  assert.equal(resolveEndpointId(withoutDefault), "alpha");

  assert.throws(
    () => resolveEndpointId(endpointConfig, "gamma"),
    /unknown endpoint "gamma" \(configured: alpha, beta\)/
  );
});

test("missingEndpointIds returns unique missing ids in required order", () => {
  assert.deepEqual(
    missingEndpointIds(["beta", "gamma", "gamma", "alpha", "delta"], ["alpha", "beta"]),
    ["gamma", "delta"]
  );
});

test("assertEndpointIdsConfigured rejects missing required ids", () => {
  assert.doesNotThrow(() =>
    assertEndpointIdsConfigured(["alpha", "beta"], configuredEndpointIds(endpointConfig))
  );
  assert.throws(
    () =>
      assertEndpointIdsConfigured(
        ["gamma", "delta"],
        configuredEndpointIds(endpointConfig),
        "bad routes"
      ),
    /bad routes: gamma, delta/
  );
});
