import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_SHARED_PACKAGES,
  canonicalSharedPackageViolations,
  fusionkitCompositionViolations,
  polynomialTrailingSlashRegexViolations,
  routekitDependencyViolations,
  routekitSourceViolations,
  toolRegistryCliSourceViolations,
  toolRegistryCompositionViolations,
  toolRegistryConstructionViolations,
  toolRegistryConsumerSourceViolations
} from "../scripts/lib/architecture-guards.mjs";

function workspacePackage(name, dependencies = {}) {
  return {
    manifestPath: `packages/${name.split("/")[1]}/package.json`,
    manifest: { name, dependencies }
  };
}

test("RouteKit dependency guard rejects direct and transitive FusionKit dependencies", () => {
  const manifests = [
    workspacePackage("@velum-labs/routekit-contracts"),
    workspacePackage("@velum-labs/routekit-registry", {
      "@velum-labs/routekit-contracts": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-gateway", {
      "@velum-labs/routekit-registry": "workspace:*"
    }),
    workspacePackage("@fusionkit/protocol", {
      "@velum-labs/routekit-contracts": "workspace:*"
    }),
    workspacePackage("@fusionkit/registry", {
      "@velum-labs/routekit-registry": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-bad-direct", {
      "@fusionkit/protocol": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-bad-transitive", {
      "@velum-labs/routekit-bad-direct": "workspace:*"
    })
  ];

  assert.deepEqual(
    routekitDependencyViolations(manifests).map((violation) => violation.dependencyPath),
    [
      ["@velum-labs/routekit-bad-direct", "@fusionkit/protocol"],
      ["@velum-labs/routekit-bad-transitive", "@velum-labs/routekit-bad-direct", "@fusionkit/protocol"]
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
  assert.match(
    canonicalSharedPackageViolations(manifests)[0],
    /must declare @velum-labs\/routekit-runtime/
  );
});

test("FusionKit composition guard rejects a transitive RouteKit CLI dependency", () => {
  const clean = [
    workspacePackage("@fusionkit/cli", {
      "@velum-labs/routekit-router": "workspace:*",
      "@velum-labs/routekit-config": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-router", {
      "@velum-labs/routekit-gateway": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit-config"),
    workspacePackage("@velum-labs/routekit-gateway")
  ];
  assert.deepEqual(fusionkitCompositionViolations(clean), []);

  const bad = [
    ...clean,
    workspacePackage("@velum-labs/routekit-bad-wrapper", {
      "@velum-labs/routekit": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit")
  ];
  bad[0].manifest.dependencies["@velum-labs/routekit-bad-wrapper"] = "workspace:*";
  assert.deepEqual(fusionkitCompositionViolations(bad), [
    "FusionKit dependency closure includes the RouteKit CLI: @fusionkit/cli -> @velum-labs/routekit-bad-wrapper -> @velum-labs/routekit"
  ]);
});

test("tool registry guard enforces one neutral composition point for both CLIs", () => {
  const clean = [
    workspacePackage("@velum-labs/routekit-tools"),
    workspacePackage("@velum-labs/routekit-tool-codex"),
    workspacePackage("@velum-labs/routekit-tool-claude"),
    workspacePackage("@velum-labs/routekit-tool-cursor"),
    workspacePackage("@velum-labs/routekit-tool-opencode"),
    workspacePackage("@velum-labs/routekit-tool-registry", {
      "@velum-labs/routekit-tools": "workspace:*",
      "@velum-labs/routekit-tool-codex": "workspace:*",
      "@velum-labs/routekit-tool-claude": "workspace:*",
      "@velum-labs/routekit-tool-cursor": "workspace:*",
      "@velum-labs/routekit-tool-opencode": "workspace:*"
    }),
    workspacePackage("@velum-labs/routekit", {
      "@velum-labs/routekit-tool-registry": "workspace:*"
    }),
    workspacePackage("@fusionkit/cli", {
      "@velum-labs/routekit-tool-registry": "workspace:*"
    })
  ];
  assert.deepEqual(toolRegistryCompositionViolations(clean), []);

  clean.at(-2).manifest.dependencies["@velum-labs/routekit-tool-codex"] = "workspace:*";
  assert.deepEqual(toolRegistryCompositionViolations(clean), [
    "@velum-labs/routekit must compose tools through @velum-labs/routekit-tool-registry, not @velum-labs/routekit-tool-codex"
  ]);
  delete clean.at(-2).manifest.dependencies["@velum-labs/routekit-tool-codex"];

  clean.at(-1).manifest.dependencies["@velum-labs/routekit-tool-cursor"] = "workspace:*";
  assert.deepEqual(toolRegistryCompositionViolations(clean), [
    "@fusionkit/cli must compose tools through @velum-labs/routekit-tool-registry, not @velum-labs/routekit-tool-cursor"
  ]);
});

test("tool registry source guard rejects parallel imports and construction", () => {
  assert.deepEqual(
    toolRegistryConsumerSourceViolations(
      "packages/cli/src/tools.ts",
      [
        'import { setToolDriverRegistry } from "@fusionkit/ensemble";',
        'import { toolRegistry } from "@velum-labs/routekit-tool-registry";',
        "setToolDriverRegistry(toolRegistry);"
      ].join("\n")
    ),
    []
  );
  assert.deepEqual(
    toolRegistryConsumerSourceViolations(
      "packages/routekit-cli/src/launch.ts",
      [
        'import { codexTool } from "@velum-labs/routekit-tool-codex";',
        'import { createToolRegistry } from "@velum-labs/routekit-tools";',
        "export const toolRegistry = createToolRegistry([codexTool]);"
      ].join("\n")
    ),
    [
      "packages/routekit-cli/src/launch.ts must not import individual tool integrations",
      "packages/routekit-cli/src/launch.ts must not construct a parallel tool registry"
    ]
  );
});

test("tool registry CLI source guard scans every production source", () => {
  const routekitSources = [
    {
      file: "packages/routekit-cli/src/launch.ts",
      source: 'import { toolRegistry } from "@velum-labs/routekit-tool-registry";'
    },
    {
      file: "packages/routekit-cli/src/commands/install.ts",
      source: 'export { installCodexIntegration } from "@velum-labs/routekit-tool-codex";'
    }
  ];
  assert.deepEqual(toolRegistryCliSourceViolations("@velum-labs/routekit", routekitSources), [
    "packages/routekit-cli/src/commands/install.ts must not import individual tool integrations"
  ]);

  const fusionkitSources = [
    {
      file: "packages/cli/src/tools.ts",
      source: [
        'import { toolRegistry } from "@velum-labs/routekit-tool-registry";',
        "setToolDriverRegistry(toolRegistry);"
      ].join("\n")
    },
    {
      file: "packages/cli/src/commands/setup.ts",
      source: 'const loadTool = () => import("@velum-labs/routekit-tool-cursor");'
    }
  ];
  assert.deepEqual(toolRegistryCliSourceViolations("@fusionkit/cli", fusionkitSources), [
    "packages/cli/src/commands/setup.ts must not import individual tool integrations"
  ]);
  assert.deepEqual(
    toolRegistryCliSourceViolations("@velum-labs/routekit", [
      { file: "packages/routekit-cli/src/commands.ts", source: "export const commands = [];" }
    ]),
    ["@velum-labs/routekit production sources must import @velum-labs/routekit-tool-registry"]
  );
});

test("tool registry construction guard allows exactly one production owner", () => {
  const owner = {
    file: "packages/tool-registry/src/index.ts",
    source: "export const toolRegistry = createToolRegistry(toolIntegrations);"
  };
  assert.deepEqual(toolRegistryConstructionViolations([owner]), []);
  assert.deepEqual(
    toolRegistryConstructionViolations([
      owner,
      {
        file: "packages/other/src/tools.ts",
        source: "export const otherRegistry = createToolRegistry([]);"
      }
    ]),
    ["packages/other/src/tools.ts constructs a parallel tool registry"]
  );
  assert.deepEqual(toolRegistryConstructionViolations([]), [
    "packages/tool-registry/src/index.ts must construct the canonical registry exactly once"
  ]);
});

test("trailing slash guard rejects polynomial regexes but allows fixed /v1 matching", () => {
  const file = "packages/example/src/url.ts";
  assert.deepEqual(
    polynomialTrailingSlashRegexViolations(
      file,
      'export const normalize = (url) => url.replace(/\\/+$/, "");'
    ),
    [
      "packages/example/src/url.ts uses a polynomial trailing-slash regex; use @velum-labs/routekit-runtime slash helpers"
    ]
  );
  assert.deepEqual(
    polynomialTrailingSlashRegexViolations(
      file,
      'export const withoutV1 = (url) => url.replace(/\\/v1\\/?$/, "");'
    ),
    []
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
