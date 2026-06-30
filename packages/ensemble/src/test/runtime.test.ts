import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ArchitectureEvaluateOperator,
  DelegateOperator,
  EvidenceSourceOperator,
  GenFuserOperator,
  OfflineModelMergeOperator,
  PairRankOperator,
  RepairOperator,
  RouteOperator,
  SchemaValidationOperator,
  SelectOperator
} from "../advanced-operators.js";
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
  RuntimeCancelledError,
  RuntimeExecutionError,
  StaticDAGScheduler,
  createRuntimeReplayRecord,
  createArtifact
} from "../runtime.js";
import {
  getWorkflow,
  graph,
  refs,
} from "../kernel.js";
import { registerBuiltInWorkflows } from "../workflows.js";
import { createTaskArtifact, defineOperator } from "../kernel-helpers.js";
import {
  AdaptiveRouterScheduler,
  AgenticDelegationScheduler,
  ExecutionSelectRepairScheduler,
  LearnedWorkflowScheduler,
  OfflineArchitectureSearchScheduler,
  RankFuseScheduler
} from "../schedulers.js";
import type { CandidateArtifactValue, ModelClient } from "../fusion-operators.js";
import type { Artifact, Operator, Scheduler, TaskSpec } from "../runtime.js";

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
    (error) =>
      error instanceof RuntimeExecutionError &&
      error.cause instanceof BudgetExceededError &&
      /candidates 2 > 1/.test(error.message)
  );
});

test("artifacts are deeply immutable", () => {
  const artifact = createArtifact({
    id: "immutable",
    type: "nested",
    value: { nested: { count: 1 }, list: ["a"] },
    visibility: "runtime",
    leakage: "none"
  });

  assert.throws(() => {
    artifact.value.nested.count = 2;
  }, TypeError);
  assert.throws(() => {
    artifact.value.list.push("b");
  }, TypeError);
});

test("operators can consume actual budget and fail before emitting output", async () => {
  const task = taskArtifact();
  const metered: Operator = {
    spec: {
      id: "metered",
      kind: "metered",
      inputTypes: ["task"],
      outputTypes: ["final_answer"],
      sideEffects: "none"
    },
    run(_inputs, ctx) {
      ctx.consumeBudget({ inputTokens: 10, outputTokens: 3, usd: 0.02 });
      return [
        ctx.createArtifact({
          type: "final_answer",
          value: { content: "too late" }
        })
      ];
    }
  };

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "actual_budget",
          inputArtifactIds: [task.id],
          nodes: [{ id: "metered", operator: metered, inputs: [{ artifactId: task.id }] }]
        },
        scheduler: new StaticDAGScheduler(),
        artifacts: [task],
        budget: { id: "tokens", maxInputTokens: 5 }
      }),
    (error) =>
      error instanceof RuntimeExecutionError &&
      error.cause instanceof BudgetExceededError &&
      /input tokens 10 > 5/.test(error.message)
  );
});

test("private observations and signals are recorded but hidden from scheduler state", async () => {
  const task = taskArtifact();
  const observedSignalIds: string[][] = [];
  const observedStateSignals: string[][] = [];
  const evidenceOperator: Operator = {
    spec: {
      id: "evidence",
      kind: "evidence",
      inputTypes: ["task"],
      outputTypes: ["final_answer"],
      sideEffects: "none"
    },
    run(inputs, ctx) {
      const targetArtifactId = inputs[0]?.id ?? task.id;
      const publicObservation = ctx.recordObservation({
        sourceId: "public-tests",
        targetArtifactId,
        type: "test_log",
        value: { passed: true },
        leakage: "public"
      });
      const privateObservation = ctx.recordObservation({
        sourceId: "private-grade",
        targetArtifactId,
        type: "private_grade",
        value: { passed: false },
        leakage: "private",
        visibility: "private_eval"
      });
      ctx.recordSignal({
        targetArtifactId,
        dimension: "correctness",
        score: 0.8,
        confidence: 0.7,
        calibration: "empirical",
        leakageRisk: "public",
        observationIds: [publicObservation.id]
      });
      ctx.recordSignal({
        targetArtifactId,
        dimension: "correctness",
        score: 0,
        confidence: 1,
        calibration: "ground_truth",
        leakageRisk: "private",
        observationIds: [privateObservation.id]
      });
      return [
        ctx.createArtifact({
          type: "final_answer",
          value: { content: "answer" }
        })
      ];
    }
  };
  const scheduler: Scheduler = {
    id: "observing-scheduler",
    family: "test",
    async schedule(graph, ctx) {
      const node = graph.nodes[0];
      assert.ok(node !== undefined);
      await ctx.runNode(node);
      observedSignalIds.push([...ctx.signalIds()]);
      observedStateSignals.push(ctx.state().signalIds);
      return { finalArtifactIds: [...ctx.nodeOutputIds(node.id)] };
    }
  };

  const result = await new FusionRuntime().run({
    graph: {
      id: "evidence_graph",
      inputArtifactIds: [task.id],
      nodes: [{ id: "evidence", operator: evidenceOperator, inputs: [{ artifactId: task.id }] }]
    },
    scheduler,
    artifacts: [task]
  });

  assert.equal(result.observations.length, 2);
  assert.equal(result.signals.length, 2);
  assert.equal(result.outcome.observationIds.length, 1);
  assert.equal(result.outcome.signalIds.length, 1);
  assert.equal(result.outcome.privateObservationIds.length, 1);
  assert.equal(result.outcome.privateSignalIds.length, 1);
  assert.deepEqual(observedSignalIds, [result.outcome.signalIds]);
  assert.deepEqual(observedStateSignals, [result.outcome.signalIds]);
});

