import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const fail = (message) => {
  console.error(`model-fusion protocol check failed: ${message}`);
  process.exitCode = 1;
};

const modelFusionTypescriptPackageName = "@velum-labs/model-fusion-protocol";
const modelFusionPackageVersion = "0.1.0";
const rootPackagePath = "package.json";
const protocolPackagePath = "packages/protocol/package.json";
const entrypointPath = "packages/protocol/src/index.ts";
const facadePath = "packages/protocol/src/model-fusion.ts";
const localOpenApiPath = "packages/protocol/openapi/model-fusion-harness-executor.openapi.json";
const bindingsPath = "packages/protocol/model-fusion-bindings.json";
const docsPath = "packages/protocol/docs/model-fusion-consumption.md";
const ciWorkflowPath = ".github/workflows/ci.yml";
const npmrcPath = ".npmrc";

const removedGeneratedFiles = [
  "packages/protocol/src/generated/model-fusion-openapi.ts",
  "packages/protocol/generated/python/velum_model_fusion_protocol/__init__.py",
  "packages/protocol/generated/python/velum_model_fusion_protocol/model_fusion_openapi.py"
];

const requiredRuntimeExports = [
  "MODEL_FUSION_SCHEMA_BUNDLE_HASH",
  "MODEL_FUSION_SCHEMA_NAMES",
  "MODEL_FUSION_OPENAPI_SOURCE_HASH",
  "MODEL_FUSION_HARNESS_EXECUTOR_PATH",
  "executeHarnessTask",
  "assertArtifactRefV1",
  "assertBenchmarkTaskRecordV1",
  "assertEnsembleReceiptV1",
  "assertHarnessCandidateRecordV1",
  "assertHarnessRunRequestV1",
  "assertHarnessRunResultV1",
  "assertJudgeSynthesisRecordV1",
  "assertModelCallRecordV1",
  "assertModelFusionRecord",
  "assertToolCallPlanV1",
  "assertToolExecutionRecordV1"
];

const requiredTypeExports = [
  "ArtifactRefV1",
  "BenchmarkTaskRecordV1",
  "ContractMetadataV1",
  "ExecuteHarnessTaskClientOptions",
  "HarnessCandidateRecordV1",
  "HarnessRunRequestV1",
  "HarnessRunResultV1",
  "ModelCallRecordV1",
  "ModelFusionOpenApiHarnessExecutionRequest",
  "ModelFusionOpenApiHarnessExecutionResult",
  "ModelFusionRecordV1",
  "ToolCallPlanV1",
  "ToolExecutionRecordV1"
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertPackagePin(manifestPath, section, manifest) {
  const actual = manifest[section]?.[modelFusionTypescriptPackageName];
  if (actual !== modelFusionPackageVersion) {
    fail(
      `${manifestPath} must pin ${modelFusionTypescriptPackageName} in ${section} to ${modelFusionPackageVersion}`
    );
  }
}

function resolvePackageRoot() {
  const requireFromProtocol = createRequire(resolve(protocolPackagePath));
  let entrypoint;
  try {
    entrypoint = requireFromProtocol.resolve(modelFusionTypescriptPackageName);
  } catch (error) {
    fail(
      `${modelFusionTypescriptPackageName} is not installed; run pnpm install with NODE_AUTH_TOKEN allowed to read GitHub Packages (${error.message})`
    );
    return undefined;
  }

  let current = dirname(entrypoint);
  while (current !== dirname(current)) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) {
      const manifest = readJson(candidate);
      if (manifest.name === modelFusionTypescriptPackageName) return current;
    }
    current = dirname(current);
  }

  fail(`could not locate ${modelFusionTypescriptPackageName} package root from ${entrypoint}`);
  return undefined;
}

function packageFile(packageRoot, filePath) {
  return join(packageRoot, filePath.replace(/^\.\//, ""));
}

function walkFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  };
  visit(root);
  return files;
}

function findPackageOpenApi(packageRoot) {
  for (const file of walkFiles(packageRoot)) {
    if (!file.endsWith(".json")) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const operation = parsed.paths?.["/v1/harness-executions"]?.post;
    if (parsed.openapi === "3.1.0" && operation?.operationId === "executeHarnessTask") {
      return { file, spec: parsed, text: readFileSync(file, "utf8") };
    }
  }
  return undefined;
}

function packageTypesText(packageRoot, manifest) {
  const typesPath = manifest.exports?.["."]?.types ?? manifest.types ?? manifest.typings;
  if (typeof typesPath !== "string") {
    fail(`${modelFusionTypescriptPackageName} must expose declaration metadata for TypeScript`);
    return "";
  }
  const fullPath = packageFile(packageRoot, typesPath);
  if (!existsSync(fullPath)) {
    fail(`${modelFusionTypescriptPackageName} declaration file is missing: ${typesPath}`);
    return "";
  }
  return readFileSync(fullPath, "utf8");
}

for (const file of [
  rootPackagePath,
  protocolPackagePath,
  entrypointPath,
  facadePath,
  localOpenApiPath,
  bindingsPath,
  docsPath,
  ciWorkflowPath,
  npmrcPath
]) {
  if (!existsSync(file)) fail(`missing ${file}`);
}
for (const file of removedGeneratedFiles) {
  if (existsSync(file)) fail(`${file} must come from ${modelFusionTypescriptPackageName}, not this repo`);
}

