/**
 * Per-candidate tracing for panel harnesses.
 *
 * Every panel harness — the built-in agent, and the codex/claude/cursor tool
 * harnesses — wraps one candidate run in a `fusion.candidate` span via
 * {@link traceCandidate}. The tracer emits a `fusion.candidate.started`
 * marker immediately (live roster signal), streams each trajectory step as a
 * `fusion.candidate.step` marker, and ends the candidate span with the
 * terminal summary attributes.
 *
 * The tracer's `carrier` parents downstream work (model calls, synthesis
 * HTTP) onto the candidate span and tags it with candidate/trajectory baggage
 * so panel model servers can correlate their own spans.
 *
 * A no-op when the run has no trace carrier, so harnesses call it
 * unconditionally.
 */
import {
  emitFusionEvent,
  jsonAttr,
  startFusionSpan,
  withFusionBaggage
} from "@fusionkit/tracing";
import type { FusionTraceCarrier } from "@fusionkit/tracing";
import { ATTR } from "@fusionkit/protocol";

import type { TrajectoryStep } from "./harness.js";

export type CandidateTraceContext = {
  /** Parent trace carrier (the session/run/turn); tracing is skipped when unset. */
  trace?: FusionTraceCarrier;
  /** User-turn index stamped on the candidate's spans. */
  turn?: number;
};

export type CandidateTraceInput = {
  candidateId: string;
  modelId: string;
  model?: string;
  branchName?: string;
  worktreePath?: string;
};

export type CandidateOutcome = {
  status: string;
  steps: readonly TrajectoryStep[];
  finalOutput?: string;
  toolCallCount?: number;
  finishReason?: string;
  /** A bounded rollout's terminal proposal (the captured k-th batch), if any. */
  proposedCalls?: ReadonlyArray<{ name?: string; arguments_preview: string }>;
};

export type CandidateTracer = {
  /**
   * Carrier parenting onto the candidate span, tagged with candidate and
   * trajectory baggage. Undefined when tracing is off.
   */
  carrier: FusionTraceCarrier | undefined;
  /** Emit one trajectory step as soon as the harness observes it. */
  step(step: TrajectoryStep): void;
  /** Emit any not-yet-emitted steps and end the candidate span. */
  finished(outcome: CandidateOutcome): void;
};

const NOOP_TRACER: CandidateTracer = {
  carrier: undefined,
  step: () => undefined,
  finished: () => undefined
};

export function traceCandidate(ctx: CandidateTraceContext, input: CandidateTraceInput): CandidateTracer {
  if (ctx.trace === undefined) return NOOP_TRACER;
  const identity = {
    [ATTR.FUSION_CANDIDATE_ID]: input.candidateId,
    [ATTR.FUSION_TRAJECTORY_ID]: input.candidateId,
    [ATTR.FUSION_MODEL_ID]: input.modelId,
    [ATTR.GEN_AI_REQUEST_MODEL]: input.model,
    [ATTR.FUSION_TURN]: ctx.turn
  };
  const span = startFusionSpan("panel-model", "fusion.candidate", ctx.trace, {
    ...identity,
    [ATTR.FUSION_BRANCH_NAME]: input.branchName,
    [ATTR.FUSION_WORKTREE_PATH]: input.worktreePath
  });
  const carrier = withFusionBaggage(span.carrier, {
    candidateId: input.candidateId,
    trajectoryId: input.candidateId,
    ...(ctx.turn !== undefined ? { turn: ctx.turn } : {})
  });
  span.event("panel-model", "fusion.candidate.started", {
    ...identity,
    [ATTR.FUSION_BRANCH_NAME]: input.branchName,
    [ATTR.FUSION_WORKTREE_PATH]: input.worktreePath
  });
  const emittedStepIndexes = new Set<number>();

  return {
    carrier,
    step(step: TrajectoryStep): void {
      if (emittedStepIndexes.has(step.index)) return;
      emittedStepIndexes.add(step.index);
      emitFusionEvent("panel-model", "fusion.candidate.step", carrier, {
        ...identity,
        [ATTR.FUSION_STEP]: jsonAttr(step),
        [ATTR.FUSION_STEP_INDEX]: step.index,
        [ATTR.FUSION_STEP_TYPE]: step.type
      });
    },
    finished(outcome: CandidateOutcome): void {
      for (const step of outcome.steps) {
        this.step(step);
      }
      span.end({
        status: outcome.status === "succeeded" ? "succeeded" : outcome.status === "skipped" ? "skipped" : "failed",
        attributes: {
          [ATTR.FUSION_STEP_COUNT]: outcome.steps.length,
          [ATTR.FUSION_TOOL_CALL_COUNT]: outcome.toolCallCount,
          [ATTR.FUSION_FINISH_REASON]: outcome.finishReason,
          [ATTR.FUSION_FINAL_OUTPUT_PREVIEW]:
            outcome.finalOutput !== undefined && outcome.finalOutput.length > 0
              ? outcome.finalOutput.slice(0, 400)
              : undefined,
          [ATTR.FUSION_PROPOSED_CALLS]:
            outcome.proposedCalls !== undefined && outcome.proposedCalls.length > 0
              ? jsonAttr(outcome.proposedCalls)
              : undefined
        }
      });
    }
  };
}