test("private evaluation artifacts cannot enter runtime operator inputs by default", async () => {
  const privateGrade = createArtifact({
    id: "private-grade",
    type: "private_grade",
    value: { pass: true },
    visibility: "private_eval",
    leakage: "private"
  });
  const operator: Operator = {
    spec: {
      id: "reader",
      kind: "reader",
      inputTypes: ["private_grade"],
      outputTypes: ["final_answer"],
      sideEffects: "none"
    },
    run(_inputs, ctx) {
      return [ctx.createArtifact({ type: "final_answer", value: { content: "leaked" } })];
    }
  };

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "private_input",
          inputArtifactIds: [privateGrade.id],
          nodes: [{ id: "reader", operator, inputs: [{ artifactId: privateGrade.id }] }]
        },
        scheduler: new StaticDAGScheduler(),
        artifacts: [privateGrade]
      }),
    /cannot consume private\/contaminated artifact/
  );
});

test("workspace writer budget enforces single-writer discipline", async () => {
  const task = taskArtifact();
  const writer = (id: string): Operator => ({
    spec: {
      id,
      kind: "writer",
      inputTypes: ["task"],
      outputTypes: ["final_answer"],
      sideEffects: "write_workspace"
    },
    run(_inputs, ctx) {
      return [ctx.createArtifact({ type: "final_answer", value: { content: id } })];
    }
  });

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "single_writer",
          inputArtifactIds: [task.id],
          nodes: [
            { id: "writer_a", operator: writer("writer_a"), inputs: [{ artifactId: task.id }] },
            { id: "writer_b", operator: writer("writer_b"), inputs: [{ artifactId: task.id }] }
          ]
        },
        scheduler: new StaticDAGScheduler(),
        artifacts: [task],
        budget: { id: "single-writer", maxWorkspaceWriters: 1 }
      }),
    (error) =>
      error instanceof RuntimeExecutionError &&
      error.cause instanceof BudgetExceededError &&
      /workspace writers 2 > 1/.test(error.message)
  );
});

test("runtime retries retryable operators and exports replay records", async () => {
  const task = taskArtifact();
  let attempts = 0;
  const flaky: Operator = {
    spec: {
      id: "flaky",
      kind: "flaky",
      inputTypes: ["task"],
      outputTypes: ["final_answer"],
      sideEffects: "none",
      retry: { maxAttempts: 2, retryableErrors: ["transient"] }
    },
    run(_inputs, ctx) {
      attempts += 1;
      if (attempts === 1) throw new Error("transient provider failure");
      return [ctx.createArtifact({ type: "final_answer", value: { content: "ok" } })];
    }
  };

  const result = await new FusionRuntime().run({
    runId: "retry_run",
    graph: {
      id: "retry_graph",
      inputArtifactIds: [task.id],
      nodes: [{ id: "flaky", operator: flaky, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new StaticDAGScheduler(),
    artifacts: [task]
  });
  const replay = createRuntimeReplayRecord(result);

  assert.equal(attempts, 2);
  assert.ok(result.trace.some((event) => event.type === "operator.retry"));
  assert.equal(replay.schema, "fusion-runtime-replay.v1");
  assert.equal(replay.outcome.runId, "retry_run");
});

test("runtime cancellation marks cancelled status", async () => {
  const task = taskArtifact();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "cancel_graph",
          inputArtifactIds: [task.id],
          nodes: [
            {
              id: "noop",
              operator: {
                spec: {
                  id: "noop",
                  kind: "noop",
                  inputTypes: ["task"],
                  outputTypes: ["final_answer"],
                  sideEffects: "none"
                },
                run(_inputs, ctx) {
                  return [ctx.createArtifact({ type: "final_answer", value: { content: "no" } })];
                }
              },
              inputs: [{ artifactId: task.id }]
            }
          ]
        },
        scheduler: new StaticDAGScheduler(),
        artifacts: [task],
        signal: controller.signal
      }),
    (error) =>
      error instanceof RuntimeExecutionError &&
      error.cause instanceof RuntimeCancelledError &&
      error.outcome.status === "cancelled"
  );
});