const rootPackage = readJson(rootPackagePath);
const protocolPackage = readJson(protocolPackagePath);
assertPackagePin(rootPackagePath, "devDependencies", rootPackage);
assertPackagePin(protocolPackagePath, "dependencies", protocolPackage);

const npmrc = readFileSync(npmrcPath, "utf8");
for (const required of [
  "@velum-labs:registry=https://npm.pkg.github.com",
  "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}"
]) {
  if (!npmrc.includes(required)) fail(`.npmrc missing ${required}`);
}
const ciWorkflow = readFileSync(ciWorkflowPath, "utf8");
for (const required of [
  "packages: read",
  "MODEL_FUSION_PROTOCOL_NPM_TOKEN",
  "secrets.GITHUB_TOKEN",
  "NODE_AUTH_TOKEN"
]) {
  if (!ciWorkflow.includes(required)) fail(`CI workflow missing GitHub Packages install support: ${required}`);
}

const packageRoot = resolvePackageRoot();
let packageManifest;
let packageExports;
let packageOpenApi;
if (packageRoot !== undefined) {
  packageManifest = readJson(join(packageRoot, "package.json"));
  if (packageManifest.version !== modelFusionPackageVersion) {
    fail(
      `${modelFusionTypescriptPackageName} installed version ${packageManifest.version} must be ${modelFusionPackageVersion}`
    );
  }
  packageExports = await import(modelFusionTypescriptPackageName);
  for (const exported of requiredRuntimeExports) {
    if (!(exported in packageExports)) {
      fail(`${modelFusionTypescriptPackageName} missing runtime export: ${exported}`);
    }
  }
  if (!Array.isArray(packageExports.MODEL_FUSION_SCHEMA_NAMES)) {
    fail(`${modelFusionTypescriptPackageName} must export MODEL_FUSION_SCHEMA_NAMES as an array`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(packageExports.MODEL_FUSION_SCHEMA_BUNDLE_HASH ?? "")) {
    fail(`${modelFusionTypescriptPackageName} must export a sha256 schema bundle hash`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(packageExports.MODEL_FUSION_OPENAPI_SOURCE_HASH ?? "")) {
    fail(`${modelFusionTypescriptPackageName} must export a sha256 OpenAPI source hash`);
  }
  if (packageExports.MODEL_FUSION_HARNESS_EXECUTOR_PATH !== "/v1/harness-executions") {
    fail(`${modelFusionTypescriptPackageName} must export the harness executor path`);
  }

  const declarationText = packageTypesText(packageRoot, packageManifest);
  for (const exported of requiredTypeExports) {
    if (!declarationText.includes(exported)) {
      fail(`${modelFusionTypescriptPackageName} declaration metadata missing: ${exported}`);
    }
  }

  packageOpenApi = findPackageOpenApi(packageRoot);
  if (packageOpenApi === undefined) {
    fail(`${modelFusionTypescriptPackageName} must ship the canonical OpenAPI metadata JSON`);
  } else {
    const packageOpenApiHash = `sha256:${createHash("sha256")
      .update(packageOpenApi.text)
      .digest("hex")}`;
    if (packageOpenApiHash !== packageExports.MODEL_FUSION_OPENAPI_SOURCE_HASH) {
      fail(
        `${modelFusionTypescriptPackageName} OpenAPI source hash export is stale; expected ${packageOpenApiHash}`
      );
    }
  }
}

const facade = readFileSync(facadePath, "utf8");
if (!facade.includes(`from "${modelFusionTypescriptPackageName}"`)) {
  fail("model-fusion facade must re-export shared protocol artifacts from the published package");
}
if (/sha256:[0-9a-f]{64}/.test(facade)) {
  fail("model-fusion facade must not copy the schema bundle hash");
}

const entrypoint = readFileSync(entrypointPath, "utf8");
for (const required of [
  "MODEL_FUSION_SCHEMA_BUNDLE_HASH",
  "MODEL_FUSION_SCHEMA_NAMES",
  "MODEL_FUSION_OPENAPI_SOURCE_HASH",
  "executeHarnessTask",
  'from "./model-fusion.js"'
]) {
  if (!entrypoint.includes(required)) fail(`protocol entrypoint missing package-backed export: ${required}`);
}
if (entrypoint.includes("./generated/model-fusion-openapi.js")) {
  fail("protocol entrypoint must not import local generated model-fusion OpenAPI SDK files");
}

const sourceListing = spawnSync("git", ["ls-files", "*.ts", "*.js", "*.mjs"], {
  encoding: "utf8"
});
if (sourceListing.status === 0 && packageExports?.MODEL_FUSION_SCHEMA_BUNDLE_HASH !== undefined) {
  for (const file of sourceListing.stdout.split("\n").filter((line) => line.length > 0)) {
    if (file.startsWith("packages/protocol/src/fixtures/model-fusion-contract/")) continue;
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (text.includes(packageExports.MODEL_FUSION_SCHEMA_BUNDLE_HASH)) {
      fail(`${file} copies the model-fusion schema bundle hash; import it from ${modelFusionTypescriptPackageName}`);
    }
  }
}

const localOpenApiText = readFileSync(localOpenApiPath, "utf8");
const localOpenApiHash = `sha256:${createHash("sha256").update(localOpenApiText).digest("hex")}`;
const localOpenApi = JSON.parse(localOpenApiText);
if (localOpenApi.openapi !== "3.1.0") {
  fail("HandoffKit harness executor OpenAPI contract must use OpenAPI 3.1.0");
}
if (localOpenApi["x-local-role"] !== "handoffkit-owned-harness-executor-contract") {
  fail("HandoffKit harness executor OpenAPI contract must declare its repo-owned local role");
}
if (localOpenApi["x-shared-protocol-package"] !== modelFusionTypescriptPackageName) {
  fail("HandoffKit harness executor OpenAPI contract must point at the shared protocol package");
}
if (localOpenApi["x-shared-protocol-package-version"] !== modelFusionPackageVersion) {
  fail("HandoffKit harness executor OpenAPI contract must pin the shared protocol package version");
}
if (localOpenApi["x-record-format"] !== "json-schema") {
  fail("HandoffKit harness executor OpenAPI contract must carry JSON Schema records");
}
const harnessExecution = localOpenApi.paths?.["/v1/harness-executions"]?.post;
if (harnessExecution?.operationId !== "executeHarnessTask") {
  fail("HandoffKit harness executor OpenAPI contract must define executeHarnessTask");
}
for (const schema of [
  "PersistedJsonRecord",
  "HarnessExecutionRequest",
  "HarnessExecutionResult",
  "ArtifactRef"
]) {
  if (localOpenApi.components?.schemas?.[schema] === undefined) {
    fail(`HandoffKit harness executor OpenAPI contract missing schema: ${schema}`);
  }
}
if (packageExports?.MODEL_FUSION_SCHEMA_BUNDLE_HASH !== undefined) {
  const schemaBundleHash = packageExports.MODEL_FUSION_SCHEMA_BUNDLE_HASH;
  for (const schema of packageExports.MODEL_FUSION_SCHEMA_NAMES) {
    for (const variant of ["minimal", "realistic"]) {
      const fixture = `packages/protocol/src/fixtures/model-fusion-contract/${schema}/${variant}.json`;
      if (!existsSync(fixture)) continue;
      const parsed = readJson(fixture);
      if (parsed.schema_bundle_hash !== schemaBundleHash) {
        fail(`${fixture} does not match the package schema bundle hash`);
      }
    }
  }
}

const bindings = readJson(bindingsPath);
if (bindings.sharedProtocolPackage?.name !== modelFusionTypescriptPackageName) {
  fail("binding manifest must name the shared model-fusion protocol package");
}
if (bindings.sharedProtocolPackage?.version !== modelFusionPackageVersion) {
  fail("binding manifest must pin the shared model-fusion protocol package version");
}
if (bindings.openapiSource !== "openapi/model-fusion-harness-executor.openapi.json") {
  fail("binding manifest must point at the HandoffKit harness executor OpenAPI contract");
}
if (bindings.openapiSourceHash !== localOpenApiHash) {
  fail(`binding manifest HandoffKit OpenAPI hash is stale; expected ${localOpenApiHash}`);
}
if (bindings.localRole !== "handoffkit-owned-harness-executor-contract") {
  fail("binding manifest must mark the local OpenAPI as HandoffKit-owned");
}
if (bindings.durableRecordSourceOfTruth !== modelFusionTypescriptPackageName) {
  fail("binding manifest must consume durable records from the shared package");
}
if (bindings.generatedArtifactsSourceOfTruth !== modelFusionTypescriptPackageName) {
  fail("binding manifest must consume generated protocol artifacts from the shared package");
}
if (bindings.serviceBoundarySourceOfTruth !== "openapi-3.1") {
  fail("HandoffKit harness executor service boundary must use OpenAPI 3.1");
}
if (bindings.openapi?.status !== "handoffkit-owned-v1-http-json-source") {
  fail("OpenAPI target must declare the HandoffKit-owned v1 HTTP/JSON source");
}
if (bindings.protobuf?.requiredForV1 !== false) {
  fail("protobuf/Buf must not be required for v1");
}

const docs = readFileSync(docsPath, "utf8");
for (const required of [
  "FusionKit remains the contract and IDL origin",
  modelFusionTypescriptPackageName,
  modelFusionPackageVersion,
  "GitHub Packages",
  "MODEL_FUSION_PROTOCOL_NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "packages: read",
  "HandoffKit-owned harness executor OpenAPI contract",
  "JSON Schema remains the durable persisted record and audit format",
  "OpenAPI 3.1 is the v1 source of truth for HTTP/JSON service APIs",
  "Generated TypeScript/OpenAPI/schema artifacts are consumed from the package",
  "Protobuf/Buf is reserved for later internal streaming"
]) {
  if (!docs.includes(required)) fail(`consumption docs missing: ${required}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("model-fusion protocol check passed");
