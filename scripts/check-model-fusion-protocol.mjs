import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const fail = (message) => {
  console.error(`model-fusion protocol check failed: ${message}`);
  process.exitCode = 1;
};

const originPath = "packages/protocol/src/model-fusion.ts";
const entrypointPath = "packages/protocol/src/index.ts";
const openApiPath = "packages/protocol/openapi/model-fusion-harness-executor.openapi.json";
const bindingsPath = "packages/protocol/model-fusion-bindings.json";
const docsPath = "packages/protocol/docs/model-fusion-consumption.md";
const generatedTsPath = "packages/protocol/src/generated/model-fusion-openapi.ts";
const generatedPyInitPath = "packages/protocol/generated/python/velum_model_fusion_protocol/__init__.py";
const generatedPyPath = "packages/protocol/generated/python/velum_model_fusion_protocol/model_fusion_openapi.py";
const rootPackagePath = "package.json";
const protocolPackageJsonPath = "node_modules/@velum-labs/model-fusion-protocol/package.json";
const protocolPackageManifestPath =
  "node_modules/@velum-labs/model-fusion-protocol/protocol-package.json";
const protocolPackageOpenApiPath =
  "node_modules/@velum-labs/model-fusion-protocol/openapi/model-fusion.v1.openapi.json";
const protocolPackageTypesPath =
  "node_modules/@velum-labs/model-fusion-protocol/gen/typescript/openapi.d.ts";
const protocolPackageValidatorsPath =
  "node_modules/@velum-labs/model-fusion-protocol/gen/typescript/record-validators.ts";

const modelFusionTypescriptPackageName = "@velum-labs/model-fusion-protocol";
const modelFusionPythonPackageName = "velum-model-fusion-protocol";

for (const file of [
  rootPackagePath,
  originPath,
  entrypointPath,
  openApiPath,
  bindingsPath,
  docsPath,
  generatedTsPath,
  generatedPyInitPath,
  generatedPyPath,
  protocolPackageJsonPath,
  protocolPackageManifestPath,
  protocolPackageOpenApiPath,
  protocolPackageTypesPath,
  protocolPackageValidatorsPath
]) {
  if (!existsSync(file)) fail(`missing ${file}`);
}

const origin = readFileSync(originPath, "utf8");
const hashMatch = origin.match(
  /MODEL_FUSION_SCHEMA_BUNDLE_HASH\s*=\s*\n?\s*"(?<hash>sha256:[0-9a-f]{64})"/
);
const schemaBundleHash = hashMatch?.groups?.hash;
if (schemaBundleHash === undefined) {
  fail("MODEL_FUSION_SCHEMA_BUNDLE_HASH must be exported from model-fusion.ts");
}

const entrypoint = readFileSync(entrypointPath, "utf8");
if (!entrypoint.includes("MODEL_FUSION_SCHEMA_BUNDLE_HASH")) {
  fail("protocol entrypoint must export MODEL_FUSION_SCHEMA_BUNDLE_HASH");
}

const sourceListing = spawnSync("git", ["ls-files", "*.ts", "*.js", "*.mjs"], {
  encoding: "utf8"
});
if (sourceListing.status === 0 && schemaBundleHash !== undefined) {
  for (const file of sourceListing.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file === originPath) continue;
    if (file.startsWith("packages/protocol/src/fixtures/model-fusion-contract/")) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(schemaBundleHash)) {
      fail(`${file} copies the model-fusion schema bundle hash; import it from @warrant/protocol`);
    }
  }
}

