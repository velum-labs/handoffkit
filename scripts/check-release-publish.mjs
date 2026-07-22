import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const RELEASE_MANIFEST = "release/npm-packages.json";
const RELEASE_TOPOLOGY = "release/workspace.release.json";
const WORKFLOW = ".github/workflows/release-packages.yml";
const PYPI_WORKFLOW = ".github/workflows/pypi-release.yml";
const OPENAPI_SNAPSHOT = "packages/protocol/openapi/model-fusion-harness-executor.openapi.json";
const BINDINGS = "packages/protocol/model-fusion-bindings.json";

const fail = (message) => {
  console.error(`release publish check failed: ${message}`);
  process.exitCode = 1;
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const path of [
  RELEASE_MANIFEST,
  RELEASE_TOPOLOGY,
  WORKFLOW,
  PYPI_WORKFLOW,
  OPENAPI_SNAPSHOT,
  BINDINGS
]) {
  if (!existsSync(path)) fail(`missing ${path}`);
}

const generatedCheck = spawnSync(
  process.execPath,
  ["scripts/check-generated-model-fusion-sdk.mjs"],
  { encoding: "utf8" }
);
if (generatedCheck.stdout.trim()) console.log(generatedCheck.stdout.trim());
if (generatedCheck.stderr.trim()) console.error(generatedCheck.stderr.trim());
if (generatedCheck.status !== 0) fail("generated model-fusion SDK drift check failed");

const manifest = readJson(RELEASE_MANIFEST);
if (manifest.canonicalRepository !== "velum-labs/handoffkit") {
  fail("release manifest must publish only from velum-labs/handoffkit");
}
for (const pattern of ["handoffkit-v*", "v*"]) {
  if (!manifest.tagPatterns?.includes(pattern)) fail(`release manifest missing tag pattern ${pattern}`);
}
if (manifest.registry !== "https://registry.npmjs.org") {
  fail("release manifest must publish npm packages to the public npm registry");
}
if (manifest.access !== "public") {
  fail("release manifest must publish npm packages with public access");
}
if (manifest.provenance !== true) {
  fail("release manifest must require npm provenance");
}

const workflow = readFileSync(WORKFLOW, "utf8");
for (const required of [
  "github.repository == 'velum-labs/handoffkit'",
  "handoffkit-v*",
  "v*",
  "permissions:",
  "contents: read",
  "id-token: write",
  "corepack pnpm check",
  "corepack pnpm exec turbo run build --filter='./packages/*' --filter='./examples/*'",
  "corepack pnpm exec turbo run build --filter=scope",
  "scripts/check-routekit-cli-pack.mjs",
  "scripts/stage-scope.mjs",
  "scripts/check-fusionkit-cli-pack.mjs --require-scope",
  "corepack pnpm test",
  "scripts/publish-npm-workspaces.mjs"
]) {
  if (!workflow.includes(required)) fail(`release workflow missing: ${required}`);
}
if (
  workflow.indexOf("corepack pnpm exec turbo run build --filter=scope") >
    workflow.indexOf("scripts/stage-scope.mjs") ||
  workflow.indexOf("scripts/stage-scope.mjs") >
  workflow.indexOf("scripts/check-fusionkit-cli-pack.mjs --require-scope")
) {
  fail("release workflow must build and stage Scope before validating the FusionKit tarball");
}

const openApiHash = `sha256:${createHash("sha256")
  .update(readFileSync(OPENAPI_SNAPSHOT))
  .digest("hex")}`;
const bindings = readJson(BINDINGS);
if (bindings.openapiSourceHash !== openApiHash) {
  fail(`model-fusion binding OpenAPI hash is stale; expected ${openApiHash}`);
}
if (bindings.typescript?.openapiGenerated !== "packages/protocol/src/generated/model-fusion-openapi.ts") {
  fail("TypeScript binding manifest must point at generated OpenAPI types/client");
}
if (bindings.python?.openapiGenerated !== "packages/protocol/generated/python/velum_model_fusion_protocol/model_fusion_openapi.py") {
  fail("Python binding manifest must point at generated OpenAPI models/client");
}
if (bindings.typescript?.jsonSchemaValidators !== "packages/protocol/src/model-fusion.ts") {
  fail("TypeScript binding manifest must expose JSON Schema validators");
}
if (manifest.protocol?.openapiSourceHash !== openApiHash) {
  fail(`release manifest protocol OpenAPI hash is stale; expected ${openApiHash}`);
}

