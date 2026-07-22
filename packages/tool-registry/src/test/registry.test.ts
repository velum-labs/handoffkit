import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { toolIntegrations, toolRegistry } from "../index.js";

type PackageManifest = {
  dependencies?: Record<string, string>;
};

test("the canonical registry contains every declared tool integration exactly once", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as PackageManifest;
  const declaredToolPackages = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@routekit/tool-") && name !== "@routekit/tool-registry")
    .sort();
  const registeredToolPackages = toolIntegrations.map((integration) => integration.packageName).sort();

  assert.deepEqual(registeredToolPackages, declaredToolPackages);
  assert.equal(new Set(toolIntegrations).size, toolIntegrations.length);
  assert.deepEqual(toolRegistry.list(), toolIntegrations);
  assert.deepEqual(toolRegistry.drivers(), toolIntegrations);

  for (const integration of toolIntegrations) {
    assert.strictEqual(toolRegistry.get(integration.id), integration);
    assert.strictEqual(toolRegistry.driverForKind(integration.driver.kind), integration);
    for (const alias of integration.aliases ?? []) {
      assert.strictEqual(toolRegistry.get(alias), integration);
    }
  }
});
