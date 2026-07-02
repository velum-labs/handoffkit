/**
 * Shared types, panel defaults, and env helpers for the `fusionkit <tool>`
 * launcher. Kept dependency-light (node builtins only) so every other fusion
 * module and the orchestrator can import from here without cycles.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import type { PanelTrust } from "@fusionkit/ensemble";
import type { OnRateLimitPolicy } from "@fusionkit/model-gateway";

import type { PromptOverrides } from "../fusion-config.js";

export type { OnRateLimitPolicy };

/** A launchable tool id from the registry, or the `serve` pseudo-tool. */
export type FusionTool = string;

export type PanelProvider = "mlx" | "openai" | "anthropic" | "google" | "openai-compatible";

/**
 * Subscription auth modes: instead of an API key, reuse the user's local Claude
 * Code / Codex CLI login (read-only) on the FusionKit side. See FusionKit's
 * `EndpointAuth`.
 */
export type PanelAuthMode = "claude-code" | "codex";

/**
 * One panel model. `mlx` models run locally via the in-repo provisioner; cloud
 * providers (openai/anthropic/google/openai-compatible) are fronted as
 * OpenAI-compatible endpoints by FusionKit's `serve-endpoint` command, run via
 * `uvx fusionkit` (no checkout required). When `auth` is set, the model reuses
 * the matching subscription login instead of an API key (no `keyEnv`).
 */
export type PanelModelSpec = {
  id: string;
  model: string;
  provider?: PanelProvider;
  baseUrl?: string;
  keyEnv?: string;
  auth?: PanelAuthMode;
};

export type RunFusionOptions = {
  models?: PanelModelSpec[];
  endpoints?: Record<string, string>;
  fusionkitDir?: string;
  repo?: string;
  judgeModel?: string;
  synthesisUrl?: string;
  authToken?: string;
  port?: number;
  timeoutMs?: number;
  /** Use the local MLX panel trio (Apple Silicon) instead of the cloud panel. */
  local?: boolean;
  /** Boot the local scope dashboard and stream trace events into it. */
  observe?: boolean;
  /**
   * Reasoning traces: narrate panel/judge progress into the launched tool's own
   * thinking/reasoning UI while a fused turn runs. Default on; `--no-reasoning`
   * (or `reasoning: false` in .fusionkit) keeps the stream silent until the
   * judge's first token.
   */
  reasoning?: boolean;
  /**
   * Optional local MLX model that writes the narration prose (candidate gists
   * and the judging comparison). Off by default (templated prose); Apple
   * Silicon only. The narrator's timeout/sanitize guardrails always apply.
   */
  reasoningModel?: string;
  /** Skip the interactive cost/scope confirmation for the cloud panel. */
  yes?: boolean;
  /** Route services through portless (stable named URLs + singletons). Default on. */
  portless?: boolean;
  /** Cursor only: wire the desktop IDE (not just cursor-agent) to the gateway. */
  ide?: boolean;
  /**
   * WS5 rate-limit / credit handoff policy for vendor passthrough models:
   * `fusion` (default — continue the turn on the ensemble), `passthrough`
   * (return the vendor error verbatim), or `fail` (surface a gateway error).
   */
  onRateLimit?: OnRateLimitPolicy;
  /**
   * WS7 budget cap (USD). Plumbed to the gateway: once a session has accrued at
   * least this much gateway-observed cost, the next turn is refused with a clear
   * message (v1 = stop). Omit for no cap.
   */
  budgetUsd?: number;
  /**
   * Panel candidate trust level. `full` (default) gives each member the highest
   * autonomy its harness offers (e.g. Codex `danger-full-access`); `guarded`
   * keeps the harness's side-effects-derived confinement (worktree-fenced).
   */
  panelTrust?: PanelTrust;
  /** System-prompt overrides forwarded to the synthesizer's router config. */
  prompts?: PromptOverrides;
  /**
   * WS4 session continuity. `resume` rehydrates a specific persisted session id
   * (a prefix is accepted) into the new gateway process; `continueLatest`
   * (`--continue`) resolves to the most recently active session instead.
   */
  resume?: string;
  continueLatest?: boolean;
  log?: (line: string) => void;
};

/**
 * Structured boot progress. When a reporter is supplied the stack emits these
 * events instead of the plain `fusion: ...` log lines, so a live TUI (or any
 * other consumer) can render per-stage status. Without one, callers keep getting
 * the existing line logs.
 */
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

/**
 * The PyPI version of the `fusionkit` Python distribution that provides the
 * synthesizer (`fusionkit serve`) and the single-model OpenAI shim
 * (`fusionkit serve-endpoint`). Pinned so `uvx` resolves a reproducible build.
 */
export const FUSIONKIT_PYPI_VERSION = "0.8.0";