const root = readJson("package.json");
if (manifest.protocol?.version !== root.version) {
  fail("release manifest protocol version must match root package version");
}

const publishable = new Set();
const packageOrder = new Map(
  (manifest.packages ?? []).map((entry, index) => [entry.name, index])
);
for (const entry of manifest.packages ?? []) {
  if (!entry.path || !entry.name) fail("release manifest packages require path and name");
  publishable.add(entry.path);
  const packagePath = `${entry.path}/package.json`;
  if (!existsSync(packagePath)) {
    fail(`release package is missing package.json: ${entry.path}`);
    continue;
  }
  const pkg = readJson(packagePath);
  if (pkg.name !== entry.name) fail(`${packagePath} name must be ${entry.name}`);
  if (pkg.private !== false) fail(`${packagePath} must opt into publishing with private:false`);
  if (pkg.version !== root.version) fail(`${packagePath} version must match root version ${root.version}`);
  if (pkg.publishConfig?.registry !== manifest.registry) {
    fail(`${packagePath} publishConfig.registry must be ${manifest.registry}`);
  }
  if (pkg.publishConfig?.access !== manifest.access) {
    fail(`${packagePath} publishConfig.access must be ${manifest.access}`);
  }
  if (pkg.publishConfig?.provenance !== true) {
    fail(`${packagePath} publishConfig.provenance must be true`);
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
    fail(`${packagePath} must publish built dist files`);
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes("LICENSE")) {
    fail(`${packagePath} must ship a LICENSE in the published tarball`);
  }
  if (pkg.license !== "Apache-2.0") {
    fail(`${packagePath} license must be Apache-2.0`);
  }
  if (!existsSync(`${entry.path}/LICENSE`)) {
    fail(`${entry.path} must contain the LICENSE declared in package files`);
  }
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    const dependencyIndex = packageOrder.get(dependency);
    if (dependencyIndex === undefined) continue;
    const packageIndex = packageOrder.get(pkg.name);
    if (packageIndex !== undefined && dependencyIndex > packageIndex) {
      fail(`${pkg.name} must be listed after dependency ${dependency}`);
    }
  }
}

for (const [packageName, binary] of [
  ["@routekit/cli", "routekit"],
  ["@fusionkit/cli", "fusionkit"]
]) {
  const entry = (manifest.packages ?? []).find((candidate) => candidate.name === packageName);
  if (entry === undefined) {
    fail(`release manifest is missing CLI package ${packageName}`);
    continue;
  }
  const pkg = readJson(`${entry.path}/package.json`);
  if (typeof pkg.bin?.[binary] !== "string") {
    fail(`${packageName} must publish the ${binary} executable`);
  }
}
const fusionCliEntry = (manifest.packages ?? []).find(
  (candidate) => candidate.name === "@fusionkit/cli"
);
if (fusionCliEntry !== undefined) {
  const fusionCli = readJson(`${fusionCliEntry.path}/package.json`);
  if (!fusionCli.files?.includes("scope")) {
    fail("@fusionkit/cli must publish the staged Scope dashboard directory");
  }
}

const topology = readJson(RELEASE_TOPOLOGY);
const npmUnit = topology.units?.find((unit) => unit.key === "handoffkit");
if (npmUnit?.packageManifest !== RELEASE_MANIFEST) {
  fail(`handoffkit release unit must use ${RELEASE_MANIFEST}`);
}
if (
  JSON.stringify(npmUnit?.binaries) !==
  JSON.stringify([
    { name: "routekit", package: "@routekit/cli" },
    { name: "fusionkit", package: "@fusionkit/cli" }
  ])
) {
  fail("handoffkit binary metadata must include routekit and fusionkit");
}
const pypiUnit = topology.units?.find((unit) => unit.key === "fusionkit-pypi");
const expectedPythonPackages = [
  "fusionkit-core",
  "fusionkit-server",
  "fusionkit",
  "fusionkit-mlx",
  "fusionkit-evals"
];
if (JSON.stringify(pypiUnit?.packages) !== JSON.stringify(expectedPythonPackages)) {
  fail(`fusionkit-pypi packages must use dependency order: ${expectedPythonPackages.join(" -> ")}`);
}
if (
  JSON.stringify(pypiUnit?.binaries) !==
  JSON.stringify([
    { name: "fusionkit-sidecar", package: "fusionkit" },
    { name: "fusionkit-bench", package: "fusionkit-evals" }
  ])
) {
  fail("fusionkit-pypi binary metadata must include fusionkit-sidecar and fusionkit-bench");
}
if (!pypiUnit?.forbiddenBinaries?.includes("fusionkit")) {
  fail("fusionkit-pypi must forbid the user-facing fusionkit executable");
}
const pypiRegistryPackages = (pypiUnit?.registries ?? [])
  .filter((registry) => registry.kind === "pypi")
  .map((registry) => registry.package);
