import assert from "node:assert/strict";
import { test } from "node:test";

import { rollupCost, rollupJudge, rollupModels } from "../lib/rollups";
import { deriveSession } from "../lib/sessions";
import type { StoredSpan } from "../lib/types";
import { stored, syntheticSession } from "./fixture";

test("rollupCost sums fusion.cost markers per model and stage", () => {
  const spans = stored(syntheticSession("11111111111111111111111111110011"));
  const rollup = rollupCost(spans);
  assert.equal(rollup.entries, 3);
  assert.equal(rollup.unknownEntries, 0);
  assert.equal(rollup.sessionsWithCost, 1);
  assert.ok(Math.abs(rollup.totalUsd - 0.0193) < 1e-9);

  const stages = Object.fromEntries(rollup.perStage.map((row) => [row.stage, row]));
  assert.equal(stages.panel.entries, 2);
  assert.equal(stages.judge_synth.entries, 1);

  const judgeRow = rollup.perModel.find((row) => row.stage === "judge_synth");
  assert.ok(judgeRow !== undefined);
  assert.equal(judgeRow.model, "gpt-5.5");
  assert.equal(judgeRow.tokens, 2360, "GenAI token attributes feed the spend table");
});

test("rollupCost counts unpriced entries without adding dollars", () => {
  const spans = stored(syntheticSession("11111111111111111111111111110012"));
  const base = spans.find((span) => span.name === "fusion.cost");
  assert.ok(base);
  const unpriced: StoredSpan = {
    ...base,
    id: 999,
    span_id: "eeeeeeeeeeeeee99",
    attributes: {
      "fusion.cost.stage": "panel",
      "fusion.cost.model": "mystery",
      "fusion.cost.unknown": true
    }
  };
  const rollup = rollupCost([...spans, unpriced]);
  assert.equal(rollup.entries, 4);
  assert.equal(rollup.unknownEntries, 1);
  assert.ok(Math.abs(rollup.totalUsd - 0.0193) < 1e-9, "unpriced entries add no dollars");
});

test("rollupJudge folds decisions, selections, and model standings", () => {
  const synth = stored(syntheticSession("11111111111111111111111111110013"));
  const select = stored(syntheticSession("11111111111111111111111111110014")).map(
    (span): StoredSpan =>
      span.name === "fusion.judge"
        ? {
            ...span,
            attributes: {
              ...span.attributes,
              "fusion.decision": "select_trajectory",
              "fusion.selected.trajectory_id": "cand_opus"
            }
          }
        : span
  );

  const rollup = rollupJudge([...synth, ...select]);
  assert.equal(rollup.totalDecisions, 2);
  assert.equal(rollup.synthesizeCount, 1);
  assert.equal(rollup.selectCount, 1);
  assert.equal(rollup.emptySynthesisCount, 0);

  const selectRow = rollup.decisions.find(
    (row) => row.traceId === "11111111111111111111111111110014"
  );
  assert.ok(selectRow !== undefined);
  assert.equal(selectRow.decision, "select_trajectory");
  assert.equal(selectRow.selectedModelId, "opus", "candidate id resolves to its panel model");

  const standings = Object.fromEntries(rollup.models.map((row) => [row.modelId, row]));
  assert.equal(standings.opus.onPanel, 2);
  assert.equal(standings.opus.selected, 1);
  assert.equal(standings.gpt.onPanel, 2);
  assert.equal(standings.gpt.selected, 0);
});

test("rollupJudge flags empty synthesis", () => {
  const spans = stored(syntheticSession("11111111111111111111111111110015")).map(
    (span): StoredSpan =>
      span.name === "fusion.judge.synthesis"
        ? { ...span, attributes: { ...span.attributes, "fusion.synthesis_empty": true } }
        : span
  );
  const rollup = rollupJudge(spans);
  assert.equal(rollup.emptySynthesisCount, 1);
  assert.equal(rollup.decisions[0].synthesisEmpty, true);
});

test("rollupModels pairs start markers with chat spans and reads GenAI usage", () => {
  const spans = stored(syntheticSession("11111111111111111111111111110016"));
  const models = rollupModels(spans);
  const gpt = models.find((row) => row.modelId === "gpt");
  assert.ok(gpt);
  assert.equal(gpt.calls, 1);
  assert.equal(gpt.succeeded, 1);
  assert.equal(gpt.running, 0);
  assert.equal(gpt.totalTokens, 920);
  assert.equal(gpt.promptTokens, 800);
  assert.equal(gpt.completionTokens, 120);
  assert.equal(gpt.provider, "openai");
  assert.ok((gpt.avgLatencyS ?? 0) > 0, "latency comes from the span duration");
});

test("a start marker with no chat span counts as a running call", () => {
  const spans = stored(
    syntheticSession("11111111111111111111111111110017").filter((span) => !span.name.startsWith("chat"))
  );
  const models = rollupModels(spans);
  const gpt = models.find((row) => row.modelId === "gpt");
  assert.equal(gpt?.calls, 1);
  assert.equal(gpt?.running, 1);
  assert.equal(gpt?.succeeded, 0);
});

test("deriveSession sums the session's resolved cost", () => {
  const traceId = "11111111111111111111111111110018";
  const detail = deriveSession(traceId, stored(syntheticSession(traceId)));
  assert.ok(detail.costUsd !== undefined);
  assert.ok(Math.abs(detail.costUsd - 0.0193) < 1e-9);
  assert.equal(detail.costIncomplete, undefined);
});
