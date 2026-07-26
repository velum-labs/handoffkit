import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Only FusionKit packages remain workspace-internal. RouteKit foundation
// packages are published from github.com/velum-labs/routekit and consumed as
// exact npm pins.
const INTERNAL_SCOPES = ["@fusionkit/"];
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies"
];

/** @deprecated RouteKit packages were extracted; kept empty for API stability. */
export const CANONICAL_SHARED_PACKAGES = new Map();

export function canonicalSharedPackageViolations(
  manifests,
  packages = CANONICAL_SHARED_PACKAGES
) {
  const violations = [];
  for (const [dir, expectedName] of packages) {
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
    if (!entry.manifest.name?.startsWith("@velum-labs/routekit")) continue;
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
    if (current.name === "@velum-labs/routekit") {
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

/** FusionKit must compose tools through the published tool-registry package. */
export function toolRegistryCompositionViolations(manifests) {
  const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry]));
  const violations = [];
  const consumer = byName.get("@fusionkit/cli");
  if (consumer === undefined) {
    return ["@fusionkit/cli is missing from the workspace"];
  }
  const dependencies = manifestDependencies(consumer.manifest);
  if (!dependencies.has("@velum-labs/routekit-tool-registry")) {
    violations.push("@fusionkit/cli must depend on @velum-labs/routekit-tool-registry");
  }
  const integrationPackages = [
    "@velum-labs/routekit-tool-claude",
    "@velum-labs/routekit-tool-codex",
    "@velum-labs/routekit-tool-cursor",
    "@velum-labs/routekit-tool-opencode"
  ];
  for (const dependency of dependencies) {
    if (integrationPackages.includes(dependency)) {
      violations.push(
        `@fusionkit/cli must compose tools through @velum-labs/routekit-tool-registry, not ${dependency}`
      );
    }
  }
  return violations;
}

export function toolRegistryConsumerSourceViolations(file, source) {
  const violations = [];
  if (
    /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@velum-labs\/routekit-tool-(?!registry(?:["'/]))[^"']+["']/.test(
      source
    )
  ) {
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

export function toolRegistryCliSourceViolations(consumerName, sources) {
  const violations = [];
  if (
    !sources.some(({ source }) =>
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']@velum-labs\/routekit-tool-registry["']/.test(
        source
      )
    )
  ) {
    violations.push(`${consumerName} production sources must import @velum-labs/routekit-tool-registry`);
  }
  for (const { file, source } of sources) {
    violations.push(...toolRegistryConsumerSourceViolations(file, source));
  }
  return violations;
}

/**
 * Construction ownership lives in the routekit repo. Pass `owner` only when
 * exercising the invariant against fixtures; production callers omit it.
 */
export function toolRegistryConstructionViolations(sources, owner = null) {
  if (owner === null) return [];
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

export function polynomialTrailingSlashRegexViolations(file, source) {
  if (!/\\\/[+*]\$\//.test(source)) return [];
  return [
    `${file} uses a polynomial trailing-slash regex; use @velum-labs/routekit-runtime slash helpers`
  ];
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
