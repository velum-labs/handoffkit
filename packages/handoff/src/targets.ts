/**
 * Typed runtime-target descriptors. No magic strings in the hot path:
 * `targets.pool("eng-prod")` instead of `"eng-prod"`.
 */

export type RuntimeTarget = {
  kind: "runtime-target";
  id: string;
  locality: "customer-runner";
  pool: string;
};

export const targets = {
  /** A named runner pool: outbound-only runners enrolled with the plane. */
  pool(name: string): RuntimeTarget {
    if (!name) throw new Error("a pool name is required");
    return {
      kind: "runtime-target",
      id: `pool:${name}`,
      // The only locality this runtime offers: every pool is served by
      // customer-enrolled runners. The field exists on RuntimeTarget so new
      // localities (managed pools) are an additive change for callers.
      locality: "customer-runner",
      pool: name
    };
  }
};
