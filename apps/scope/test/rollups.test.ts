import assert from "node:assert/strict";
import { test } from "node:test";

import { rollupCost, rollupJudge, rollupModels } from "../lib/rollups";
import { deriveSession } from "../lib/sessions";
import type { StoredEvent } from "../lib/types";
import { stored, storedEvents, syntheticSession } from "./fixture";

test("rollupCost sums fusion.cost events per model and stage", () => {
  const events = storedEvents(syntheticSession("11111111111111111111111111110011").events);
  const rollup = rollupCost(events);
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
  const events = storedEvents(syntheticSession("11111111111111111111111111110012").events);
  const base = events.find((event) => event.name === "fusion.cost");
  assert.ok(base);
  const unpriced: StoredEvent = {
    ...base,
    id: 999,
    attributes: {
      "fusion.cost.stage": "panel",
      "fusion.cost.model": "mystery",
      "fusion.cost.unknown": true
    }
  };
  const rollup = rollupCost([...events, unpriced]);
  assert.equal(rollup.entries, 4);
  assert.equal(rollup.unknownEntries, 1);
  assert.ok(Math.abs(rollup.totalUsd - 0.0193) < 1e-9, "unpriced entries add no dollars");
});

test("rollupJudge folds decisions, selections, and model standings", () => {
  const synth = syntheticSession("11111111111111111111111111110013");
  const select = syntheticSession("11111111111111111111111111110014");
  const selectSpans = select.spans.map((span) =>
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

  const rollup = rollupJudge(
    stored([...synth.spans, ...selectSpans]),
    storedEvents([...synth.events, ...select.events])
  );
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
  const session = syntheticSession("11111111111111111111111111110015");
  const events = storedEvents(
    session.events.map((event) =>
      event.name === "fusion.judge.synthesis"
        ? { ...event, attributes: { ...event.attributes, "fusion.synthesis_empty": true } }
        : event
    )
  );
  const rollup = rollupJudge(stored(session.spans), events);
  assert.equal(rollup.emptySynthesisCount, 1);
  assert.equal(rollup.decisions[0].synthesisEmpty, true);
});

test("rollupModels pairs start events with chat spans and reads GenAI usage", () => {
  const session = syntheticSession("11111111111111111111111111110016");
  const models = rollupModels(stored(session.spans), storedEvents(session.events));
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

test("a start event with no chat span counts as a running call", () => {
  const session = syntheticSession("11111111111111111111111111110017");
  const spans = stored(session.spans.filter((span) => !span.name.startsWith("chat")));
  const models = rollupModels(spans, storedEvents(session.events));
  const gpt = models.find((row) => row.modelId === "gpt");
  assert.equal(gpt?.calls, 1);
  assert.equal(gpt?.running, 1);
  assert.equal(gpt?.succeeded, 0);
});

test("deriveSession sums the session's resolved cost", () => {
  const traceId = "11111111111111111111111111110018";
  const session = syntheticSession(traceId);
  const detail = deriveSession(traceId, stored(session.spans), storedEvents(session.events));
  assert.ok(detail.costUsd !== undefined);
  assert.ok(Math.abs(detail.costUsd - 0.0193) < 1e-9);
  assert.equal(detail.costIncomplete, undefined);
});
