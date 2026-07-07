/**
 * Generate the fusion trace semantic-convention bindings from
 * spec/fusion-trace/registry.json.
 *
 * The registry is the single source of truth for fusion span names, attribute
 * keys, and per-attribute sensitivity classes. This script embeds it into:
 *
 *   - packages/protocol/src/generated/trace-conventions.ts  (dependency-free constants)
 *   - python/fusionkit-core/src/fusionkit_core/_generated/trace_conventions.py
 *   - apps/scope/lib/generated/trace-conventions.ts
 *
 * Run `node scripts/generate-trace-conventions.mjs` after editing the
 * registry; `--check` verifies the generated files are current (pnpm check).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const SOURCE = "spec/fusion-trace/registry.json";
const TARGETS = {
  protocol: "packages/protocol/src/generated/trace-conventions.ts",
  python: "python/fusionkit-core/src/fusionkit_core/_generated/trace_conventions.py",
  scope: "apps/scope/lib/generated/trace-conventions.ts"
};

const checkMode = process.argv.includes("--check");

const registry = JSON.parse(readFileSync(SOURCE, "utf8"));
const spans = registry.spans;
const attributes = registry.attributes;

const HEADER_NOTE =
  "GENERATED FILE - DO NOT EDIT. Source of truth: spec/fusion-trace/registry.json. " +
  "Regenerate with `node scripts/generate-trace-conventions.mjs`.";

const spanNames = Object.keys(spans);
const markerNames = spanNames.filter((name) => spans[name].kind === "marker");
const realSpanNames = spanNames.filter((name) => spans[name].kind === "span");
const exportableAttrs = Object.entries(attributes)
  .filter(([, def]) => def.sensitivity === "exportable")
  .map(([key]) => key);

function constName(key) {
  return key.replace(/[.\-]/g, "_").toUpperCase();
}

function renderTs() {
  const lines = [
    `// ${HEADER_NOTE}`,
    "",
    "/** Every span name a fusion component may emit. */",
    `export const FUSION_SPAN_NAMES = ${JSON.stringify(spanNames, null, 2)} as const;`,
    "",
    "export type FusionSpanName = (typeof FUSION_SPAN_NAMES)[number];",
    "",
    "/** Zero-duration marker spans: live point-in-time signals. */",
    `export const FUSION_MARKER_NAMES = ${JSON.stringify(markerNames, null, 2)} as const;`,
    "",
    "export type FusionMarkerName = (typeof FUSION_MARKER_NAMES)[number];",
    "",
    "/** Real spans: units of work with duration. */",
    `export const FUSION_UNIT_SPAN_NAMES = ${JSON.stringify(realSpanNames, null, 2)} as const;`,
    "",
    "/** Attribute keys, one constant per registry attribute. */",
    "export const ATTR = {"
  ];
  for (const key of Object.keys(attributes)) {
    lines.push(`  ${constName(key)}: ${JSON.stringify(key)},`);
  }
  lines.push(
    "} as const;",
    "",
    "export type FusionAttributeKey = (typeof ATTR)[keyof typeof ATTR];",
    "",
    "/** Attributes safe to leave the machine (product telemetry / remote OTLP). */",
    `export const EXPORTABLE_ATTRIBUTES: ReadonlySet<string> = new Set(${JSON.stringify(exportableAttrs, null, 2)});`,
    "",
    "/** component name -> OTel instrumentation scope name */",
    `export const FUSION_SCOPES = ${JSON.stringify(registry.components, null, 2)} as const;`,
    "",
    `export const FUSION_CONVENTIONS_VERSION = ${JSON.stringify(registry.version)};`,
    ""
  );
  return lines.join("\n");
}

function renderPy() {
  const lines = [
    `# ${HEADER_NOTE}`,
    "# ruff: noqa: E501",
    "from __future__ import annotations",
    "",
    "from typing import Final",
    "",
    `FUSION_SPAN_NAMES: Final[tuple[str, ...]] = (${spanNames.map((n) => JSON.stringify(n)).join(", ")},)`,
    "",
    `FUSION_MARKER_NAMES: Final[tuple[str, ...]] = (${markerNames.map((n) => JSON.stringify(n)).join(", ")},)`,
    "",
    ""
  ];
  lines.push("class ATTR:");
  lines.push('    """Attribute keys, one constant per registry attribute."""');
  lines.push("");
  for (const key of Object.keys(attributes)) {
    lines.push(`    ${constName(key)}: Final[str] = ${JSON.stringify(key)}`);
  }
  lines.push(
    "",
    "",
    `EXPORTABLE_ATTRIBUTES: Final[frozenset[str]] = frozenset({${exportableAttrs.map((k) => JSON.stringify(k)).join(", ")}})`,
    "",
    `FUSION_SCOPES: Final[dict[str, str]] = {${Object.entries(registry.components)
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(", ")}}`,
    "",
    `FUSION_CONVENTIONS_VERSION: Final[str] = ${JSON.stringify(registry.version)}`,
    ""
  );
  return lines.join("\n");
}

function apply(path, content) {
  if (checkMode) {
    if (!existsSync(path)) {
      console.error(`trace conventions check failed: missing generated file ${path}`);
      process.exitCode = 1;
      return;
    }
    const current = readFileSync(path, "utf8");
    if (current !== content) {
      console.error(
        `trace conventions check failed: ${path} is stale; run \`node scripts/generate-trace-conventions.mjs\``
      );
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
}

const ts = renderTs();
apply(TARGETS.protocol, ts);
apply(TARGETS.python, renderPy());
apply(TARGETS.scope, ts);

if (checkMode && process.exitCode === undefined) {
  console.log("trace conventions check passed");
}