/**
 * Default cloud panel — a genuine decorrelated three-vendor trio (OpenAI +
 * Anthropic + Google), so the ensemble fuses three independent frontier voices
 * rather than a single cross-vendor pair. Works cross-platform with
 * `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` set (a member
 * whose key is missing simply fails its slot; survivors are still fused). The
 * judge defaults to the first entry. `gemini-2.5-pro` is the frontier-tier id in
 * the curated Google catalog and is accepted by the `google` provider path.
 */
export const DEFAULT_CLOUD_PANEL: readonly PanelModelSpec[] = [
  { id: "gpt", model: "gpt-5.5", provider: "openai" },
  { id: "sonnet", model: "claude-sonnet-4-6", provider: "anthropic" },
  { id: "gemini", model: "gemini-2.5-pro", provider: "google" }
];

/**
 * The default narration-writer model for a bare `--reasoning-model` flag: the
 * smallest local model that passed both narration tasks (gist + comparison) in
 * the head-to-head benchmark. Already part of the curated local catalog.
 */
export const DEFAULT_REASONING_MODEL = "mlx-community/Qwen3-1.7B-4bit";

/** The locally cached MLX trio (Apple Silicon only) used behind `--local`. */
export const DEFAULT_TRIO: readonly PanelModelSpec[] = [
  { id: "qwen", model: "mlx-community/Qwen3-1.7B-4bit", provider: "mlx" },
  { id: "gemma", model: "mlx-community/gemma-3-1b-it-4bit", provider: "mlx" },
  { id: "llama", model: "mlx-community/Llama-3.2-1B-Instruct-4bit", provider: "mlx" }
];

/**
 * How to invoke the `fusionkit` Python CLI: from PyPI via `uvx` by default
 * (no checkout), or from a local checkout via `uv run` when `fusionkitDir` is
 * given (a dev override). Returns the command plus the argv prefix that
 * precedes the subcommand (`serve`, `serve-endpoint`, ...).
 */
export function fusionkitPyCommand(fusionkitDir?: string): {
  command: string;
  prefix: string[];
  cwd?: string;
} {
  if (fusionkitDir !== undefined) {
    return { command: "uv", prefix: ["run", "fusionkit"], cwd: fusionkitDir };
  }
  return { command: "uvx", prefix: [`fusionkit@${FUSIONKIT_PYPI_VERSION}`] };
}

/**
 * The argv that "warms" (pre-provisions) the pinned `fusionkit` engine: it
 * resolves, downloads, and builds the package into the local `uv` cache so the
 * first real `fusionkit serve` run doesn't pay the cold-start cost. We invoke
 * the engine's own `--help`, which is the cheapest entrypoint that still forces
 * `uvx`/`uv` to materialize the exact same environment a run uses (the resolved
 * package is cached regardless of what the subcommand then does). With
 * `offline: true` it never touches the network, so a zero exit code is a
 * reliable "already cached" probe. Mirrors {@link fusionkitPyCommand} so the
 * warmed environment is byte-for-byte the one a run resolves.
 */
export function fusionkitWarmArgv(
  fusionkitDir?: string,
  options: { offline?: boolean } = {}
): { command: string; args: string[]; cwd?: string } {
  const offline = options.offline === true ? ["--offline"] : [];
  if (fusionkitDir !== undefined) {
    return { command: "uv", args: ["run", ...offline, "fusionkit", "--help"], cwd: fusionkitDir };
  }
  return { command: "uvx", args: [...offline, `fusionkit@${FUSIONKIT_PYPI_VERSION}`, "--help"] };
}

/**
 * Parse a `.env` file (KEY=VALUE lines, `#` comments, optional `export`,
 * single/double quotes) and fill any keys not already present in `env`.
 * Existing env values win, so an explicitly exported key is never overridden.
 */
export function loadEnvFileInto(path: string, env: Record<string, string | undefined>): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
}

/**
 * Default provider base URL when a cloud spec carries no explicit `baseUrl`.
 * Mirrors `PROVIDER_DEFAULT_BASE_URL` in fusionkit's openai_endpoint.py. Used
 * both for the router config (fusionkit's `ModelEndpoint` requires `base_url`)
 * and for the preflight key-validation probes.
 */
export function providerDefaultBaseUrl(provider: Exclude<PanelProvider, "mlx">): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com";
    case "anthropic":
      return "https://api.anthropic.com";
    case "google":
      return "https://generativelanguage.googleapis.com";
    case "openai-compatible":
      return "http://127.0.0.1";
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown provider ${String(exhaustive)}`);
    }
  }
}

/** Default env var holding the API key for each cloud provider. */
export function defaultKeyEnv(provider: PanelProvider): string | undefined {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GEMINI_API_KEY";
    case "openai-compatible":
    case "mlx":
      return undefined;
    default: {
      const exhaustive: never = provider;
      throw new Error(`unknown provider ${String(exhaustive)}`);
    }
  }
}

/** The git repository root containing `dir`, or undefined if it is not in a repo. */
export function gitToplevel(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      // Don't leak git's "fatal: not a git repository" to our stderr; we surface
      // a clearer message ourselves.
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}
