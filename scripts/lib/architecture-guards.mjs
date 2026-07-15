import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const INTERNAL_SCOPES = ["@fusionkit/", "@routekit/"];
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

export const CANONICAL_SHARED_PACKAGES = new Map([
  ["packages/model-gateway", "@routekit/gateway"],
  ["packages/accounts", "@routekit/accounts"],
  ["packages/runtime-utils", "@routekit/runtime"],
  ["packages/routekit-tracing", "@routekit/tracing"],
  ["packages/cli-ui", "@routekit/cli-ui"],
  ["packages/cli-core", "@routekit/cli-core"],
  ["packages/config-core", "@routekit/config-core"],
  ["packages/routekit-config", "@routekit/config"],
  ["packages/routekit-router", "@routekit/router"],
  ["packages/telemetry-core", "@routekit/telemetry-core"],
  ["packages/harness-core", "@routekit/harness-core"],
  ["packages/tools", "@routekit/tools"],
  ["packages/tool-codex", "@routekit/tool-codex"],
  ["packages/tool-claude", "@routekit/tool-claude"],
  ["packages/tool-cursor", "@routekit/tool-cursor"],
  ["packages/tool-opencode", "@routekit/tool-opencode"],
  ["packages/tool-registry", "@routekit/tool-registry"],
  ["packages/routekit-cli", "@routekit/cli"]
]);

export function canonicalSharedPackageViolations(manifests) {
  const violations = [];
  for (const [dir, expectedName] of CANONICAL_SHARED_PACKAGES) {
    const entry = manifests.find((candidate) => candidate.dir === dir);
    if (entry === undefined) {
      violations.push(`${dir} is missing from the workspace`);
    } else if (entry.manifest.name !== expectedName) {
      violations.push(`${dir} must declare ${expectedName}, got ${entry.manifest.name}`);
    }
  }
  return violations;
}

export function isInternalWorkspaceDependency(name) {
  return INTERNAL_SCOPES.some((scope) => name.startsWith(scope));
}

export function manifestDependencies(manifest) {
  const dependencies = new Set();
  for (const section of DEPENDENCY_SECTIONS) {
    for (const name of Object.keys(manifest[section] ?? {})) dependencies.add(name);
  }
  return dependencies;
}

export function routekitDependencyViolations(manifests) {
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]));
  const violations = [];

  for (const entry of manifests) {
    if (!entry.manifest.name?.startsWith("@routekit/")) continue;
    const queue = [...manifestDependencies(entry.manifest)].map((name) => ({
      name,
      path: [entry.manifest.name, name]
    }));
    const visited = new Set();

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current.name)) continue;
      visited.add(current.name);
      if (current.name.startsWith("@fusionkit/")) {
        violations.push({
          manifestPath: entry.manifestPath,
          dependencyPath: current.path
        });
        continue;
      }
      const dependency = byName.get(current.name);
      if (dependency === undefined) continue;
      for (const child of manifestDependencies(dependency.manifest)) {
        queue.push({ name: child, path: [...current.path, child] });
      }
    }
  }

  return violations;
}

export function fusionkitCompositionViolations(manifests) {
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]));
  const root = byName.get("@fusionkit/cli");
  if (root === undefined) return ["@fusionkit/cli is missing from the workspace"];
  const violations = [];
  const queue = [...manifestDependencies(root.manifest)].map((name) => ({
    name,
    path: ["@fusionkit/cli", name]
  }));
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.name)) continue;
    visited.add(current.name);
    if (current.name === "@routekit/cli") {
      violations.push(
        `FusionKit dependency closure includes the RouteKit CLI: ${current.path.join(" -> ")}`
      );
      continue;
    }
    const dependency = byName.get(current.name);
    if (dependency === undefined) continue;
    for (const child of manifestDependencies(dependency.manifest)) {
      queue.push({ name: child, path: [...current.path, child] });
    }
  }
  return violations;
}

