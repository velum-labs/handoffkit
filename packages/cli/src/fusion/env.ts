import { execFileSync } from "node:child_process";

import type {
  FusionRouterConfig,
  FusionTool,
  OnRateLimitPolicy,
  PanelTrust,
  PromptOverrides
} from "@fusionkit/config";

export type { FusionTool, OnRateLimitPolicy, PanelTrust };

export type EnsembleRunSpec = {
  name: string;
  members: string[];
  judge: string;
  synthesizer?: string;
  k?: number;
  prompts?: PromptOverrides;
};

export type RunFusionOptions = {
  router?: FusionRouterConfig;
  ensembles?: EnsembleRunSpec[];
  ensemble?: string;
  fusionkitDir?: string;
  repo?: string;
  observe?: boolean;
  reasoning?: boolean;
  effort?: string;
  yes?: boolean;
  subagents?: boolean;
  authToken?: string;
  port?: number;
  portless?: boolean;
  ide?: boolean;
  onRateLimit?: OnRateLimitPolicy;
  budgetUsd?: number;
  panelTrust?: PanelTrust;
  k?: number;
  resume?: string;
  continueLatest?: boolean;
  json?: boolean;
  log?: (line: string) => void;
};

export type StackEvent =
  | { kind: "server.start"; id: string; label: string }
  | { kind: "server.progress"; id: string; detail: string }
  | { kind: "server.ready"; id: string; detail: string }
  | { kind: "server.fail"; id: string; detail: string }
  | { kind: "synth.start" }
  | { kind: "synth.ready"; detail: string }
  | { kind: "gateway.start" }
  | { kind: "gateway.ready"; detail: string }
  | { kind: "dashboard.start" }
  | { kind: "dashboard.ready"; detail: string }
  | { kind: "dashboard.fail"; detail: string };

export type StackReporter = (event: StackEvent) => void;

export const FUSIONKIT_PYPI_VERSION = "0.8.0";

export function fusionkitPyCommand(fusionkitDir?: string): {
  command: string;
  prefix: string[];
  cwd?: string;
} {
  if (fusionkitDir !== undefined) {
    return {
      command: "uv",
      prefix: ["run", "--package", "fusionkit", "fusionkit-sidecar"],
      cwd: fusionkitDir
    };
  }
  return {
    command: "uvx",
    prefix: ["--from", `fusionkit@${FUSIONKIT_PYPI_VERSION}`, "fusionkit-sidecar"]
  };
}

export function fusionkitWarmArgv(
  fusionkitDir?: string,
  options: { offline?: boolean } = {}
): { command: string; args: string[]; cwd?: string } {
  const offline = options.offline === true ? ["--offline"] : [];
  if (fusionkitDir !== undefined) {
    return {
      command: "uv",
      args: [
        "run",
        ...offline,
        "--package",
        "fusionkit",
        "fusionkit-sidecar",
        "--help"
      ],
      cwd: fusionkitDir
    };
  }
  return {
    command: "uvx",
    args: [
      ...offline,
      "--from",
      `fusionkit@${FUSIONKIT_PYPI_VERSION}`,
      "fusionkit-sidecar",
      "--help"
    ]
  };
}

export function gitToplevel(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}
