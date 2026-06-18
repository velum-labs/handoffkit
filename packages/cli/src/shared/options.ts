import type {
  EnsembleModel,
  HarnessLiveSmokeTarget,
  UnifiedHarnessKind
} from "@warrant/ensemble";
import { SESSION_ISOLATIONS } from "@warrant/protocol";
import type { SessionIsolation } from "@warrant/protocol";

import type { FusionTool, PanelModelSpec, PanelProvider } from "../fusion-quickstart.js";
import { FUSION_TOOLS } from "../fusion-quickstart.js";

import { fail } from "./errors.js";

/** Commander reducer for repeatable string options (`--flag a --flag b`). */
export function collect(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

/** Parse `ID=VALUE`, failing with a flag-specific message on malformed input. */
export function parseIdValue(flag: string, spec: string): { id: string; value: string } {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    fail(`${flag} must be ID=VALUE, got "${spec}"`);
  }
  return { id: spec.slice(0, separator), value: spec.slice(separator + 1) };
}

/**
 * Map `--model ID=MODEL` specs to ensemble models, falling back to harness-aware
 * defaults when none are given.
 */
export function ensembleModels(model: string[] | undefined, harness?: string): EnsembleModel[] {
  const specs =
    model ?? (harness === "command" ? ["command=local-shell"] : ["fast=fake-fast", "writer=fake-writer"]);
  return specs.map((spec) => {
    const separator = spec.indexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      fail(`--model must be ID=MODEL, got "${spec}"`);
    }
    return { id: spec.slice(0, separator), model: spec.slice(separator + 1) };
  });
}

export function liveSmokeTargets(targets: string[] | undefined): HarnessLiveSmokeTarget[] {
  return (targets ?? []).map((target) => {
    switch (target) {
      case "claude-code":
      case "codex":
        return target;
      default:
        fail('--live-smoke must be "claude-code" or "codex"');
    }
  });
}

export function unifiedHarnessKinds(targets: string[] | undefined): UnifiedHarnessKind[] {
  return (targets ?? ["mock", "command"])
    .flatMap((target) => target.split(","))
    .map((target): UnifiedHarnessKind => {
      switch (target) {
        case "mock":
        case "command":
        case "agent":
        case "codex":
        case "claude-code":
        case "cursor-acp":
        case "cursor-desktop":
          return target;
        default:
          fail(
            `--harness must be mock, command, agent, codex, claude-code, cursor-acp, or cursor-desktop; got "${target}"`
          );
      }
    });
}

export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  const timeoutMs = Number(raw ?? String(fallback));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout-ms must be positive");
  return timeoutMs;
}

export function parsePort(raw: string | undefined, fallback: number): number {
  const port = Number(raw ?? String(fallback));
  if (!Number.isInteger(port) || port < 0) fail("--port must be a non-negative integer");
  return port;
}

export function isolationFlag(value: string | undefined): SessionIsolation | undefined {
  if (value === undefined) return undefined;
  if (!SESSION_ISOLATIONS.includes(value as SessionIsolation)) {
    fail(`--isolation must be one of ${SESSION_ISOLATIONS.join(" | ")}`);
  }
  return value as SessionIsolation;
}

export const PANEL_PROVIDERS: readonly PanelProvider[] = [
  "mlx",
  "openai",
  "anthropic",
  "google",
  "openai-compatible"
];

export function parseFusionTool(value: string | undefined): FusionTool {
  if (value === undefined || !(FUSION_TOOLS as readonly string[]).includes(value)) {
    fail(`--tool must be one of ${FUSION_TOOLS.join(" | ")}`);
  }
  return value as FusionTool;
}

/** Parse `id=provider:model` (or `id=model`, defaulting to the local mlx provider). */
export function parsePanelModelSpec(spec: string, keyEnvs: Record<string, string>): PanelModelSpec {
  const { id, value } = parseIdValue("--model", spec);
  const colon = value.indexOf(":");
  let provider: PanelProvider = "mlx";
  let model = value;
  if (colon > 0) {
    const maybe = value.slice(0, colon);
    if ((PANEL_PROVIDERS as readonly string[]).includes(maybe)) {
      provider = maybe as PanelProvider;
      model = value.slice(colon + 1);
    }
  }
  return { id, model, provider, ...(keyEnvs[id] !== undefined ? { keyEnv: keyEnvs[id] } : {}) };
}
