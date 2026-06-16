import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const fail = (message) => {
  console.error(`model-fusion protocol check failed: ${message}`);
  process.exitCode = 1;
};

const originPath = "packages/protocol/src/model-fusion.ts";
const entrypointPath = "packages/protocol/src/index.ts";
const protoPath = "packages/protocol/proto/model_fusion/v1/services.proto";
const bufPath = "packages/protocol/buf.yaml";
const bindingsPath = "packages/protocol/model-fusion-bindings.json";
const docsPath = "packages/protocol/docs/model-fusion-consumption.md";

for (const file of [originPath, entrypointPath, protoPath, bufPath, bindingsPath, docsPath]) {
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

const proto = readFileSync(protoPath, "utf8");
for (const service of [
  "HarnessExecutorService",
  "CursorHarnessService",
  "MlxProviderService",
  "BenchmarkExecutionService"
]) {
  if (!proto.includes(`service ${service}`)) fail(`IDL missing ${service}`);
}
for (const message of [
  "PersistedJsonRecord",
  "HarnessExecutionRequest",
  "HarnessExecutionResult",
  "BenchmarkExecutionEnvelope",
  "BenchmarkJoinEnvelope"
]) {
  if (!proto.includes(`message ${message}`)) fail(`IDL missing ${message}`);
}
if (!proto.includes("bytes persisted_json")) {
  fail("IDL must carry JSON Schema audit records as persisted_json bytes");
}

const protoHash = `sha256:${createHash("sha256").update(proto).digest("hex")}`;
const bindings = JSON.parse(readFileSync(bindingsPath, "utf8"));
if (bindings.protoSource !== "proto/model_fusion/v1/services.proto") {
  fail("binding target manifest must point at the model-fusion service proto");
}
if (bindings.protoSourceHash !== protoHash) {
  fail(`binding target manifest protoSourceHash is stale; expected ${protoHash}`);
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

const buf = readFileSync(bufPath, "utf8");
if (!buf.includes("version: v2") || !buf.includes("path: proto")) {
  fail("buf.yaml must define the proto module");
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
  "Protobuf/Buf IDL is for service and transport boundaries only"
]) {
  if (!docs.includes(required)) fail(`consumption docs missing: ${required}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("model-fusion protocol check passed");