if (JSON.stringify(pypiRegistryPackages) !== JSON.stringify(expectedPythonPackages)) {
  fail("fusionkit-pypi registries must list every released Python package in dependency order");
}
const expectedPythonPreflight = ["node", "scripts/build-fusionkit-python-packages.mjs"];
if (JSON.stringify(pypiUnit?.preflight) !== JSON.stringify(expectedPythonPreflight)) {
  fail("fusionkit-pypi preflight must build every release package in dependency order");
}

const pythonReleasePackages = new Map([
  ["fusionkit-core", "python/fusionkit-core"],
  ["fusionkit-server", "python/fusionkit-server"],
  ["fusionkit", "python/fusionkit-cli"],
  ["fusionkit-mlx", "python/fusionkit-mlx"],
  ["fusionkit-evals", "python/fusionkit-evals"]
]);
for (const packageName of expectedPythonPackages) {
  const packagePath = pythonReleasePackages.get(packageName);
  if (packagePath === undefined) {
    fail(`missing Python release path metadata for ${packageName}`);
    continue;
  }
  const pyprojectPath = `${packagePath}/pyproject.toml`;
  if (!existsSync(pyprojectPath)) {
    fail(`Python release package is missing pyproject.toml: ${packagePath}`);
    continue;
  }
  const pyproject = readFileSync(pyprojectPath, "utf8");
  if (!pyproject.includes(`name = "${packageName}"`)) {
    fail(`${pyprojectPath} project name must be ${packageName}`);
  }
  if (!pyproject.includes(`version = "${root.version}"`)) {
    fail(`${pyprojectPath} version must match root version ${root.version}`);
  }
  if (!pyproject.includes('license = "Apache-2.0"')) {
    fail(`${pyprojectPath} license must be Apache-2.0`);
  }
  if (!pyproject.includes('license-files = ["LICENSE"]')) {
    fail(`${pyprojectPath} must include LICENSE in built distributions`);
  }
  if (!existsSync(`${packagePath}/LICENSE`)) {
    fail(`${packagePath} must contain LICENSE`);
  }
}

const sidecarPyproject = readFileSync("python/fusionkit-cli/pyproject.toml", "utf8");
if (!sidecarPyproject.includes('fusionkit-sidecar = "fusionkit_cli.main:app"')) {
  fail("fusionkit Python distribution must install fusionkit-sidecar");
}
if (/^fusionkit\s*=/m.test(sidecarPyproject)) {
  fail("fusionkit Python distribution must not install a fusionkit executable");
}
const evalsPyproject = readFileSync("python/fusionkit-evals/pyproject.toml", "utf8");
if (!evalsPyproject.includes('fusionkit-bench = "fusionkit_evals.cli:bench_app"')) {
  fail("fusionkit-evals must install fusionkit-bench");
}
const fusionEnv = readFileSync("packages/cli/src/fusion/env.ts", "utf8");
if (!fusionEnv.includes(`FUSIONKIT_PYPI_VERSION = "${root.version}"`)) {
  fail("Node CLI sidecar version pin must match the release version");
}

const pypiWorkflow = readFileSync(PYPI_WORKFLOW, "utf8");
for (const required of [
  "scripts/build-fusionkit-python-packages.mjs",
  ".release-venv/bin/fusionkit-sidecar",
  ".release-venv/bin/fusionkit-bench",
  ".release-venv/bin/fusionkit"
]) {
  if (!pypiWorkflow.includes(required)) fail(`PyPI workflow missing: ${required}`);
}

for (const path of ["packages/example-utils"]) {
  const pkg = readJson(`${path}/package.json`);
  if (publishable.has(path)) fail(`${path} must not be in the runtime publish manifest`);
  if (pkg.private !== true) fail(`${path} must remain private`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("release publish check passed");