const openApiText = readFileSync(openApiPath, "utf8");
const openApiHash = `sha256:${createHash("sha256").update(openApiText).digest("hex")}`;
const openApi = JSON.parse(openApiText);
if (openApi.openapi !== "3.1.0") {
  fail("OpenAPI compatibility snapshot must use OpenAPI 3.1.0");
}
if (openApi["x-canonical-source-repo"] !== "fusionkit") {
  fail("OpenAPI compatibility snapshot must keep FusionKit as canonical source");
}
if (openApi["x-record-format"] !== "json-schema") {
  fail("OpenAPI compatibility snapshot must carry JSON Schema records");
}
const harnessExecution = openApi.paths?.["/v1/harness-executions"]?.post;
if (harnessExecution?.operationId !== "executeHarnessTask") {
  fail("OpenAPI compatibility snapshot must define executeHarnessTask");
}
for (const schema of [
  "PersistedJsonRecord",
  "HarnessExecutionRequest",
  "HarnessExecutionResult",
  "ArtifactRef"
]) {
  if (openApi.components?.schemas?.[schema] === undefined) {
    fail(`OpenAPI compatibility snapshot missing schema: ${schema}`);
  }
}

const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
if (bindings.openapiSource !== "openapi/model-fusion-harness-executor.openapi.json") {
  fail("binding target manifest must point at the model-fusion OpenAPI snapshot");
}
if (bindings.canonicalSourceRepo !== "fusionkit") {
  fail("binding target manifest must keep FusionKit as the canonical source repo");
}
if (bindings.localRole !== "consumer-compatibility-snapshot") {
  fail("binding target manifest must mark this repo as a consumer compatibility snapshot");
}
if (bindings.serviceBoundarySourceOfTruth !== "openapi-3.1") {
  fail("v1 HTTP/service boundaries must use OpenAPI 3.1 as source of truth");
}
if (bindings.openapi?.status !== "v1-http-json-source" || bindings.openapi?.version !== "3.1.0") {
  fail("OpenAPI target must declare the v1 HTTP/JSON source");
}
if (bindings.protobuf?.requiredForV1 !== false) {
  fail("protobuf/Buf must not be required for v1");
}
if (bindings.openapiSourceHash !== openApiHash) {
  fail(`binding target manifest openapiSourceHash is stale; expected ${openApiHash}`);
}
if (!readFileSync(generatedTsPath, "utf8").includes(openApiHash)) {
  fail("generated TypeScript OpenAPI SDK is not stamped with the current OpenAPI hash");
}
if (!readFileSync(generatedPyPath, "utf8").includes(openApiHash)) {
  fail("generated Python OpenAPI SDK is not stamped with the current OpenAPI hash");
}
if (bindings.typescript?.packageName !== modelFusionTypescriptPackageName) {
  fail(`TypeScript binding target must be ${modelFusionTypescriptPackageName}`);
}
if (bindings.python?.packageName !== modelFusionPythonPackageName) {
  fail(`Python binding target must remain ${modelFusionPythonPackageName}`);
}
for (const registry of ["npm", "GitHub Packages"]) {
  if (!bindings.typescript?.registries?.includes(registry)) {
    fail(`TypeScript binding target missing registry: ${registry}`);
  }
}
for (const option of ["Cloudsmith", "CodeArtifact", "Gemfury"]) {
  if (!bindings.python?.privateIndexOptions?.includes(option)) {
    fail(`Python binding target missing private index option: ${option}`);
  }
}
for (const option of ["GitHub Releases wheels", "uv git dependency"]) {
  if (!bindings.python?.bootstrapOptions?.includes(option)) {
    fail(`Python binding target missing bootstrap option: ${option}`);
  }
}

const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const protocolPackage = JSON.parse(readFileSync(protocolPackageJsonPath, "utf8"));
const protocolPackageManifest = JSON.parse(readFileSync(protocolPackageManifestPath, "utf8"));
const protocolPackageOpenApi = JSON.parse(readFileSync(protocolPackageOpenApiPath, "utf8"));