test("failureMode return exposes failed outcomes without throwing", async () => {
  const task = taskArtifact();
  const failing = defineOperator(
    {
      id: "fail",
      kind: "fail",
      requiredInputTypes: ["task"],
      outputTypes: ["final_answer"],
      sideEffects: "none"
    },
    () => {
      throw new Error("boom");
    }
  );

  const result = await new FusionRuntime().run({
    graph: {
      id: "failure_return",
      inputArtifactIds: [task.id],
      nodes: [{ id: "fail", operator: failing, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new StaticDAGScheduler(),
    artifacts: [task],
    failureMode: "return"
  });

  assert.equal(result.outcome.status, "failed");
  assert.match(result.outcome.error ?? "", /boom/);
});

test("graph builder and built-in workflow registry compose direct kernels", async () => {
  registerBuiltInWorkflows();
  const task = createTaskArtifact({ id: "builder-task", prompt: "hello" });
  const op = new ModelGenerateOperator({
    id: "builder-model",
    model: "builder",
    client: {
      generate: () => ({ model: "builder", content: "built" })
    }
  });
  const workflow = graph("builder-direct")
    .task(task)
    .node("model", op, { inputs: [refs.artifact(task.id)] })
    .scheduler(new DirectFastPathScheduler())
    .compile();
  const direct = getWorkflow("direct");
  assert.ok(direct !== undefined);

  const result = await workflow.run();
  assert.equal((result.finalArtifacts[0]?.value as CandidateArtifactValue).content, "built");
});

test("rank-fuse scheduler supports PairRank -> Select -> GenFuser", async () => {
  const task = taskArtifact();
  const panel = new PanelGenerateOperator({
    id: "panel",
    models: [
      { id: "weak", model: "weak-model" },
      { id: "strong", model: "strong-model" }
    ],
    runner: () => [
      { candidateId: "weak", modelId: "weak", model: "weak-model", content: "weak" },
      { candidateId: "strong", modelId: "strong", model: "strong-model", content: "strong" }
    ]
  });
  const rank = new PairRankOperator({
    id: "rank",
    rank: ({ candidates }) => ({
      rankings: candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        score: candidate.candidateId === "strong" ? 1 : 0
      }))
    })
  });
  const select = new SelectOperator({ id: "select" });
  const fuse = new GenFuserOperator({
    id: "fuse",
    fuse: ({ selected }) => ({ content: `winner:${selected?.candidate.content ?? "none"}` })
  });

  const result = await new FusionRuntime().run({
    graph: {
      id: "rank_fuse_graph",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "panel", operator: panel, inputs: [{ artifactId: task.id }] },
        { id: "rank", operator: rank, inputs: [{ artifactId: task.id }, { nodeId: "panel" }] },
        { id: "select", operator: select, inputs: [{ artifactId: task.id }, { nodeId: "panel" }, { nodeId: "rank" }] },
        { id: "fuse", operator: fuse, inputs: [{ artifactId: task.id }, { nodeId: "panel" }, { nodeId: "rank" }, { nodeId: "select" }] }
      ]
    },
    scheduler: new RankFuseScheduler(),
    artifacts: [task]
  });

  assert.equal((result.finalArtifacts[0]?.value as { content: string }).content, "winner:strong");
  assert.equal(result.outcome.schedulerFamily, "rank-fuse");
});

test("select operator rejects missing ranking/comparison/selector", async () => {
  const task = taskArtifact();
  const model = new ModelGenerateOperator({
    id: "model",
    model: "solo",
    client: {
      generate: () => ({ model: "solo", content: "answer" })
    }
  });
  const select = new SelectOperator({ id: "select" });

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "select_requires_evidence",
          inputArtifactIds: [task.id],
          nodes: [
            { id: "model", operator: model, inputs: [{ artifactId: task.id }] },
            { id: "select", operator: select, inputs: [{ artifactId: task.id }, { nodeId: "model" }] }
          ]
        },
        scheduler: new StaticDAGScheduler(),
        artifacts: [task]
      }),
    /selection requires an explicit comparison, rank matrix, or selector policy/
  );
});

