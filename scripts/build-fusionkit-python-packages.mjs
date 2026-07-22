import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const topology = JSON.parse(readFileSync("release/workspace.release.json", "utf8"));
const release = topology.units?.find((unit) => unit.key === "fusionkit-pypi");
const packages = release?.packages;

if (!Array.isArray(packages) || packages.length === 0) {
  throw new Error("fusionkit-pypi release metadata must declare packages");
}

for (const [index, packageName] of packages.entries()) {
  const result = spawnSync(
    "uv",
    [
      "build",
      "--package",
      packageName,
      "--out-dir",
      "dist",
      ...(index === 0 ? ["--clear"] : [])
    ],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