if (rootPackage.devDependencies?.[modelFusionTypescriptPackageName] !== "0.1.0") {
  fail(`${rootPackagePath}: devDependency ${modelFusionTypescriptPackageName} must be pinned to 0.1.0`);
}
if (protocolPackage.name !== modelFusionTypescriptPackageName) {
  fail(`${protocolPackageJsonPath}: package name must be ${modelFusionTypescriptPackageName}`);
}
if (protocolPackage.version !== rootPackage.devDependencies?.[modelFusionTypescriptPackageName]) {
  fail(`${protocolPackageJsonPath}: package version must match the root devDependency pin`);
}
if (protocolPackage.publishConfig?.registry !== "https://npm.pkg.github.com") {
  fail(`${protocolPackageJsonPath}: package must publish from GitHub Packages`);
}
if (protocolPackageManifest.package_name !== modelFusionTypescriptPackageName) {
  fail(`${protocolPackageManifestPath}: package_name must be ${modelFusionTypescriptPackageName}`);
}
if (protocolPackageManifest.version !== protocolPackage.version) {
  fail(`${protocolPackageManifestPath}: version must match installed package.json`);
}
if (protocolPackageManifest.schema_bundle_hash !== schemaBundleHash) {
  fail(`${protocolPackageManifestPath}: schema bundle hash must match @warrant/protocol export`);
}
if (protocolPackageManifest.openapi?.path !== "openapi/model-fusion.v1.openapi.json") {
  fail(`${protocolPackageManifestPath}: OpenAPI path must point at the installed package OpenAPI`);
}
if (protocolPackageManifest.openapi?.version !== "3.1.0" || protocolPackageOpenApi.openapi !== "3.1.0") {
  fail("installed model-fusion protocol package must expose OpenAPI 3.1.0");
}
if (protocolPackageManifest.protobuf?.required_for_v1 !== false) {
  fail(`${protocolPackageManifestPath}: protobuf must remain future-only for v1`);
}
for (const service of [
  "HarnessExecutorService",
  "CursorHarnessService",
  "MlxProviderService",
  "BenchmarkJoinService"
]) {
  if (!protocolPackageManifest.required_services?.includes(service)) {
    fail(`${protocolPackageManifestPath}: missing required service ${service}`);
  }
}

const publishedMetadata = bindings.publishedProtocolMetadata;
if (publishedMetadata?.typescriptPackageName !== bindings.typescript?.packageName) {
  fail("published protocol metadata TypeScript package name must match the binding target");
}
if (publishedMetadata?.pythonPackageName !== bindings.python?.packageName) {
  fail("published protocol metadata Python package name must match the binding target");
}
if (publishedMetadata?.version !== rootPackage.version) {
  fail("published protocol metadata version must match the root package version");
}
if (publishedMetadata?.schemaBundleHash !== schemaBundleHash) {
  fail("published protocol metadata schema bundle hash must match MODEL_FUSION_SCHEMA_BUNDLE_HASH");
}
if (publishedMetadata?.openapiSourceHash !== openApiHash) {
  fail(`published protocol metadata OpenAPI hash is stale; expected ${openApiHash}`);
}

const protoListing = spawnSync(
  "git",
  ["ls-files", "packages/protocol/**/*.proto", "packages/protocol/buf.yaml"],
  { encoding: "utf8" }
);
if (protoListing.status === 0) {
  const v1ProtoFiles = protoListing.stdout
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes("/experimental/"));
  for (const file of v1ProtoFiles) {
    fail(`${file} makes protobuf/Buf look required for v1; keep it out of the v1 protocol path`);
  }
}

const docs = readFileSync(docsPath, "utf8");
for (const required of [
  "FusionKit remains the contract and IDL origin",
  modelFusionTypescriptPackageName,
  modelFusionPythonPackageName,
  "Cloudsmith",
  "CodeArtifact",
  "Gemfury",
  "GitHub Releases",
  "uv",
  "JSON Schema remains the durable persisted record and audit format",
  "OpenAPI 3.1 is the v1 source of truth for HTTP/JSON service APIs",
  "OpenAPI codegen",
  "JSON Schema codegen",
  "Protobuf/Buf is reserved for later internal streaming",
  "Follow-up work belongs in FusionKit/openclaw-shared"
]) {
  if (!docs.includes(required)) fail(`consumption docs missing: ${required}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("model-fusion protocol check passed");
