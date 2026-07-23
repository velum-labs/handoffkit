import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function resultOutput(result) {
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === "string")
    .join("\n");
}

export function exactPackageVersionExists(
  name,
  version,
  { registry, spawn = spawnSync } = {}
) {
  const result = spawn(
    "npm",
    ["view", `${name}@${version}`, "version", "--json", "--registry", registry],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  if (result.status === 0) return true;
  const output = resultOutput(result);
  if (/\bE404\b|404 Not Found/.test(output)) return false;
  if (output) process.stderr.write(`${output.trimEnd()}\n`);
  throw new Error(`could not query ${name}@${version} on ${registry}`);
}

export function publishTarball(
  { name, version, tarball, registry, access },
  { spawn = spawnSync } = {}
) {
  const exists = () => exactPackageVersionExists(name, version, { registry, spawn });
  if (exists()) {
    console.log(`skipping ${name}@${version}: already published`);
    return "skipped";
  }

  const result = spawn(
    "npm",
    ["publish", tarball, "--access", access, "--registry", registry],
    {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        NPM_CONFIG_PROVENANCE: "true",
        npm_config_registry: registry
      }
    }
  );
  if (result.status === 0) return "published";

  // A concurrent or partially retried release may have published this exact
  // immutable version after the preflight query. Confirm registry state before
  // treating the command failure as fatal.
  if (exists()) {
    console.log(`continuing after ${name}@${version} became available`);
    return "recovered";
  }
  throw new Error(`npm publish failed for ${name}@${version}`);
}

// npm/pnpm pack flatten a scoped name to `<scope>-<name>-<version>.tgz`.
function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

function main() {
  const manifest = JSON.parse(readFileSync("release/npm-packages.json", "utf8"));
  const root = JSON.parse(readFileSync("package.json", "utf8"));
  const dryRun = process.argv.includes("--dry-run");
  const registry = manifest.registry;
  const packDir = resolve("release-artifacts/npm");

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
    publishTarball({
      name: entry.name,
      version: root.version,
      tarball,
      registry,
      access: manifest.access
    });
  }

  if (dryRun) {
    console.log(`packed npm tarballs in ${join(packDir)}`);
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
