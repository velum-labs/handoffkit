/**
 * @fusionkit/handoff is the continuation-first SDK.
 *
 * Start work wherever it naturally begins, continue it on a governed runner
 * when conditions change, preserve state across the boundary, and prove what
 * moved, why it moved, who approved it, and how to resume.
 *
 * Everything here composes FusionKit governance primitives. A continuation is a
 * signed run contract, the moved state is a content-addressed envelope pinned
 * by that contract, and the result is an offline-verifiable receipt.
 */
export { defineHandoffConfig, Handoff, handoff } from "./handoff.js";
export type {
  ContinueOptions,
  HandoffConfig,
  HandoffInit,
  HandoffStreamEvent,
  HandoffSummary,
  HandoffTraceEvent,
  ModelDecision,
  ParallelOptions
} from "./handoff.js";
export { HandoffRun } from "./run.js";
export type { WaitOptions, WaitOutcome } from "./run.js";
export {
  createCommandContext,
  executeGovernedCommand,
  toGovernedRunRecord
} from "./run-executor.js";
export type {
  CommandHarnessConfig,
  GovernedCommandOptions,
  GovernedCommandResult,
  GovernedRunRecord
} from "./run-executor.js";
export { targets } from "./targets.js";
export type { RuntimeTarget } from "./targets.js";
export { agents } from "./agents.js";
export { localFirst } from "./policy.js";
export type { ContinuationPolicy, LocalFirstOptions } from "./policy.js";
export { triggers } from "./triggers.js";
export type { FiredTrigger, Trigger } from "./triggers.js";
export { branch } from "./isolation.js";
export type { IsolationStrategy } from "./isolation.js";
export { reviewStrategies, scorecardFor } from "./review.js";
export type {
  ReviewedRun,
  ReviewResult,
  ReviewStrategy,
  Scorecard
} from "./review.js";
export type { ToolCallObservation, ToolLike } from "./tools.js";
export { remoteTools } from "./remote-tools.js";
export type {
  RemoteToolCallRecord,
  RemoteTools,
  RemoteToolsConfig,
  RemoteToolsContextConfig
} from "./remote-tools.js";
export { swarmTools } from "./swarm-tools.js";
export type {
  DispatchInput,
  DispatchOutput,
  EscalateInput,
  EscalateOutput,
  PullInput,
  PullOutput,
  StatusInput,
  StatusOutput,
  SwarmPlane,
  SwarmRunRecord,
  SwarmTools,
  SwarmToolsConfig,
  SwarmToolsContextConfig,
  SwarmToolSet,
  WorkerTaskInput
} from "./swarm-tools.js";
export { handoffModel, withModel } from "./model.js";
export type { EscalationReason, HandoffModelConfig } from "./model.js";
export { loadRouterCard, routedModel, withRoutedModel } from "./routed-model.js";
export type { RouteDecision, RoutedModelConfig, RouterCard } from "./routed-model.js";
