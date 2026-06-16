import { spawnSync } from "node:child_process";

const generatedFiles = [
  "packages/protocol/src/generated/model-fusion-openapi.ts",
  "packages/protocol/generated/python/velum_model_fusion_protocol/__init__.py",
  "packages/protocol/generated/python/velum_model_fusion_protocol/model_fusion_openapi.py"
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ["scripts/generate-model-fusion-openapi-sdk.mjs"]);
run("python3", [
  "-m",
  "py_compile",
  "packages/protocol/generated/python/velum_model_fusion_protocol/__init__.py",
  "packages/protocol/generated/python/velum_model_fusion_protocol/model_fusion_openapi.py"
]);

const diff = spawnSync("git", ["diff", "--exit-code", "--", ...generatedFiles], {
  encoding: "utf8"
});
if (diff.status !== 0) {
  if (diff.stdout) process.stdout.write(diff.stdout);
  if (diff.stderr) process.stderr.write(diff.stderr);
  console.error("generated model-fusion OpenAPI SDK files are stale; rerun scripts/generate-model-fusion-openapi-sdk.mjs");
  process.exit(diff.status ?? 1);
}

console.log("generated model-fusion OpenAPI SDK check passed");
