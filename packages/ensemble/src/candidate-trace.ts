/**
 * Per-candidate trace emission for panel harnesses.
 *
 * The companion app builds its candidate-trajectory view from per-candidate
 * trace events (`harness.candidate.started` → `trajectory.step`* →
 * `harness.candidate.finished`), keyed by `candidate_id` under the session
 * `traceId`. The `agent` harness emits these inline as it runs; the tool
 * harnesses (codex/claude/cursor) reconstruct a trajectory from their CLI and
 * call {@link traceCandidate} so they surface the same way — live, per candidate
 * (started when the candidate begins, finished when it completes), rather than
 * a post-hoc batch after the whole panel settles.
 *
 * A no-op when tracing is disabled or no `traceId` is set, so harnesses can call
 * it unconditionally.
 */
import { emitTrace, getTraceEmitter, newSpanId } from "@fusionkit/protocol";

import type { TrajectoryStep } from "./harness.js";

export type CandidateTraceContext = {
  /** Session correlation id; emission is skipped when unset. */
  traceId?: string;
  /** Session root span the candidate span parents under. */
  parentSpanId?: string;
  /** User-turn index stamped on the events. */
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
};

export type CandidateTracer = {
  /** Emit one trajectory step as soon as the harness observes it. */
  step(step: TrajectoryStep): void;
  /** Emit any not-yet-emitted reconstructed steps and the terminal `harness.candidate.finished`. */
  finished(outcome: CandidateOutcome): void;
};

const NOOP_TRACER: CandidateTracer = { step: () => undefined, finished: () => undefined };

/**
 * Emit `harness.candidate.started` for a panel candidate and return a tracer
 * whose `finished()` emits the candidate's `trajectory.step`s and
 * `harness.candidate.finished`. Call at the start of the candidate's run and
 * again when it completes.
 */
export function traceCandidate(ctx: CandidateTraceContext, input: CandidateTraceInput): CandidateTracer {
  const traceId = ctx.traceId;
  if (traceId === undefined || !getTraceEmitter().isEnabled()) return NOOP_TRACER;
  const candidateSpan = newSpanId();
  const parentSpan = ctx.parentSpanId;
  const emittedStepIndexes = new Set<number>();

  emitTrace({
    component: "panel-model",
    event_type: "harness.candidate.started",
    traceId,
    spanId: candidateSpan,
    ...(parentSpan !== undefined ? { parentSpanId: parentSpan } : {}),
    candidateId: input.candidateId,
    modelId: input.modelId,
    payload: {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(ctx.turn !== undefined ? { turn: ctx.turn } : {}),
      ...(input.branchName !== undefined ? { branch_name: input.branchName } : {}),
      ...(input.worktreePath !== undefined ? { worktree_path: input.worktreePath } : {})
    }
  });

  return {
    step(step: TrajectoryStep): void {
      if (emittedStepIndexes.has(step.index)) return;
      emittedStepIndexes.add(step.index);
      emitTrace({
        component: "panel-model",
        event_type: "trajectory.step",
        traceId,
        spanId: candidateSpan,
        parentSpanId: candidateSpan,
        candidateId: input.candidateId,
        modelId: input.modelId,
        payload: { step }
      });
    },
    finished(outcome: CandidateOutcome): void {
      for (const step of outcome.steps) {
        this.step(step);
      }
      emitTrace({
        component: "panel-model",
        event_type: "harness.candidate.finished",
        traceId,
        spanId: candidateSpan,
        ...(parentSpan !== undefined ? { parentSpanId: parentSpan } : {}),
        candidateId: input.candidateId,
        modelId: input.modelId,
        payload: {
          status: outcome.status,
          ...(ctx.turn !== undefined ? { turn: ctx.turn } : {}),
          step_count: outcome.steps.length,
          ...(outcome.toolCallCount !== undefined ? { tool_call_count: outcome.toolCallCount } : {}),
          ...(outcome.finishReason !== undefined ? { finish_reason: outcome.finishReason } : {}),
          ...(outcome.finalOutput !== undefined && outcome.finalOutput.length > 0
            ? { final_output_preview: outcome.finalOutput.slice(0, 400) }
            : {})
        }
      });
    }
  };
}
