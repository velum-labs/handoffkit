import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const RELEASE_MANIFEST = "release/npm-packages.json";
const WORKFLOW = ".github/workflows/release-packages.yml";
const OPENAPI_SNAPSHOT = "packages/protocol/openapi/model-fusion-harness-executor.openapi.json";
const BINDINGS = "packages/protocol/model-fusion-bindings.json";
const MODEL_FUSION_PACKAGE = "@velum-labs/model-fusion-protocol";
const MODEL_FUSION_PACKAGE_VERSION = "0.1.0";

const fail = (message) => {
  console.error(`release publish check failed: ${message}`);
  process.exitCode = 1;
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const path of [RELEASE_MANIFEST, WORKFLOW, OPENAPI_SNAPSHOT, BINDINGS]) {
  if (!existsSync(path)) fail(`missing ${path}`);
}

const manifest = readJson(RELEASE_MANIFEST);
if (manifest.canonicalRepository !== "velum-labs/handoffkit") {
  fail("release manifest must publish only from velum-labs/handoffkit");
}
for (const pattern of ["handoffkit-v*", "v*"]) {
  if (!manifest.tagPatterns?.includes(pattern)) fail(`release manifest missing tag pattern ${pattern}`);
}
if (manifest.registry !== "https://npm.pkg.github.com") {
  fail("release manifest must publish npm packages to GitHub Packages");
}
if (manifest.access !== "restricted") {
  fail("release manifest must default npm packages to restricted access");
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
  "packages: write",
  "id-token: write",
  "corepack pnpm check",
  "corepack pnpm build",
  "corepack pnpm test",
  "scripts/publish-npm-workspaces.mjs"
]) {
  if (!workflow.includes(required)) fail(`release workflow missing: ${required}`);
}

const openApiHash = `sha256:${createHash("sha256")
  .update(readFileSync(OPENAPI_SNAPSHOT))
  .digest("hex")}`;
const bindings = readJson(BINDINGS);
if (bindings.openapiSourceHash !== openApiHash) {
  fail(`model-fusion binding OpenAPI hash is stale; expected ${openApiHash}`);
}
if (bindings.sharedProtocolPackage?.name !== MODEL_FUSION_PACKAGE) {
  fail("model-fusion binding manifest must name the shared protocol package");
}
if (bindings.sharedProtocolPackage?.version !== MODEL_FUSION_PACKAGE_VERSION) {
  fail("model-fusion binding manifest must pin the shared protocol package version");
}
if (bindings.durableRecordSourceOfTruth !== MODEL_FUSION_PACKAGE) {
  fail("model-fusion durable record source must be the shared protocol package");
}
if (bindings.generatedArtifactsSourceOfTruth !== MODEL_FUSION_PACKAGE) {
  fail("model-fusion generated artifact source must be the shared protocol package");
}
if (manifest.protocol?.openapiSourceHash !== openApiHash) {
  fail(`release manifest protocol OpenAPI hash is stale; expected ${openApiHash}`);
}
if (manifest.protocol?.modelFusionPackageName !== MODEL_FUSION_PACKAGE) {
  fail("release manifest protocol metadata must name the consumed model-fusion package");
}
if (manifest.protocol?.modelFusionPackageVersion !== MODEL_FUSION_PACKAGE_VERSION) {
  fail("release manifest protocol metadata must pin the consumed model-fusion package version");
}

const root = readJson("package.json");
if (manifest.protocol?.version !== root.version) {
  fail("release manifest protocol version must match root package version");
}

const publishable = new Set();
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
}

for (const path of ["packages/testkit", "packages/example-utils"]) {
  const pkg = readJson(`${path}/package.json`);
  if (publishable.has(path)) fail(`${path} must not be in the runtime publish manifest`);
  if (pkg.private !== true) fail(`${path} must remain private`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("release publish check passed");
