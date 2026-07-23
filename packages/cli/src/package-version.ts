import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { probeBinaryVersion, readPackageVersion } from "@velum-labs/routekit-cli-core";

import { FUSIONKIT_PYPI_VERSION, fusionkitWarmArgv } from "./fusion/env.js";
import { hasBinary } from "./shared/preflight.js";
import { toolRegistry } from "./tools.js";

const require = createRequire(import.meta.url);

export function readToolPackageVersion(toolId: string): string | null {
  const packageName = toolRegistry.get(toolId)?.packageName;
  if (packageName === undefined) return null;
  try {
    let dir = dirname(require.resolve(packageName));
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === packageName && typeof pkg.version === "string") return pkg.version;
      } catch {
        // keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Package is not installed.
  }
  return null;
}

async function probeCachedSynthesizerVersion(): Promise<string | null> {
  if (!hasBinary("uvx") && !hasBinary("uv")) return null;
  const argv = fusionkitWarmArgv(undefined, { offline: true });
  const probe = spawnSync(argv.command, [...argv.args.slice(0, -1), "--version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (probe.status !== 0) return null;
  const line = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim().split("\n")[0]?.trim();
  return line && line.length > 0 ? line : null;
}

export type VersionMatrix = {
  cli: string;
  synthesizerPinned: string;
  synthesizerCached: string | null;
  runners: Record<string, string | null>;
  agents: Record<string, string | null>;
  tools: Record<string, string | null>;
};

export async function collectVersionMatrix(): Promise<VersionMatrix> {
  const runners: Record<string, string | null> = {};
  for (const binary of ["uv", "uvx"]) {
    runners[binary] = probeBinaryVersion(binary, { available: hasBinary });
  }
  const agents: Record<string, string | null> = {};
  const tools: Record<string, string | null> = {};
  for (const tool of toolRegistry.list()) {
    if (tool.binary !== undefined) {
      agents[tool.id] = probeBinaryVersion(tool.binary, { available: hasBinary });
    }
    tools[tool.id] = readToolPackageVersion(tool.id);
  }
  return {
    cli: readPackageVersion(import.meta.url, "../package.json"),
    synthesizerPinned: FUSIONKIT_PYPI_VERSION,
    synthesizerCached: await probeCachedSynthesizerVersion(),
    runners,
    agents,
    tools
  };
}
