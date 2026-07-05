import assert from "node:assert/strict";
import { test } from "node:test";

import { rollupCost, rollupJudge } from "../lib/rollups";
import { deriveSession } from "../lib/sessions";
import type { StoredEvent } from "../lib/types";
import { syntheticSession } from "./fixture";

function stored(traceId = "trace_rollup_test"): StoredEvent[] {
  return syntheticSession(traceId).map((event, index) => ({ ...event, id: index + 1 }));
}

test("rollupCost sums cost.metered entries per model and stage", () => {
  const rollup = rollupCost(stored());

  assert.equal(rollup.entries, 3);
  assert.equal(rollup.unknownEntries, 0);
  assert.equal(rollup.sessionsWithCost, 1);
  assert.ok(Math.abs(rollup.totalUsd - 0.0193) < 1e-9);

  const stages = Object.fromEntries(rollup.perStage.map((stage) => [stage.stage, stage]));
  assert.equal(stages.panel.entries, 2);
  assert.equal(stages.judge_synth.entries, 1);

  const judgeRow = rollup.perModel.find((row) => row.stage === "judge_synth");
  assert.ok(judgeRow !== undefined);
  assert.equal(judgeRow.model, "gpt-5.5");
  assert.equal(judgeRow.tokens, 2360, "camelCase cost-meter usage is understood");
});

test("rollupCost counts unpriced entries separately", () => {
  const events = stored();
  const unpriced: StoredEvent = {
    ...events[0],
    id: 999,
    span_id: "span_cost_unknown",
    event_type: "log",
    component: "gateway",
    payload: {
      kind: "cost.metered",
      stage: "panel",
      model: "local:mystery",
      turn_cost_usd: null,
      unknown_cost: true,
      unknown_usage: true
    }
  };
  const rollup = rollupCost([...events, unpriced]);
  assert.equal(rollup.entries, 4);
  assert.equal(rollup.unknownEntries, 1);
  assert.ok(Math.abs(rollup.totalUsd - 0.0193) < 1e-9, "unpriced entries add no dollars");
});

test("rollupJudge tallies decisions and resolves selected models", () => {
  const synth = stored("trace_synth");
  // A second session where the judge selects the opus candidate verbatim.
  const select = stored("trace_select")
    .filter((event) => event.event_type !== "judge.synthesis")
    .map((event, index): StoredEvent => {
      const base = { ...event, id: 100 + index };
      if (event.event_type !== "judge.final") return base;
      return {
        ...base,
        payload: {
          decision: "select_trajectory",
          selected_trajectory_id: "cand_opus",
          rationale: "opus already has the regression test"
        }
      };
    });

  const rollup = rollupJudge([...synth, ...select]);

  assert.equal(rollup.totalDecisions, 2);
  assert.equal(rollup.synthesizeCount, 1);
  assert.equal(rollup.selectCount, 1);
  assert.equal(rollup.emptySynthesisCount, 0);

  const selectRow = rollup.decisions.find((row) => row.traceId === "trace_select");
  assert.ok(selectRow !== undefined);
  assert.equal(selectRow.decision, "select_trajectory");
  assert.equal(selectRow.selectedModelId, "opus", "candidate id resolves to its panel model");

  const standings = Object.fromEntries(rollup.models.map((model) => [model.modelId, model]));
  assert.equal(standings.opus.onPanel, 2);
  assert.equal(standings.opus.selected, 1);
  assert.equal(standings.gpt.onPanel, 2);
  assert.equal(standings.gpt.selected, 0);
});

test("rollupJudge flags empty-synthesis fallbacks", () => {
  const events = stored("trace_empty").map((event): StoredEvent => {
    if (event.event_type !== "judge.synthesis") return event;
    return { ...event, payload: { ...event.payload, empty: true } };
  });
  const rollup = rollupJudge(events);
  assert.equal(rollup.emptySynthesisCount, 1);
  assert.equal(rollup.decisions[0].synthesisEmpty, true);
});

test("deriveSession accumulates session cost from cost.metered logs", () => {
  const detail = deriveSession("trace_cost", stored("trace_cost"));
  assert.ok(detail.costUsd !== undefined);
  assert.ok(Math.abs(detail.costUsd - 0.0193) < 1e-9);
  assert.equal(detail.costIncomplete, undefined);
});
