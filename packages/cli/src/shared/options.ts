import type { OnRateLimitPolicy, PanelTrust } from "@fusionkit/config";
import { SESSION_ISOLATIONS } from "@fusionkit/protocol";
import type { SessionIsolation } from "@fusionkit/protocol";
import {
  collect,
  parseIdValue,
  parsePort,
  parsePositiveInteger,
  parsePositiveNumber
} from "@routekit/cli-core";

import { fail } from "@routekit/cli-core";

export { collect, parseIdValue, parsePort };

/** Parse `--budget <usd>` (WS7): a positive dollar cap. Returns undefined when unset. */
export function parseBudget(value: string | undefined): number | undefined {
  return parsePositiveNumber("--budget", value, "a positive number of USD");
}

/** Parse `--k <n>`: a positive integer (step boundaries per panel member). */
export function parseK(value: string | undefined): number | undefined {
  return parsePositiveInteger(
    "--k",
    value,
    "a positive integer (step boundaries per panel member before aggregation)"
  );
}

export function isolationFlag(value: string | undefined): SessionIsolation | undefined {
  if (value === undefined) return undefined;
  if (!SESSION_ISOLATIONS.includes(value as SessionIsolation)) {
    fail(`--isolation must be one of ${SESSION_ISOLATIONS.join(" | ")}`);
  }
  return value as SessionIsolation;
}

/**
 * WS5 rate-limit / credit handoff picker prompt, shared by every interactive
 * surface (`fusionkit init` extras, `fusionkit config edit`).
 */
export const ON_RATE_LIMIT_MESSAGE = "When a vendor passthrough model hits a rate limit / credit wall";

/**
 * WS5 rate-limit / credit handoff picker options — the one description of each
 * policy, shared by every interactive surface (`config edit`, the init extras
 * step). Each label is the exact value written to `.fusionkit/fusion.json`
 * (`onRateLimit`), and each hint describes the runtime behavior in
 * `FusionVendorProxy`. The flag-validation list below derives from it.
 */
export const ON_RATE_LIMIT_OPTIONS: ReadonlyArray<{
  value: OnRateLimitPolicy;
  label: string;
  hint: string;
}> = [
  {
    value: "fusion",
    label: "fusion",
    hint: "rerun the turn on the fusion ensemble (minus the throttled vendor) and answer from there (default)"
  },
  {
    value: "passthrough",
    label: "passthrough",
    hint: "return the vendor's error to the coding agent as-is (no fallback)"
  },
  { value: "fail", label: "fail", hint: "stop the session with a gateway error" }
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

/**
 * Panel sandbox (`panelTrust`) prompt copy — the one description of each
 * level, shared by every interactive surface (the init extras step, `config
 * edit`, the `config set` picker). Each panel model drafts unattended in its
 * own disposable git worktree; this setting decides whether it may also act
 * outside that worktree. The option labels are exactly the values persisted
 * to `fusion.json` (and accepted by `--panel-trust`), so what the prompts
 * show is what the config says.
 */
export const PANEL_TRUST_MESSAGE = "Panel model sandbox — what may each model touch while it drafts?";

/** One-line explainer shown above the panel sandbox picker. */
export const PANEL_TRUST_HELP =
  "each panel model drafts unattended in its own disposable git worktree. " +
  "full lifts the coding agent's sandbox so drafts never hit permission walls; " +
  "guarded keeps the sandbox, blocking edits outside each model's worktree. " +
  "keep full (the default) unless you don't fully trust every panel model.";

export const PANEL_TRUST_OPTIONS: ReadonlyArray<{ value: PanelTrust; label: string; hint: string }> = [
  {
    value: "full",
    label: "full",
    hint: "no sandbox: may run any command and edit any file on this machine (default)"
  },
  {
    value: "guarded",
    label: "guarded",
    hint: "sandboxed: may only edit files inside its own draft worktree"
  }
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
