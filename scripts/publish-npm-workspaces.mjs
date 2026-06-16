import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("release/npm-packages.json", "utf8"));
const dryRun = process.argv.includes("--dry-run");
const registry = manifest.registry;
const packDir = resolve("release-artifacts/npm");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!dryRun && process.env.GITHUB_REPOSITORY !== manifest.canonicalRepository) {
  throw new Error(`refusing to publish outside ${manifest.canonicalRepository}`);
}

if (!dryRun && !process.env.NODE_AUTH_TOKEN) {
  throw new Error("NODE_AUTH_TOKEN is required for npm publish");
}

if (dryRun) {
  mkdirSync(packDir, { recursive: true });
}

for (const entry of manifest.packages) {
  const label = `${entry.name} (${entry.path})`;
  if (dryRun) {
    console.log(`packing ${label}`);
    run("corepack", [
      "pnpm",
      "--dir",
      entry.path,
      "pack",
      "--pack-destination",
      packDir
    ]);
    continue;
  }

  console.log(`publishing ${label}`);
  run("corepack", [
    "pnpm",
    "--dir",
    entry.path,
    "publish",
    "--no-git-checks",
    "--access",
    manifest.access,
    "--registry",
    registry
  ], {
    env: {
      ...process.env,
      npm_config_provenance: "true",
      npm_config_registry: registry
    }
  });
}

if (dryRun) {
  console.log(`packed npm tarballs in ${join(packDir)}`);
}
