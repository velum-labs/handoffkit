import type { CheckpointTier, DisclosureMode } from "@warrant/protocol";

import type { RuntimeTarget } from "./targets.js";
import type { Trigger } from "./triggers.js";

/**
 * Client-side continuation policy. This is the SDK's own fail-closed gate,
 * evaluated before anything moves; the plane's org policy is still
 * evaluated independently at contract time. Both must pass.
 */
export type ContinuationPolicy = {
  kind: "continuation-policy";
  id: "local-first";
  /** Pools work may continue to. Undefined means any pool. */
  allowPools?: string[];
  /** Pools that are always denied, evaluated before the allowlist. */
  denyPools?: string[];
  maxSpendUsd?: number;
  maxDurationMin?: number;
  /** Ceiling for `parallel(...)` fan-out. */
  maxParallelRuns: number;
  disclosure: DisclosureMode;
  /**
   * Conditions under which `h.needs(target)` reports that work should
   * continue. Empty or absent means "needs" reduces to "allowed by policy".
   */
  continueWhen?: Trigger[];
};

export type LocalFirstOptions = {
  allowPools?: string[];
  denyPools?: string[];
  maxSpendUsd?: number;
  maxDurationMin?: number;
  maxParallelRuns?: number;
  disclosure?: DisclosureMode;
  continueWhen?: Trigger[];
};

/**
 * Local-first: work stays local until the app explicitly continues it,
 * and continuation is allowed only within the configured bounds.
 */
export function localFirst(options: LocalFirstOptions = {}): ContinuationPolicy {
  return {
    kind: "continuation-policy",
    id: "local-first",
    ...(options.allowPools ? { allowPools: options.allowPools } : {}),
    ...(options.denyPools ? { denyPools: options.denyPools } : {}),
    ...(options.maxSpendUsd !== undefined
      ? { maxSpendUsd: options.maxSpendUsd }
      : {}),
    ...(options.maxDurationMin !== undefined
      ? { maxDurationMin: options.maxDurationMin }
      : {}),
    // TODO(hardcoded): default maxParallelRuns (4) and disclosure ("minimal-context") are inline policy defaults — document in HandoffConfig or env-driven org presets
    maxParallelRuns: options.maxParallelRuns ?? 4,
    disclosure: options.disclosure ?? "minimal-context",
    ...(options.continueWhen ? { continueWhen: options.continueWhen } : {})
  };
}

/** Deterministic, explainable continuation-planning outcome. */
export type PlanningDecision = {
  decision: "continue" | "deny";
  target: RuntimeTarget;
  tier: CheckpointTier;
  disclosure: DisclosureMode;
  reasons: string[];
};

export type PlanInput = {
  target: RuntimeTarget;
  secrets: string[];
  budget: { maxSpendUsd?: number; maxDurationMin?: number };
  parallelism: number;
};

/**
 * The v1 planner is deterministic policy logic, not a model. Every
 * decision carries human-readable reasons so the trace can explain why
 * the runtime boundary changed (or refused to).
 */
export function planContinuation(
  policy: ContinuationPolicy,
  input: PlanInput
): PlanningDecision {
  const denials: string[] = [];
  const pool = input.target.pool;

  if (policy.denyPools?.includes(pool)) {
    denials.push(`pool "${pool}" is denied by continuation policy`);
  }
  if (policy.allowPools && !policy.allowPools.includes(pool)) {
    denials.push(`pool "${pool}" is not in the continuation allowlist`);
  }
  // TODO(brittle): omitted budget fields coerce to 0 and pass ceiling checks — callers can omit maxSpendUsd/maxDurationMin and still get "continue" without explicit budget intent
  if (
    policy.maxSpendUsd !== undefined &&
    (input.budget.maxSpendUsd ?? 0) > policy.maxSpendUsd
  ) {
    denials.push(
      `requested budget $${input.budget.maxSpendUsd} exceeds policy ceiling $${policy.maxSpendUsd}`
    );
  }
  if (
    policy.maxDurationMin !== undefined &&
    (input.budget.maxDurationMin ?? 0) > policy.maxDurationMin
  ) {
    denials.push(
      `requested duration ${input.budget.maxDurationMin}m exceeds policy ceiling ${policy.maxDurationMin}m`
    );
  }
  if (input.parallelism > policy.maxParallelRuns) {
    denials.push(
      `requested ${input.parallelism} parallel runs exceeds policy ceiling ${policy.maxParallelRuns}`
    );
  }

  if (denials.length > 0) {
    return {
      decision: "deny",
      target: input.target,
      tier: "workspace",
      disclosure: policy.disclosure,
      reasons: denials
    };
  }
  return {
    decision: "continue",
    target: input.target,
    tier: "workspace",
    disclosure: policy.disclosure,
    reasons: [
      `pool "${pool}" is allowed`,
      `disclosure mode "${policy.disclosure}"`,
      input.secrets.length > 0
        ? `secret release requested: ${input.secrets.join(", ")} (subject to org policy)`
        : "no secrets requested"
    ]
  };
}
