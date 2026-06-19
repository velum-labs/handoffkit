import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(readFileSync("release/npm-packages.json", "utf8"));
const root = JSON.parse(readFileSync("package.json", "utf8"));
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

// npm/pnpm pack flatten a scoped name to `<scope>-<name>-<version>.tgz`.
function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

if (!dryRun && process.env.GITHUB_REPOSITORY !== manifest.canonicalRepository) {
  throw new Error(`refusing to publish outside ${manifest.canonicalRepository}`);
}

mkdirSync(packDir, { recursive: true });

for (const entry of manifest.packages) {
  const label = `${entry.name} (${entry.path})`;
  // pnpm pack resolves `workspace:*` protocol deps to concrete versions in the
  // tarball's package.json, which a plain `npm publish` would not do.
  console.log(`packing ${label}`);
  run("corepack", ["pnpm", "--dir", entry.path, "pack", "--pack-destination", packDir]);
  if (dryRun) continue;

  const tarball = join(packDir, tarballName(entry.name, root.version));
  console.log(`publishing ${label}`);
  // Publish the packed tarball with npm directly: npm owns auth (NODE_AUTH_TOKEN
  // for the token bootstrap, or OIDC trusted publishing once configured) and
  // provenance. Going through `npm` (not `pnpm publish`) avoids pnpm's
  // npm-publish delegation breaking across npm major versions.
  run("npm", ["publish", tarball, "--access", manifest.access, "--registry", registry], {
    env: {
      ...process.env,
      NPM_CONFIG_PROVENANCE: "true",
      npm_config_registry: registry
    }
  });
}

if (dryRun) {
  console.log(`packed npm tarballs in ${join(packDir)}`);
}
