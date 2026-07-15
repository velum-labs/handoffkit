import assert from "node:assert/strict";
import { test } from "node:test";

import {
  routekitDependencyViolations,
  routekitSourceViolations
} from "../scripts/lib/architecture-guards.mjs";

function workspacePackage(name, dependencies = {}) {
  return {
    manifestPath: `packages/${name.split("/")[1]}/package.json`,
    manifest: { name, dependencies }
  };
}

test("RouteKit dependency guard rejects direct and transitive FusionKit dependencies", () => {
  const manifests = [
    workspacePackage("@routekit/contracts"),
    workspacePackage("@routekit/registry", {
      "@routekit/contracts": "workspace:*"
    }),
    workspacePackage("@routekit/gateway", {
      "@routekit/registry": "workspace:*"
    }),
    workspacePackage("@fusionkit/protocol", {
      "@routekit/contracts": "workspace:*"
    }),
    workspacePackage("@fusionkit/registry", {
      "@routekit/registry": "workspace:*"
    }),
    workspacePackage("@routekit/bad-direct", {
      "@fusionkit/protocol": "workspace:*"
    }),
    workspacePackage("@routekit/bad-transitive", {
      "@routekit/bad-direct": "workspace:*"
    })
  ];

  assert.deepEqual(
    routekitDependencyViolations(manifests).map((violation) => violation.dependencyPath),
    [
      ["@routekit/bad-direct", "@fusionkit/protocol"],
      ["@routekit/bad-transitive", "@routekit/bad-direct", "@fusionkit/protocol"]
    ]
  );
});

test("RouteKit source guard targets production paths, declarations, and imports", () => {
  assert.deepEqual(
    routekitSourceViolations(
      "packages/routekit-example/src/fusion-router.ts",
      'import { value } from "@fusionkit/protocol";\nexport const fusionPanel = value;\n'
    ),
    [
      "fusion vocabulary in production source path",
      "imports @fusionkit/*",
      "fusion vocabulary in a declared production name"
    ]
  );
  assert.deepEqual(
    routekitSourceViolations(
      "packages/routekit-example/src/catalog.ts",
      "// FusionKit is discussed in docs and tests, not banned as prose.\nexport const catalog = {};\n"
    ),
    []
  );
  assert.deepEqual(
    routekitSourceViolations(
      "packages/routekit-example/src/catalog.ts",
      'export const diffusionModel = { description: "supports diffusion models" };\n'
    ),
    []
  );
});
