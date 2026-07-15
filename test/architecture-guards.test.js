import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_SHARED_PACKAGES,
  canonicalSharedPackageViolations,
  fusionkitCompositionViolations,
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

test("canonical shared package guard pins every owner name to its path", () => {
  const manifests = [...CANONICAL_SHARED_PACKAGES].map(([dir, name]) => ({
    dir,
    manifestPath: `${dir}/package.json`,
    manifest: { name }
  }));
  assert.deepEqual(canonicalSharedPackageViolations(manifests), []);
  const runtime = manifests.find((entry) => entry.dir === "packages/runtime-utils");
  assert.ok(runtime);
  runtime.manifest.name = "@fusionkit/runtime-utils";
  assert.match(canonicalSharedPackageViolations(manifests)[0], /must declare @routekit\/runtime/);
});

test("FusionKit composition guard rejects a transitive RouteKit CLI dependency", () => {
  const clean = [
    workspacePackage("@fusionkit/cli", {
      "@routekit/router": "workspace:*",
      "@routekit/config": "workspace:*"
    }),
    workspacePackage("@routekit/router", {
      "@routekit/gateway": "workspace:*"
    }),
    workspacePackage("@routekit/config"),
    workspacePackage("@routekit/gateway")
  ];
  assert.deepEqual(fusionkitCompositionViolations(clean), []);

  const bad = [
    ...clean,
    workspacePackage("@routekit/bad-wrapper", {
      "@routekit/cli": "workspace:*"
    }),
    workspacePackage("@routekit/cli")
  ];
  bad[0].manifest.dependencies["@routekit/bad-wrapper"] = "workspace:*";
  assert.deepEqual(fusionkitCompositionViolations(bad), [
    "FusionKit dependency closure includes the RouteKit CLI: @fusionkit/cli -> @routekit/bad-wrapper -> @routekit/cli"
  ]);
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
