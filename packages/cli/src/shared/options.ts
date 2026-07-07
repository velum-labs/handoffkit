import type { EnsembleModel, PanelTrust, UnifiedHarnessKind } from "@fusionkit/ensemble";
import type { OnRateLimitPolicy } from "@fusionkit/model-gateway";
import { SESSION_ISOLATIONS } from "@fusionkit/protocol";
import type { SessionIsolation } from "@fusionkit/protocol";

import type { HarnessLiveSmokeTarget } from "../dashboard.js";
import { toolRegistry } from "../tools.js";

import type { FusionTool, PanelAuthMode, PanelModelSpec, PanelProvider } from "../fusion-quickstart.js";
import { FUSION_TOOLS } from "../fusion-quickstart.js";
import { PANEL_AUTH_MODES, PANEL_PROVIDERS, panelProviderForAuthMode } from "../fusion/env.js";

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
  const valid = new Set(
    toolRegistry
      .dashboardTools()
      .filter((tool) => tool.liveSmoke !== undefined)
      .map((tool) => tool.id)
  );
  return (targets ?? []).map((target): HarnessLiveSmokeTarget => {
    if (valid.has(target)) return target;
    return fail(`--live-smoke must be one of ${[...valid].join(", ")}`);
  });
}

export function unifiedHarnessKinds(targets: string[] | undefined): UnifiedHarnessKind[] {
  const generic: UnifiedHarnessKind[] = ["mock", "command", "agent"];
  const valid = new Set<UnifiedHarnessKind>([...generic, ...toolRegistry.harnessKinds()]);
  return (targets ?? ["mock", "command"])
    .flatMap((target) => target.split(","))
    .map((target): UnifiedHarnessKind => {
      if (valid.has(target as UnifiedHarnessKind)) return target as UnifiedHarnessKind;
      return fail(`--harness must be one of ${[...valid].join(", ")}; got "${target}"`);
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

/** Parse `--budget <usd>` (WS7): a positive dollar cap. Returns undefined when unset. */
export function parseBudget(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const budget = Number(value);
  if (!Number.isFinite(budget) || budget <= 0) fail("--budget must be a positive number of USD");
  return budget;
}

/** Parse `--k <n>`: a positive integer (step boundaries per panel member). */
export function parseK(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const k = Number(value);
  if (!Number.isInteger(k) || k < 1) {
    fail("--k must be a positive integer (step boundaries per panel member before aggregation)");
  }
  return k;
}

export function isolationFlag(value: string | undefined): SessionIsolation | undefined {
  if (value === undefined) return undefined;
  if (!SESSION_ISOLATIONS.includes(value as SessionIsolation)) {
    fail(`--isolation must be one of ${SESSION_ISOLATIONS.join(" | ")}`);
  }
  return value as SessionIsolation;
}

export { PANEL_AUTH_MODES, PANEL_PROVIDERS };

/**
 * WS5 rate-limit / credit handoff picker options — the one description of each
 * policy, shared by every interactive surface (`config set onRateLimit`, the
 * init extras step). The flag-validation list below derives from it.
 */
export const ON_RATE_LIMIT_OPTIONS: ReadonlyArray<{
  value: OnRateLimitPolicy;
  label: string;
  hint: string;
}> = [
  { value: "fusion", label: "fusion", hint: "continue on the ensemble (default)" },
  { value: "passthrough", label: "passthrough", hint: "surface the vendor error to the tool" },
  { value: "fail", label: "fail", hint: "stop the session" }
];

/** WS5 rate-limit / credit handoff policies (`--on-rate-limit`). */
export const ON_RATE_LIMIT_POLICIES: readonly OnRateLimitPolicy[] = ON_RATE_LIMIT_OPTIONS.map(
  (option) => option.value
);

export function parseOnRateLimit(value: string | undefined): OnRateLimitPolicy | undefined {
  if (value === undefined) return undefined;
  if (!(ON_RATE_LIMIT_POLICIES as readonly string[]).includes(value)) {
    fail(`--on-rate-limit must be one of ${ON_RATE_LIMIT_POLICIES.join(" | ")}`);
  }
  return value as OnRateLimitPolicy;
}

/** Panel trust picker options, shared by every interactive surface. */
export const PANEL_TRUST_OPTIONS: ReadonlyArray<{ value: PanelTrust; label: string; hint: string }> = [
  { value: "full", label: "full", hint: "maximum autonomy (default)" },
  { value: "guarded", label: "guarded", hint: "harness-fenced to the worktree" }
];

/** Panel candidate trust levels (`--panel-trust`). `full` is the default. */
export const PANEL_TRUST_LEVELS: readonly PanelTrust[] = PANEL_TRUST_OPTIONS.map(
  (option) => option.value
);

export function parsePanelTrust(value: string | undefined): PanelTrust | undefined {
  if (value === undefined) return undefined;
  if (!(PANEL_TRUST_LEVELS as readonly string[]).includes(value)) {
    fail(`--panel-trust must be one of ${PANEL_TRUST_LEVELS.join(" | ")}`);
  }
  return value as PanelTrust;
}

export function parseFusionTool(value: string | undefined): FusionTool {
  if (value === undefined || !(FUSION_TOOLS as readonly string[]).includes(value)) {
    fail(`--tool must be one of ${FUSION_TOOLS.join(" | ")}`);
  }
  return value as FusionTool;
}

/**
 * Parse `id=provider:model` (or `id=model`, defaulting to the local mlx
 * provider). The prefix may also be a subscription auth mode: `id=claude-code:model`
 * reuses the Claude Code login (provider anthropic), `id=codex:model` reuses the
 * Codex login (provider codex). Subscription specs carry no `keyEnv`.
 */
export function parsePanelModelSpec(spec: string, keyEnvs: Record<string, string>): PanelModelSpec {
  const { id, value } = parseIdValue("--model", spec);
  const colon = value.indexOf(":");
  if (colon > 0) {
    const maybe = value.slice(0, colon);
    const model = value.slice(colon + 1);
    if ((PANEL_AUTH_MODES as readonly string[]).includes(maybe)) {
      const auth = maybe as PanelAuthMode;
      // The auth-mode -> provider mapping comes from the subscription registry:
      // claude-code maps to the anthropic provider; codex has its own provider
      // on the FusionKit side (derived in routerConfigYaml from `auth`).
      const provider = panelProviderForAuthMode(auth);
      return provider !== undefined ? { id, model, provider, auth } : { id, model, auth };
    }
    if ((PANEL_PROVIDERS as readonly string[]).includes(maybe)) {
      return {
        id,
        model,
        provider: maybe as PanelProvider,
        ...(keyEnvs[id] !== undefined ? { keyEnv: keyEnvs[id] } : {})
      };
    }
  }
  return { id, model: value, provider: "mlx", ...(keyEnvs[id] !== undefined ? { keyEnv: keyEnvs[id] } : {}) };
}
