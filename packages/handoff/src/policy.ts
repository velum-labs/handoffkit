import type { CheckpointTier, DisclosureMode } from "@warrant/protocol";

import type { RuntimeTarget } from "./targets.js";

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
};

export type LocalFirstOptions = {
  allowPools?: string[];
  denyPools?: string[];
  maxSpendUsd?: number;
  maxDurationMin?: number;
  maxParallelRuns?: number;
  disclosure?: DisclosureMode;
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
    maxParallelRuns: options.maxParallelRuns ?? 4,
    disclosure: options.disclosure ?? "minimal-context"
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
