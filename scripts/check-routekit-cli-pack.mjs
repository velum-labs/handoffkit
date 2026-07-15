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

const root = process.cwd();
const packageEntries = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = join(root, "packages", entry.name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) return undefined;
    return {
      directory,
      manifest: JSON.parse(readFileSync(manifestPath, "utf8"))
    };
  })
  .filter((entry) => entry !== undefined);
const byName = new Map(packageEntries.map((entry) => [entry.manifest.name, entry]));
const closure = [];
const pending = ["@routekit/cli"];
const seen = new Set();
while (pending.length > 0) {
  const name = pending.shift();
  if (name === undefined || seen.has(name)) continue;
  seen.add(name);
  if (name.startsWith("@fusionkit/")) {
    throw new Error(`RouteKit package closure reached forbidden dependency ${name}`);
  }
  const entry = byName.get(name);
  if (entry === undefined) continue;
  closure.push(entry);
  for (const dependency of Object.keys(entry.manifest.dependencies ?? {})) {
    if (dependency.startsWith("@routekit/") || dependency.startsWith("@fusionkit/")) {
      pending.push(dependency);
    }
  }
}

const temporary = mkdtempSync(join(tmpdir(), "routekit-pack-smoke-"));
const tarballs = join(temporary, "tarballs");
const install = join(temporary, "install");
try {
  mkdirSync(tarballs, { recursive: true });
  mkdirSync(install, { recursive: true });
  for (const entry of closure) {
    execFileSync(
      "pnpm",
      ["pack", "--pack-destination", tarballs],
      { cwd: entry.directory, stdio: "pipe" }
    );
  }
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ name: "routekit-install-smoke", private: true }, null, 2)}\n`
  );
  const packed = readdirSync(tarballs)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => resolve(tarballs, name));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packed],
    { cwd: install, stdio: "pipe" }
  );
  if (existsSync(join(install, "node_modules", "@fusionkit"))) {
    throw new Error("smoke install unexpectedly contains @fusionkit packages");
  }
  const output = execFileSync(
    join(install, "node_modules", ".bin", "routekit"),
    ["version"],
    { cwd: install, encoding: "utf8" }
  );
  if (!output.includes("@routekit/cli")) {
    throw new Error(`installed routekit executable returned unexpected output: ${output}`);
  }
  process.stdout.write(`routekit pack/install smoke passed (${closure.length} packages)\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