test("execution-select-repair scheduler records evidence and repairs selected candidates", async () => {
  const task = taskArtifact();
  const panel = new PanelGenerateOperator({
    id: "panel",
    models: [{ id: "alpha", model: "alpha" }],
    runner: () => [{ candidateId: "alpha", modelId: "alpha", model: "alpha", content: "buggy" }]
  });
  const evidence = new EvidenceSourceOperator({
    id: "tests",
    source: ({ candidates }) => ({
      observations: candidates.map((candidate) => ({
        sourceId: "public-tests",
        targetArtifactId: `panel.candidate.1.${candidate.candidateId}`,
        type: "test_result",
        value: { passed: false },
        leakage: "public" as const
      })),
      summary: "public tests failed"
    })
  });
  const select = new SelectOperator({
    id: "select",
    selector: ({ candidates }) => {
      const candidate = candidates[0];
      assert.ok(candidate !== undefined);
      return { candidate, reason: "single generated candidate" };
    }
  });
  const repair = new RepairOperator({
    id: "repair",
    repair: ({ selected }) => ({
      candidate: {
        candidateId: "alpha-repaired",
        modelId: selected?.candidate.modelId ?? "alpha",
        model: selected?.candidate.model ?? "alpha",
        content: "fixed"
      }
    })
  });

  const result = await new FusionRuntime().run({
    graph: {
      id: "repair_graph",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "panel", operator: panel, inputs: [{ artifactId: task.id }] },
        { id: "tests", operator: evidence, inputs: [{ artifactId: task.id }, { nodeId: "panel" }] },
        { id: "select", operator: select, inputs: [{ artifactId: task.id }, { nodeId: "panel" }, { nodeId: "tests" }] },
        { id: "repair", operator: repair, inputs: [{ artifactId: task.id }, { nodeId: "panel" }, { nodeId: "tests" }, { nodeId: "select" }] }
      ]
    },
    scheduler: new ExecutionSelectRepairScheduler({ maxRepairRounds: 1 }),
    artifacts: [task]
  });

  assert.equal((result.finalArtifacts[0]?.value as CandidateArtifactValue).content, "fixed");
  assert.equal(result.observations.length, 1);
});

test("schema validation operator emits format signals", async () => {
  const task = taskArtifact();
  const model = new ModelGenerateOperator({
    id: "model",
    model: "json-model",
    client: {
      generate: () => ({ model: "json-model", content: "{\"ok\":true}" })
    }
  });
  const validate = new SchemaValidationOperator({
    id: "validate",
    validate: (value) => ({
      passed:
        value !== null &&
        typeof value === "object" &&
        typeof (value as { content?: unknown }).content === "string"
    })
  });

  const result = await new FusionRuntime().run({
    graph: {
      id: "schema_graph",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "model", operator: model, inputs: [{ artifactId: task.id }] },
        { id: "validate", operator: validate, inputs: [{ nodeId: "model" }] }
      ]
    },
    scheduler: new StaticDAGScheduler(),
    artifacts: [task]
  });

  assert.equal(result.signals[0]?.dimension, "format");
  assert.equal(result.signals[0]?.score, 1);
});

