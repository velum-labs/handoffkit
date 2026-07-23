/**
 * Generate the cross-language registry bindings from spec/registry/*.json.
 *
 * The JSON files under spec/registry/ are the single source of truth for
 * provider metadata (base URLs, key env vars, probes, discovery), subscription
 * auth metadata (Claude Code / Codex), cloud/local model catalogs,
 * model-family capability quirks, default pricing, and FusionKit-only model
 * identities/panel presets. This script keeps the ownership boundary explicit:
 *
 *   - packages/routekit-registry/src/generated/data.ts (@velum-labs/routekit-registry)
 *   - packages/registry/src/generated/data.ts          (@fusionkit/registry)
 *   - python/fusionkit-core/src/fusionkit_core/_generated/fusion_registry_data.py
 *
 * Run `node scripts/generate-registry.mjs` after editing any spec/registry
 * file; `--check` verifies the generated files are current (used by pnpm check).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const NEUTRAL_SPEC_FILES = [
  ["providers", "spec/registry/providers.json"],
  ["subscriptions", "spec/registry/subscriptions.json"],
  ["connectors", "spec/registry/connectors.json"],
  ["modelCatalog", "spec/registry/model-catalog.json"],
  ["modelCapabilities", "spec/registry/model-capabilities.json"],
  ["pricing", "spec/registry/pricing.json"],
  ["localCatalog", "spec/registry/local-catalog.json"]
];
const FUSION_SPEC_FILES = [["fusion", "spec/registry/fusion.json"]];

const TARGETS = [
  {
    files: NEUTRAL_SPEC_FILES,
    exportName: "REGISTRY",
    ts: "packages/routekit-registry/src/generated/data.ts"
  },
  {
    files: FUSION_SPEC_FILES,
    exportName: "FUSION_REGISTRY",
    ts: "packages/registry/src/generated/data.ts",
    py: "python/fusionkit-core/src/fusionkit_core/_generated/fusion_registry_data.py",
    pyTransform: runtimeFusionRegistry
  },
  {
    files: FUSION_SPEC_FILES,
    exportName: "BENCHMARK_REGISTRY",
    py: "python/fusionkit-evals/src/fusionkit_evals/_generated/benchmark_registry_data.py",
    pyTransform: benchmarkFusionRegistry
  }
];

const checkMode = process.argv.includes("--check");

function loadRegistry(specFiles) {
  const registry = {};
  for (const [key, path] of specFiles) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const section = parsed[key];
    if (section === undefined) {
      throw new Error(`${path} must carry its data under the "${key}" key`);
    }
    registry[key] = section;
  }
  return registry;
}

function runtimeFusionRegistry(registry) {
  const fusion = registry.fusion;
  return {
    fusion: {
      aliases: fusion.aliases,
      defaultAlias: fusion.defaultAlias,
      panelAlias: fusion.panelAlias,
      modeBySuffix: fusion.modeBySuffix,
      defaultMode: fusion.defaultMode
    }
  };
}

function benchmarkFusionRegistry(registry) {
  const panels = Object.fromEntries(
    Object.entries(registry.fusion.benchmarkPanels).map(([panelId, panel]) => [
      panelId,
      {
        ...panel,
        members: panel.members.map(({ id, model, provider }) => ({ id, model, provider }))
      }
    ])
  );
  return {
    benchmarkPanels: panels,
    gatewayDefaultBaseUrl: registry.fusion.gatewayDefaultBaseUrl,
    gatewayApiKeyEnv: registry.fusion.gatewayApiKeyEnv
  };
}

const HEADER_NOTE =
  "GENERATED FILE - DO NOT EDIT. Source of truth: spec/registry/*.json. " +
  "Regenerate with `node scripts/generate-registry.mjs`.";

function renderTs(registry, exportName) {
  const body = JSON.stringify(registry, null, 2);
  return `// ${HEADER_NOTE}\n\nexport const ${exportName} = ${body};\n`;
}

/** Serialize a JSON value as a Python literal (True/False/None instead of JSON). */
function toPython(value, indent) {
  const pad = "    ".repeat(indent);
  const childPad = "    ".repeat(indent + 1);
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${childPad}${toPython(item, indent + 1)}`);
    return `[\n${items.join(",\n")},\n${pad}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "{}";
  const items = entries.map(
    ([key, item]) => `${childPad}${JSON.stringify(key)}: ${toPython(item, indent + 1)}`
  );
  return `{\n${items.join(",\n")},\n${pad}}`;
}

function renderPy(registry, exportName) {
  return [
    `# ${HEADER_NOTE}`,
    "# ruff: noqa: E501",
    "from __future__ import annotations",
    "",
    "from typing import Any, Final",
    "",
    `${exportName}: Final[dict[str, Any]] = ${toPython(registry, 0)}`,
    ""
  ].join("\n");
}

function apply(path, content) {
  if (checkMode) {
    if (!existsSync(path)) {
      console.error(`registry check failed: missing generated file ${path}`);
      process.exitCode = 1;
      return;
    }
    const current = readFileSync(path, "utf8");
    if (current !== content) {
      console.error(
        `registry check failed: ${path} is stale; run \`node scripts/generate-registry.mjs\``
      );
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
}

for (const target of TARGETS) {
  const registry = loadRegistry(target.files);
  if (target.ts !== undefined) {
    apply(target.ts, renderTs(registry, target.exportName));
  }
  if (target.py !== undefined) {
    const pythonRegistry =
      target.pyTransform === undefined ? registry : target.pyTransform(registry);
    apply(target.py, renderPy(pythonRegistry, target.exportName));
  }
}

if (checkMode && process.exitCode === undefined) {
  console.log("registry check passed");
}
