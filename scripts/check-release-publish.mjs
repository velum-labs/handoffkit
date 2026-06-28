import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const RELEASE_MANIFEST = "release/npm-packages.json";
const WORKFLOW = ".github/workflows/release-packages.yml";
const OPENAPI_SNAPSHOT = "packages/protocol/openapi/model-fusion-harness-executor.openapi.json";
const BINDINGS = "packages/protocol/model-fusion-bindings.json";

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
}

for (const path of ["packages/testkit", "packages/example-utils"]) {
  const pkg = readJson(`${path}/package.json`);
  if (publishable.has(path)) fail(`${path} must not be in the runtime publish manifest`);
  if (pkg.private !== true) fail(`${path} must remain private`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("release publish check passed");