export function toolRegistryCompositionViolations(manifests) {
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]));
  const registry = byName.get("@routekit/tool-registry");
  if (registry === undefined) return ["@routekit/tool-registry is missing from the workspace"];

  const violations = [];
  const registryDependencies = manifestDependencies(registry.manifest);
  const integrationPackages = [...byName.keys()]
    .filter((name) => /^@routekit\/tool-(?!registry$)/.test(name))
    .sort();
  for (const dependency of ["@routekit/tools", ...integrationPackages]) {
    if (!registryDependencies.has(dependency)) {
      violations.push(`@routekit/tool-registry must depend on ${dependency}`);
    }
  }

  for (const consumerName of ["@routekit/cli", "@fusionkit/cli"]) {
    const consumer = byName.get(consumerName);
    if (consumer === undefined) {
      violations.push(`${consumerName} is missing from the workspace`);
    } else if (!manifestDependencies(consumer.manifest).has("@routekit/tool-registry")) {
      violations.push(`${consumerName} must depend on @routekit/tool-registry`);
    }
  }

  const fusionCli = byName.get("@fusionkit/cli");
  if (fusionCli !== undefined) {
    for (const dependency of manifestDependencies(fusionCli.manifest)) {
      if (integrationPackages.includes(dependency)) {
        violations.push(`@fusionkit/cli must compose tools through @routekit/tool-registry, not ${dependency}`);
      }
    }
  }
  return violations;
}

export function toolRegistryConsumerSourceViolations(file, source) {
  const violations = [];
  if (!/(?:from\s+|import\s*\()["']@routekit\/tool-registry["']/.test(source)) {
    violations.push(`${file} must import @routekit/tool-registry`);
  }
  if (/(?:from\s+|import\s*\()["']@routekit\/tool-(?!registry["'])[^"']+["']/.test(source)) {
    violations.push(`${file} must not import individual tool integrations`);
  }
  if (/\bcreateToolRegistry\s*\(/.test(source)) {
    violations.push(`${file} must not construct a parallel tool registry`);
  }
  if (
    file.endsWith("packages/cli/src/tools.ts") &&
    !/\bsetToolDriverRegistry\s*\(\s*toolRegistry\s*\)/.test(source)
  ) {
    violations.push(`${file} must compose the canonical registry with setToolDriverRegistry`);
  }
  return violations;
}

export function toolRegistryConstructionViolations(sources) {
  const owner = "packages/tool-registry/src/index.ts";
  const constructions = sources.flatMap(({ file, source }) => {
    if (file === "packages/tools/src/registry.ts") return [];
    return [...source.matchAll(/\bcreateToolRegistry\s*\(/g)].map(() => file);
  });
  const violations = [];
  if (constructions.filter((file) => file === owner).length !== 1) {
    violations.push(`${owner} must construct the canonical registry exactly once`);
  }
  for (const file of constructions) {
    if (file !== owner) violations.push(`${file} constructs a parallel tool registry`);
  }
  return violations;
}

export function routekitSourceViolations(file, source) {
  const violations = [];
  const normalized = file.split(sep).join("/");
  const productionPath = normalized
    .replace(/^.*\/src\//, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (productionPath.some((segment) => /(^|[-_.])fusion(?:[-_.]|$)/i.test(segment))) {
    violations.push("fusion vocabulary in production source path");
  }

  const importPattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@fusionkit\//;
  if (importPattern.test(source)) violations.push("imports @fusionkit/*");

  const neutralToolPackage =
    /\/packages\/(?:harness-core|tools|tool-(?:codex|claude|cursor|opencode|registry))\//.test(
      `/${normalized}`
    );
  if (neutralToolPackage && /\b(?:fusionkit|fusion|fused)\b/i.test(source)) {
    violations.push("product-specific vocabulary in production source");
  }

  const declarationPattern =
    /^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:class|enum|function|interface|namespace|type|const|let|var)\s+([$A-Z_a-z][$\w]*)/gm;
  for (const match of source.matchAll(declarationPattern)) {
    const words = (match[1] ?? "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[_\s]+/)
      .map((word) => word.toLowerCase());
    if (words.includes("fusion") || words.includes("fusionkit")) {
      violations.push("fusion vocabulary in a declared production name");
      break;
    }
  }
  return violations;
}

export function routekitProductionSources(packageDir) {
  const sourceRoot = join(packageDir, "src");
  const files = [];

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "__tests__") visit(path);
        continue;
      }
      if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      files.push({
        file: relative(process.cwd(), path),
        source: readFileSync(path, "utf8")
      });
    }
  }

  visit(sourceRoot);
  return files;
}
