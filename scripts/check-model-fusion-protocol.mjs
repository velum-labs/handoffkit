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

for (const file of [originPath, entrypointPath, openApiPath, bindingsPath, docsPath]) {
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
if (bindings.typescript?.packageName !== "@velum/model-fusion-protocol") {
  fail("TypeScript binding target must be @velum/model-fusion-protocol");
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
  "@velum/model-fusion-protocol",
  "Cloudsmith",
  "CodeArtifact",
  "Gemfury",
  "GitHub Releases",
  "uv",
  "JSON Schema remains the durable persisted record and audit format",
  "OpenAPI 3.1 is the v1 source of truth for HTTP/JSON service APIs",
  "Protobuf/Buf is reserved for later internal streaming",
  "Follow-up work belongs in FusionKit/openclaw-shared"
]) {
  if (!docs.includes(required)) fail(`consumption docs missing: ${required}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("model-fusion protocol check passed");
