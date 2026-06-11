/**
 * @warrant/handoff — the continuation-first SDK. Start work wherever it
 * naturally begins, continue it on a governed runner when conditions
 * change, preserve state across the boundary, and prove what moved, why
 * it moved, who approved it, and how to resume.
 *
 * Everything here composes Warrant primitives and nothing else: a
 * continuation is a signed run contract, the moved state is a
 * content-addressed envelope pinned by that contract, and the result is
 * an offline-verifiable receipt.
 */
export { Handoff, handoff } from "./handoff.js";
export type {
  ContinueOptions,
  HandoffConfig,
  HandoffTraceEvent,
  ParallelOptions
} from "./handoff.js";
export { HandoffRun } from "./run.js";
export type { WaitOptions, WaitOutcome } from "./run.js";
export { targets } from "./targets.js";
export type { RuntimeTarget } from "./targets.js";
export { agents, toAgentSpec } from "./agents.js";
export type { AgentDescriptor } from "./agents.js";
export { localFirst, planContinuation } from "./policy.js";
export type {
  ContinuationPolicy,
  LocalFirstOptions,
  PlanInput,
  PlanningDecision
} from "./policy.js";
export { reviewRuns, reviewStrategies } from "./review.js";
export type { ReviewedRun, ReviewResult, ReviewStrategy } from "./review.js";
