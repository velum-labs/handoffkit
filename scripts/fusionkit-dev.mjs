#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliEntry = resolve(repoRoot, "packages", "cli", "dist", "index.js");

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function runBuild() {
  if (process.env.FUSIONKIT_DEV_SKIP_BUILD === "1") return;

  const result = spawnSync(commandName("corepack"), ["pnpm", "--dir", repoRoot, "build:cli"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit"
  });

  if (result.error !== undefined) {
    console.error(`fusionkit-dev: failed to start build: ${result.error.message}`);
    process.exit(1);
  }
  if (result.signal !== null) {
    console.error(`fusionkit-dev: build terminated by ${result.signal}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

runBuild();

if (!existsSync(cliEntry)) {
  console.error(`fusionkit-dev: missing built CLI at ${cliEntry}`);
  console.error("fusionkit-dev: run `pnpm build:cli` from the FusionKit checkout and try again.");
  process.exit(1);
}

const child = spawn(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, FUSIONKIT_DEV: "1" },
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(`fusionkit-dev: failed to launch local CLI: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
