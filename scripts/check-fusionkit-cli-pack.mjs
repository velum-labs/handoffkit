import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg !== "--require-scope") throw new Error(`unknown argument: ${arg}`);
}
const requireScope = args.includes("--require-scope");
const root = process.cwd();
const entries = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const directory = join(root, "packages", entry.name);
    const manifestPath = join(directory, "package.json");
    return existsSync(manifestPath)
      ? [
          {
            directory,
            manifest: JSON.parse(readFileSync(manifestPath, "utf8"))
          }
        ]
      : [];
  });
const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]));
const closure = [];
const pending = ["@fusionkit/cli"];
const seen = new Set();
while (pending.length > 0) {
  const name = pending.shift();
  if (name === undefined || seen.has(name)) continue;
  seen.add(name);
  if (name === "@velum-labs/routekit") {
    throw new Error("FusionKit dependency closure must not include @velum-labs/routekit");
  }
  const entry = byName.get(name);
  if (entry === undefined) continue;
  closure.push(entry);
  for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
    if (dependency.startsWith("@velum-labs/routekit") || dependency.startsWith("@fusionkit/")) {
      pending.push(dependency);
    }
  }
}

for (const required of ["@velum-labs/routekit-config", "@velum-labs/routekit-router", "@velum-labs/routekit-gateway"]) {
  if (!seen.has(required)) throw new Error(`FusionKit package closure is missing ${required}`);
}
const cliEntry = byName.get("@fusionkit/cli");
if (cliEntry === undefined) throw new Error("FusionKit package closure is missing @fusionkit/cli");
const sourceScopeServer = join(cliEntry.directory, "scope", "server.js");
const scopeIsStaged = existsSync(sourceScopeServer);
if (requireScope && !scopeIsStaged) {
  throw new Error(
    "FusionKit Scope bundle is required but packages/cli/scope/server.js is not staged; " +
      "build apps/scope and run node scripts/stage-scope.mjs first"
  );
}

const temporary = mkdtempSync(join(tmpdir(), "fusionkit-pack-smoke-"));
const tarballs = join(temporary, "tarballs");
const install = join(temporary, "install");
try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(install, { recursive: true });
  for (const entry of closure) {
    execFileSync("pnpm", ["pack", "--pack-destination", tarballs], {
      cwd: entry.directory,
      stdio: "pipe"
    });
  }
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ name: "fusionkit-install-smoke", private: true }, null, 2)}\n`
  );
  const packed = readdirSync(tarballs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => resolve(tarballs, name));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packed],
    { cwd: install, stdio: "pipe" }
  );
  if (existsSync(join(install, "node_modules", ".bin", "routekit"))) {
    throw new Error("FusionKit clean install unexpectedly includes the routekit executable");
  }
  const installedScopeServer = join(
    install,
    "node_modules",
    "@fusionkit",
    "cli",
    "scope",
    "server.js"
  );
  if (scopeIsStaged && !existsSync(installedScopeServer)) {
    throw new Error("packed @fusionkit/cli is missing the staged scope/server.js bundle");
  }
  const output = execFileSync(
    join(install, "node_modules", ".bin", "fusionkit"),
    ["--version"],
    { cwd: install, encoding: "utf8" }
  );
  if (!output.includes("@fusionkit/cli")) {
    throw new Error(`installed FusionKit returned unexpected output: ${output}`);
  }
  process.stdout.write(
    `fusionkit pack/install smoke passed (${closure.length} packages; ` +
      `Scope bundle ${scopeIsStaged ? "verified" : "not staged"})\n`
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
