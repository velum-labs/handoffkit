import assert from "node:assert/strict";
import { test } from "node:test";

import {
  JudgeCompareOperator,
  ModelGenerateOperator,
  PanelGenerateOperator,
  SynthesizeOperator
} from "../fusion-operators.js";
import {
  BudgetExceededError,
  DirectFastPathScheduler,
  FusionRuntime,
  StaticDAGScheduler,
  createArtifact
} from "../runtime.js";
import type { CandidateArtifactValue, ModelClient } from "../fusion-operators.js";
import type { Artifact, TaskSpec } from "../runtime.js";

function taskArtifact(id = "task"): Artifact<TaskSpec> {
  return createArtifact({
    id,
    type: "task",
    value: {
      id,
      prompt: "Explain the kernel.",
      messages: [{ role: "user", content: "Explain the kernel." }]
    },
    visibility: "runtime",
    leakage: "none"
  });
}

test("DirectFastPathScheduler runs exactly one model operator", async () => {
  const calls: string[] = [];
  const client: ModelClient = {
    generate(input) {
      calls.push(input.model);
      return {
        model: input.model,
        content: `direct:${input.prompt}`
      };
    }
  };
  const task = taskArtifact();
  const model = new ModelGenerateOperator({ model: "fast-model", modelId: "fast", client });
  const result = await new FusionRuntime().run({
    runId: "direct_run",
    graph: {
      id: "direct_graph",
      inputArtifactIds: [task.id],
      nodes: [{ id: "model", operator: model, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new DirectFastPathScheduler(),
    artifacts: [task]
  });

  assert.deepEqual(calls, ["fast-model"]);
  assert.equal(result.outcome.schedulerFamily, "direct-fast-path");
  assert.equal(result.outcome.status, "succeeded");
  assert.equal(result.finalArtifacts.length, 1);
  assert.equal(result.finalArtifacts[0]?.type, "candidate");
  assert.equal((result.finalArtifacts[0]?.value as CandidateArtifactValue).content, "direct:Explain the kernel.");
  assert.deepEqual(
    result.trace.filter((event) => event.type === "operator.started").map((event) => event.operatorId),
    [model.spec.id]
  );
});

test("StaticDAGScheduler expresses panel -> judge -> synth", async () => {
  const task = taskArtifact();
  const panel = new PanelGenerateOperator({
    id: "panel",
    models: [
      { id: "alpha", model: "model-alpha" },
      { id: "beta", model: "model-beta" }
    ],
    runner: () => [
      { candidateId: "a", modelId: "alpha", model: "model-alpha", content: "alpha answer" },
      { candidateId: "b", modelId: "beta", model: "model-beta", content: "beta answer" }
    ]
  });
  const judge = new JudgeCompareOperator({
    id: "judge",
    compare: ({ candidates }) => ({
      selectedCandidateId: candidates[1]?.candidateId,
      ranking: candidates.map((candidate, index) => ({
        candidateId: candidate.candidateId,
        score: index === 1 ? 0.9 : 0.4
      })),
      rationale: "beta covers more detail"
    })
  });
  const synth = new SynthesizeOperator({
    id: "synth",
    synthesize: ({ candidates, comparison }) => {
      const selected = candidates.find((candidate) => candidate.candidateId === comparison?.selectedCandidateId);
      return {
        content: `fused:${selected?.content ?? "missing"}`,
        selectedCandidateId: selected?.candidateId,
        rationale: comparison?.rationale
      };
    }
  });

  const result = await new FusionRuntime().run({
    runId: "moa_run",
    graph: {
      id: "moa_graph",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "panel", operator: panel, inputs: [{ artifactId: task.id }] },
        { id: "judge", operator: judge, inputs: [{ artifactId: task.id }, { nodeId: "panel" }] },
        {
          id: "synth",
          operator: synth,
          inputs: [{ artifactId: task.id }, { nodeId: "panel" }, { nodeId: "judge" }]
        }
      ]
    },
    scheduler: new StaticDAGScheduler(),
    artifacts: [task]
  });

  assert.equal(result.finalArtifacts.length, 1);
  assert.equal(result.finalArtifacts[0]?.type, "final_answer");
  assert.equal((result.finalArtifacts[0]?.value as { content: string }).content, "fused:beta answer");
  assert.deepEqual(
    result.trace.filter((event) => event.type === "operator.started").map((event) => event.operatorId),
    ["panel", "judge", "synth"]
  );
});

test("degree-1 mode does not run hidden panel, judge, or synth work", async () => {
  const calls = {
    model: 0,
    panel: 0,
    judge: 0,
    synth: 0
  };
  const task = taskArtifact();
  const model = new ModelGenerateOperator({
    model: "solo",
    client: {
      generate() {
        calls.model += 1;
        return { model: "solo", content: "solo output" };
      }
    }
  });
  new PanelGenerateOperator({
    models: [{ id: "unused", model: "unused" }],
    runner: () => {
      calls.panel += 1;
      return [];
    }
  });
  new JudgeCompareOperator({
    compare: () => {
      calls.judge += 1;
      return {};
    }
  });
  new SynthesizeOperator({
    synthesize: () => {
      calls.synth += 1;
      return { content: "unused" };
    }
  });

  await new FusionRuntime().run({
    graph: {
      id: "degree_one",
      inputArtifactIds: [task.id],
      nodes: [{ id: "model", operator: model, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new DirectFastPathScheduler(),
    artifacts: [task]
  });

  assert.deepEqual(calls, { model: 1, panel: 0, judge: 0, synth: 0 });
});

test("artifact lineage records operator inputs and outputs", async () => {
  const task = taskArtifact();
  const panel = new PanelGenerateOperator({
    id: "panel",
    models: [{ id: "alpha", model: "model-alpha" }],
    runner: () => [{ candidateId: "a", modelId: "alpha", model: "model-alpha", content: "answer" }]
  });
  const judge = new JudgeCompareOperator({
    id: "judge",
    compare: ({ candidates }) => ({ selectedCandidateId: candidates[0]?.candidateId })
  });
  const synth = new SynthesizeOperator({
    id: "synth",
    synthesize: ({ candidates }) => ({ content: candidates[0]?.content ?? "" })
  });

  const result = await new FusionRuntime().run({
    runId: "lineage_run",
    graph: {
      id: "lineage_graph",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "panel", operator: panel, inputs: [{ artifactId: task.id }] },
        { id: "judge", operator: judge, inputs: [{ artifactId: task.id }, { nodeId: "panel" }] },
        { id: "synth", operator: synth, inputs: [{ artifactId: task.id }, { nodeId: "panel" }, { nodeId: "judge" }] }
      ]
    },
    scheduler: new StaticDAGScheduler(),
    artifacts: [task]
  });
  const candidate = result.artifacts.find((artifact) => artifact.type === "candidate");
  const comparison = result.artifacts.find((artifact) => artifact.type === "judge_comparison");
  const final = result.finalArtifacts[0];

  assert.equal(candidate?.provenance.createdByOperatorId, "panel");
  assert.deepEqual(candidate?.provenance.inputArtifactIds, [task.id]);
  assert.ok(comparison?.provenance.inputArtifactIds.includes(candidate?.id ?? ""));
  assert.ok(final?.provenance.inputArtifactIds.includes(comparison?.id ?? ""));
  assert.equal(result.outcome.finalArtifactIds[0], final?.id);
  assert.ok(result.trace.some((event) => event.type === "artifact.created" && event.outputArtifactIds?.includes(final?.id ?? "")));
});

test("budget policy enforces candidate caps before panel fanout", async () => {
  const task = taskArtifact();
  const panel = new PanelGenerateOperator({
    id: "panel",
    models: [
      { id: "alpha", model: "model-alpha" },
      { id: "beta", model: "model-beta" }
    ],
    runner: () => {
      throw new Error("runner should not execute after budget rejection");
    }
  });

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "budget_graph",
          inputArtifactIds: [task.id],
          nodes: [{ id: "panel", operator: panel, inputs: [{ artifactId: task.id }] }]
        },
        scheduler: new StaticDAGScheduler(),
        artifacts: [task],
        budget: { id: "tiny", maxCandidates: 1 }
      }),
    (error) => error instanceof BudgetExceededError && /candidates 2 > 1/.test(error.message)
  );
});