test("adaptive router and agentic delegation schedulers run route/delegate/review graphs", async () => {
  const task = taskArtifact();
  const route = new RouteOperator({
    id: "route",
    route: () => ({ routeId: "sidekick", reason: "read-only review" })
  });
  const delegate = new DelegateOperator({
    id: "delegate",
    role: "sidekick",
    delegate: ({ route: decision }) => ({
      role: decision?.routeId ?? "sidekick",
      output: "sidekick notes"
    })
  });

  const adaptive = await new FusionRuntime().run({
    graph: {
      id: "route_graph",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "route", operator: route, inputs: [{ artifactId: task.id }] },
        { id: "delegate", operator: delegate, inputs: [{ artifactId: task.id }, { nodeId: "route" }] }
      ]
    },
    scheduler: new AdaptiveRouterScheduler(),
    artifacts: [task]
  });
  const agentic = await new FusionRuntime().run({
    graph: {
      id: "delegate_graph",
      inputArtifactIds: [task.id],
      nodes: [{ id: "delegate", operator: delegate, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new AgenticDelegationScheduler(),
    artifacts: [task]
  });

  assert.equal((adaptive.finalArtifacts[0]?.value as { role: string }).role, "sidekick");
  assert.equal((agentic.finalArtifacts[0]?.value as { output: string }).output, "sidekick notes");
});

test("learned workflow scheduler follows injected policy", async () => {
  const task = taskArtifact();
  const seen: string[] = [];
  const op = (id: string): Operator => ({
    spec: { id, kind: "step", inputTypes: ["task"], outputTypes: ["final_answer"], sideEffects: "none" },
    run(_inputs, ctx) {
      seen.push(id);
      return [ctx.createArtifact({ id: `${id}.out`, type: "final_answer", value: { content: id } })];
    }
  });

  await new FusionRuntime().run({
    graph: {
      id: "learned_graph",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "a", operator: op("a"), inputs: [{ artifactId: task.id }] },
        { id: "b", operator: op("b"), inputs: [{ artifactId: task.id }] }
      ]
    },
    scheduler: new LearnedWorkflowScheduler({
      policy: {
        chooseReadyNode: ({ ready }) => {
          const preferred = ready.find((node) => node.id === "b") ?? ready.find((node) => node.id === "a");
          assert.ok(preferred !== undefined);
          return preferred.id;
        }
      }
    }),
    artifacts: [task]
  });

  assert.deepEqual(seen, ["b", "a"]);
});

test("learned workflow scheduler rejects non-ready policy choices", async () => {
  const task = taskArtifact();
  const op = (id: string): Operator => ({
    spec: { id, kind: "step", inputTypes: ["task"], outputTypes: ["final_answer"], sideEffects: "none" },
    run(_inputs, ctx) {
      return [ctx.createArtifact({ id: `${id}.out`, type: "final_answer", value: { content: id } })];
    }
  });

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "bad_learned_policy",
          inputArtifactIds: [task.id],
          nodes: [{ id: "a", operator: op("a"), inputs: [{ artifactId: task.id }] }]
        },
        scheduler: new LearnedWorkflowScheduler({
          policy: {
            chooseReadyNode: () => "missing"
          }
        }),
        artifacts: [task]
      }),
    /non-ready node missing/
  );
});

test("concurrent static DAG reserves operator budget before awaiting work", async () => {
  const task = taskArtifact();
  let started = 0;
  const op = (id: string): Operator => ({
    spec: { id, kind: "parallel", inputTypes: ["task"], outputTypes: ["final_answer"], sideEffects: "none" },
    async run(_inputs, ctx) {
      started += 1;
      await Promise.resolve();
      return [ctx.createArtifact({ id: `${id}.out`, type: "final_answer", value: { content: id } })];
    }
  });

  await assert.rejects(
    () =>
      new FusionRuntime().run({
        graph: {
          id: "parallel_budget",
          inputArtifactIds: [task.id],
          nodes: [
            { id: "a", operator: op("a"), inputs: [{ artifactId: task.id }] },
            { id: "b", operator: op("b"), inputs: [{ artifactId: task.id }] }
          ]
        },
        scheduler: new StaticDAGScheduler({ maxConcurrency: 2 }),
        artifacts: [task],
        budget: { maxOperatorRuns: 1 }
      }),
    (error) =>
      error instanceof RuntimeExecutionError &&
      error.cause instanceof BudgetExceededError &&
      /operator runs 2 > 1/.test(error.message)
  );
  assert.equal(started, 1);
});

test("offline architecture and model merge operators stay separate lifecycle artifacts", async () => {
  const task = taskArtifact();
  const architecture = new ArchitectureEvaluateOperator({
    id: "arch",
    evaluate: () => ({ architectureId: "dag-a", score: 0.7 })
  });
  const merge = new OfflineModelMergeOperator({
    id: "merge",
    merge: () => ({ recipeId: "merge-a", modelIds: ["a", "b"], steps: [{ kind: "average" }] })
  });
  const archResult = await new FusionRuntime().run({
    graph: {
      id: "arch_graph",
      inputArtifactIds: [task.id],
      nodes: [{ id: "arch", operator: architecture, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new OfflineArchitectureSearchScheduler(),
    artifacts: [task],
    budget: { allowPrivateRuntimeInputs: true }
  });
  const mergeResult = await new FusionRuntime().run({
    graph: {
      id: "merge_graph",
      inputArtifactIds: [task.id],
      nodes: [{ id: "merge", operator: merge, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new StaticDAGScheduler(),
    artifacts: [task]
  });

  assert.equal(archResult.finalArtifacts[0]?.type, "architecture_result");
  assert.equal(mergeResult.finalArtifacts[0]?.type, "merge_recipe");
});
