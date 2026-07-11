/**
 * The k algebra: `k` is the number of step boundaries a panel member crosses
 * per fused turn, where a step is one model generation terminated by its
 * tool-call batch (conservatively a side effect — tool semantics are unknown)
 * or a final answer.
 *
 *  - k = 1  (proposal mode): members are single stateless completions over the
 *    caller's exact messages+tools; their tool calls are proposals. Nothing is
 *    executed on a member's behalf, so no harness/isolation exists.
 *  - 1 < k < ∞ (bounded lookahead): a managed harness executes batches 1..k-1
 *    privately (worktree simulation) and captures the k-th unexecuted as the
 *    member's terminal proposal.
 *  - k = ∞ / undefined: unbounded rollout, aggregate at final answers only
 *    (the pre-k behavior, bit-for-bit).
 *
 * Any finite k fuses in "step" mode (candidates end in a committable
 * proposal); undefined fuses in "trajectory" mode. These helpers are the only
 * place that encodes those comparisons — never compare `k` inline.
 */

export type PanelMode = "step" | "trajectory";

/** Proposal mode: members never reach a harness (k = 1). */
export function isProposalK(k: number | undefined): boolean {
  return k === 1;
}

/** Any finite k: per-round candidates, step-mode fusion (k = 1 included). */
export function isFiniteK(k: number | undefined): k is number {
  return k !== undefined;
}

/** Bounded lookahead: a managed harness must stop at a step boundary (1 < k < ∞). */
export function isLookaheadK(k: number | undefined): k is number {
  return k !== undefined && k > 1;
}

/** The fuse-step judging mode for a k value (see the module doc). */
export function panelModeForK(k: number | undefined): PanelMode {
  return isFiniteK(k) ? "step" : "trajectory";
}
