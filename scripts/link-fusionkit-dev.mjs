#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const wrapperPath = resolve(scriptDir, "fusionkit-dev.mjs");
const dryRun = process.argv.includes("--dry-run");

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function normalizePath(value) {
  const resolved = resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function findCommandOnPath(command) {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = resolve(entry, process.platform === "win32" ? `${command}${extension.toLowerCase()}` : command);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function readGlobalBinDir() {
  const result = spawnSync(commandName("pnpm"), ["bin", "-g"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });

  if (result.error !== undefined) {
    throw new Error(`could not run \`pnpm bin -g\`: ${result.error.message}`);
  }
  if ((result.status ?? 1) !== 0) {
    const output = `${result.stdout}${result.stderr}`.trim();
    throw new Error(output === "" ? "`pnpm bin -g` failed" : output);
  }

  const binDir = result.stdout.trim();
  if (binDir === "") throw new Error("`pnpm bin -g` returned an empty path");
  return binDir;
}

function writeUnixShim(binDir) {
  const target = resolve(binDir, "fusionkit-dev");
  const contents = `#!/bin/sh
exec node ${shellQuote(wrapperPath)} "$@"
`;

  if (dryRun) {
    console.log(`would write ${target}`);
    return target;
  }

  mkdirSync(binDir, { recursive: true });
  writeFileSync(target, contents, { mode: 0o755 });
  chmodSync(target, 0o755);
  console.log(`linked fusionkit-dev -> ${wrapperPath}`);
  return target;
}

function writeWindowsShim(binDir) {
  const cmdTarget = resolve(binDir, "fusionkit-dev.cmd");
  const shellTarget = resolve(binDir, "fusionkit-dev");
  const cmdContents = `@echo off
node "${wrapperPath}" %*
`;
  const shellContents = `#!/bin/sh
exec node ${shellQuote(wrapperPath)} "$@"
`;

  if (dryRun) {
    console.log(`would write ${cmdTarget}`);
    console.log(`would write ${shellTarget}`);
    return cmdTarget;
  }

  mkdirSync(binDir, { recursive: true });
  writeFileSync(cmdTarget, cmdContents);
  writeFileSync(shellTarget, shellContents, { mode: 0o755 });
  chmodSync(shellTarget, 0o755);
  console.log(`linked fusionkit-dev -> ${wrapperPath}`);
  return cmdTarget;
}

function warnIfShadowed(target) {
  const resolved = findCommandOnPath("fusionkit-dev");
  if (resolved === null) {
    console.warn(`warning: ${dirname(target)} is not on PATH, so \`fusionkit-dev\` will not resolve yet.`);
    return;
  }

  if (normalizePath(resolved) !== normalizePath(target)) {
    console.warn(`warning: \`fusionkit-dev\` currently resolves to ${resolved}`);
    console.warn(`warning: put ${dirname(target)} earlier on PATH to use ${target}`);
  }
}

if (!existsSync(wrapperPath)) {
  console.error(`fusionkit-dev link failed: missing wrapper at ${wrapperPath}`);
  process.exit(1);
}

try {
  const binDir = readGlobalBinDir();
  const target = process.platform === "win32" ? writeWindowsShim(binDir) : writeUnixShim(binDir);

  if (dryRun) {
    console.log(`global pnpm bin directory: ${binDir}`);
    console.log(`source checkout: ${repoRoot}`);
  } else {
    warnIfShadowed(target);
    console.log("run `fusionkit-dev --version` from any directory to verify the link.");
  }
} catch (error) {
  console.error(`fusionkit-dev link failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Make sure pnpm is installed and its global bin directory is configured on PATH.");
  process.exit(1);
}
