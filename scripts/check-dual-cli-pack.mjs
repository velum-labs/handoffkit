import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const entries = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const directory = join(root, "packages", entry.name);
    const manifestPath = join(directory, "package.json");
    return existsSync(manifestPath)
      ? [{ directory, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) }]
      : [];
  });
const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]));

function internalClosure(rootName) {
  const closure = [];
  const pending = [rootName];
  const seen = new Set();
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const entry = byName.get(name);
    if (entry === undefined) continue;
    closure.push(entry);
    for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
      if (dependency.startsWith("@velum-labs/routekit") || dependency.startsWith("@fusionkit/")) {
        pending.push(dependency);
      }
    }
  }
  return { closure, seen };
}

const routekit = internalClosure("@velum-labs/routekit");
const fusionkit = internalClosure("@fusionkit/cli");
if (routekit.seen.has("@fusionkit/cli")) {
  throw new Error("RouteKit package closure must not include @fusionkit/cli");
}
if (fusionkit.seen.has("@velum-labs/routekit")) {
  throw new Error("FusionKit package closure must not include @velum-labs/routekit");
}
const combined = new Map(
  [...routekit.closure, ...fusionkit.closure].map((entry) => [entry.manifest.name, entry])
);

const temporary = mkdtempSync(join(tmpdir(), "dual-cli-pack-smoke-"));
const tarballs = join(temporary, "tarballs");
const install = join(temporary, "install");
try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(install, { recursive: true });
  for (const entry of combined.values()) {
    execFileSync("pnpm", ["pack", "--pack-destination", tarballs], {
      cwd: entry.directory,
      stdio: "pipe"
    });
  }
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ name: "dual-cli-install-smoke", private: true }, null, 2)}\n`
  );
  const packed = readdirSync(tarballs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => resolve(tarballs, name));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packed],
    { cwd: install, stdio: "pipe" }
  );

  for (const packageName of ["@velum-labs/routekit", "@fusionkit/cli"]) {
    if (!existsSync(join(install, "node_modules", packageName, "package.json"))) {
      throw new Error(`co-install is missing ${packageName}`);
    }
  }
  const routekitBin = join(install, "node_modules", ".bin", "routekit");
  const fusionkitBin = join(install, "node_modules", ".bin", "fusionkit");
  if (!existsSync(routekitBin) || !existsSync(fusionkitBin)) {
    throw new Error("co-install must expose both routekit and fusionkit binaries");
  }
  if (realpathSync(routekitBin) === realpathSync(fusionkitBin)) {
    throw new Error("routekit and fusionkit binaries must resolve to distinct entrypoints");
  }
  const routekitVersion = execFileSync(routekitBin, ["version"], {
    cwd: install,
    encoding: "utf8"
  });
  const fusionkitVersion = execFileSync(fusionkitBin, ["--version"], {
    cwd: install,
    encoding: "utf8"
  });
  if (!routekitVersion.includes("@velum-labs/routekit")) {
    throw new Error(`routekit executable returned unexpected output: ${routekitVersion}`);
  }
  if (!fusionkitVersion.includes("@fusionkit/cli")) {
    throw new Error(`fusionkit executable returned unexpected output: ${fusionkitVersion}`);
  }
  process.stdout.write(
    `dual CLI pack/install smoke passed (${routekit.closure.length} RouteKit, ` +
      `${fusionkit.closure.length} FusionKit, ${combined.size} unique packages)\n`
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
