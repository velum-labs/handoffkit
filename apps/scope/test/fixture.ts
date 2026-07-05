import type { FusionTraceEvent } from "../lib/types";

/**
 * A synthetic but realistic full fusion session: environment snapshot, two
 * panel candidates with stepped trajectories, paired model calls, and the
 * judge's thinking -> scored -> synthesis -> final flow. Used by the unit,
 * collector, and API round-trip tests, and by scripts/seed.ts for demo data.
 *
 * Component values mirror the production emitters (packages/ensemble emits
 * harness + trajectory events as "panel-model"), so seeded timelines get the
 * same legend and colors as real runs.
 */
export function syntheticSession(traceId = "trace_test_0001"): FusionTraceEvent[] {
  const base = 1_750_000_000_000;
  let seq = 0;
  const ev = (partial: Omit<FusionTraceEvent, "schema" | "trace_id" | "seq">): FusionTraceEvent => ({
    schema: "fusion-trace-event.v1",
    trace_id: traceId,
    seq: seq++,
    ...partial
  });

  return [
    ev({
      span_id: "span_root",
      ts: base,
      component: "gateway",
      event_type: "session.started",
      payload: {
        dialect: "codex",
        prompt_preview: "Fix the add() sign bug so npm test passes.",
        environment: {
          repo: "/tmp/fusion-sample",
          fusion_backend_url: "http://127.0.0.1:8920",
          harnesses: ["agent"],
          judge_model: "gpt-5.5",
          models: [
            { id: "gpt", model: "openai:gpt-5.5", provider: "openai" },
            { id: "opus", model: "anthropic:claude-opus-4-8", provider: "anthropic" }
          ],
          model_endpoints: { gpt: "http://127.0.0.1:8921", opus: "http://127.0.0.1:8922" }
        }
      }
    }),
    ev({
      span_id: "span_cand_gpt",
      parent_span_id: "span_root",
      ts: base + 100,
      component: "panel-model",
      event_type: "harness.candidate.started",
      candidate_id: "cand_gpt",
      model_id: "gpt",
      payload: { model: "openai:gpt-5.5", branch_name: "fusion/gpt", worktree_path: "/tmp/wt/gpt" }
    }),
    ev({
      span_id: "span_call_gpt",
      parent_span_id: "span_cand_gpt",
      ts: base + 150,
      component: "panel-model",
      event_type: "model.call.started",
      candidate_id: "cand_gpt",
      model_id: "gpt",
      payload: { provider: "openai", model: "gpt-5.5" }
    }),
    ev({
      span_id: "span_step_gpt_0",
      parent_span_id: "span_cand_gpt",
      ts: base + 200,
      component: "panel-model",
      event_type: "trajectory.step",
      candidate_id: "cand_gpt",
      model_id: "gpt",
      payload: { step: { index: 0, type: "reasoning", text: "The add() helper subtracts; flip the operator." } }
    }),
    ev({
      span_id: "span_step_gpt_1",
      parent_span_id: "span_cand_gpt",
      ts: base + 300,
      component: "panel-model",
      event_type: "trajectory.step",
      candidate_id: "cand_gpt",
      model_id: "gpt",
      payload: {
        step: { index: 1, type: "tool_call", tool_name: "apply_patch", tool_input: "- left - right\n+ left + right" }
      }
    }),
    ev({
      span_id: "span_step_gpt_2",
      parent_span_id: "span_cand_gpt",
      ts: base + 400,
      component: "panel-model",
      event_type: "trajectory.step",
      candidate_id: "cand_gpt",
      model_id: "gpt",
      payload: { step: { index: 2, type: "observation", text: "npm test: 1 passing" } }
    }),
    ev({
      span_id: "span_call_gpt",
      parent_span_id: "span_cand_gpt",
      ts: base + 500,
      component: "panel-model",
      event_type: "model.call.finished",
      candidate_id: "cand_gpt",
      model_id: "gpt",
      payload: {
        provider: "openai",
        model: "gpt-5.5",
        latency_s: 0.35,
        finish_reason: "stop",
        usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 },
        content_preview: "Patched add()."
      }
    }),
    ev({
      span_id: "span_cand_gpt",
      parent_span_id: "span_root",
      ts: base + 550,
      component: "panel-model",
      event_type: "harness.candidate.finished",
      candidate_id: "cand_gpt",
      model_id: "gpt",
      payload: {
        status: "succeeded",
        tool_call_count: 1,
        finish_reason: "stop",
        verification_status: "passed",
        final_output_preview: "add() now returns left + right."
      }
    }),
    ev({
      span_id: "span_cand_opus",
      parent_span_id: "span_root",
      ts: base + 120,
      component: "panel-model",
      event_type: "harness.candidate.started",
      candidate_id: "cand_opus",
      model_id: "opus",
      payload: { model: "anthropic:claude-opus-4-8", branch_name: "fusion/opus" }
    }),
    ev({
      span_id: "span_step_opus_0",
      parent_span_id: "span_cand_opus",
      ts: base + 260,
      component: "panel-model",
      event_type: "trajectory.step",
      candidate_id: "cand_opus",
      model_id: "opus",
      payload: { step: { index: 0, type: "reasoning", text: "Fix operator and add a regression test." } }
    }),
    ev({
      span_id: "span_step_opus_1",
      parent_span_id: "span_cand_opus",
      ts: base + 360,
      component: "panel-model",
      event_type: "trajectory.step",
      candidate_id: "cand_opus",
      model_id: "opus",
      payload: { step: { index: 1, type: "output", text: "Added calculator.regression.test.js" } }
    }),
    ev({
      span_id: "span_cand_opus",
      parent_span_id: "span_root",
      ts: base + 600,
      component: "panel-model",
      event_type: "harness.candidate.finished",
      candidate_id: "cand_opus",
      model_id: "opus",
      payload: { status: "succeeded", tool_call_count: 2, verification_status: "passed" }
    }),
    ev({
      span_id: "span_judge",
      parent_span_id: "span_root",
      ts: base + 700,
      component: "judge",
      event_type: "judge.thinking",
      model_id: "judge:gpt-5.5",
      payload: {
        fusion_unit: "trajectory",
        raw_analysis: "Both candidates fix the sign bug. Opus adds a regression test.",
        usage: { total_tokens: 540 }
      }
    }),
    ev({
      span_id: "span_judge",
      parent_span_id: "span_root",
      ts: base + 800,
      component: "judge",
      event_type: "judge.scored",
      model_id: "judge:gpt-5.5",
      payload: {
        fusion_unit: "trajectory",
        analysis: {
          consensus: ["both candidates fix the add() sign bug"],
          contradictions: [],
          unique_insights: ["opus adds a regression test"],
          coverage_gaps: [],
          likely_errors: []
        },
        metrics: {
          candidate_ranks: [
            { candidate_id: "cand_opus", rank: 1, score: 0.92 },
            { candidate_id: "cand_gpt", rank: 2, score: 0.88 }
          ]
        },
        input_ids: ["cand_gpt", "cand_opus"]
      }
    }),
    ev({
      span_id: "span_judge",
      parent_span_id: "span_root",
      ts: base + 900,
      component: "judge",
      event_type: "judge.synthesis",
      model_id: "judge:gpt-5.5",
      payload: { raw_output: "Combine the operator fix with the regression test.", empty: false, usage: { total_tokens: 310 } }
    }),
    ev({
      span_id: "span_judge",
      parent_span_id: "span_root",
      ts: base + 1000,
      component: "judge",
      event_type: "judge.final",
      model_id: "judge:gpt-5.5",
      payload: {
        synthesis_id: "synth_001",
        decision: "synthesize",
        rationale: "Operator fix plus a regression test is the most complete solution.",
        final_output: "export const add = (left, right) => left + right;",
        record: { synthesis_id: "synth_001", final_output: "export const add = (left, right) => left + right;" }
      }
    }),
    ev({
      span_id: "span_root",
      ts: base + 1100,
      component: "gateway",
      event_type: "session.finished",
      payload: {
        status: "succeeded",
        evidence: ["npm test passed on fused output"],
        final_output_preview: "export const add = (left, right) => left + right;"
      }
    })
  ];
}
