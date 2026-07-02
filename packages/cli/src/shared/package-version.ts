import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FUSIONKIT_PYPI_VERSION, fusionkitWarmArgv } from "../fusion/env.js";
import { hasBinary } from "./preflight.js";
import { toolRegistry } from "../tools.js";

const require = createRequire(import.meta.url);

const TOOL_PACKAGE_BY_ID: Record<string, string> = {
  codex: "@fusionkit/tool-codex",
  claude: "@fusionkit/tool-claude",
  cursor: "@fusionkit/tool-cursor",
  opencode: "@fusionkit/tool-opencode"
};

const AGENT_BINARIES = [
  ["codex", "codex"],
  ["claude", "claude"],
  ["cursor-agent", "cursor"]
] as const;

/** Read `version` from the nearest ancestor package.json relative to a module URL. */
export function readPackageVersion(fromModuleUrl: string, relativePkgPath = "../package.json"): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL(relativePkgPath, fromModuleUrl)), "utf8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Best-effort first line from `binary --version` (2s timeout). */
export function probeBinaryVersion(binary: string): string | null {
  if (!hasBinary(binary)) return null;
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) return "unknown";
  const line = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0]?.trim();
  return line && line.length > 0 ? line : "unknown";
}

/** Resolve the installed @fusionkit/tool-* package version for a registry tool id. */
export function readToolPackageVersion(toolId: string): string | null {
  const packageName = TOOL_PACKAGE_BY_ID[toolId];
  if (packageName === undefined) return null;
  try {
    const entry = require.resolve(packageName);
    let dir = dirname(entry);
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
    return null;
  } catch {
    return null;
  }
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

/** Collect the full fusionkit version matrix for `fusionkit version`. */
export async function collectVersionMatrix(): Promise<VersionMatrix> {
  const runners: Record<string, string | null> = {};
  for (const binary of ["uv", "uvx"] as const) {
    runners[binary] = probeBinaryVersion(binary);
  }

  const agents: Record<string, string | null> = {};
  for (const [binary, label] of AGENT_BINARIES) {
    agents[label] = probeBinaryVersion(binary);
  }

  const tools: Record<string, string | null> = {};
  for (const tool of toolRegistry.list()) {
    tools[tool.id] = readToolPackageVersion(tool.id);
  }

  return {
    cli: readPackageVersion(import.meta.url, "../../package.json"),
    synthesizerPinned: FUSIONKIT_PYPI_VERSION,
    synthesizerCached: await probeCachedSynthesizerVersion(),
    runners,
    agents,
    tools
  };
}
