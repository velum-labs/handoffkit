import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadRouterConfig,
  projectRouterConfigPath,
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
