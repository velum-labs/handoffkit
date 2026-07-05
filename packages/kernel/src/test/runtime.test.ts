import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createArtifact,
  DirectFastPathScheduler,
  FusionRuntime,
  RuntimeExecutionError,
  StaticDAGScheduler
} from "../runtime.js";
import type { Artifact, Operator, RuntimeEvent, StreamingOperator } from "../runtime.js";

function inputArtifact(): Artifact<{ prompt: string }> {
  return createArtifact({
    id: "task",
    type: "task",
    value: { prompt: "ship it" }
  });
}

function valueOperator(input: {
  id: string;
  inputTypes: string[];
  outputType: string;
  value: unknown;
  onRun?: (inputs: readonly Artifact[]) => void;
}): Operator {
  return {
    spec: {
      id: input.id,
      kind: input.id,
      requiredInputTypes: input.inputTypes,
      outputTypes: [input.outputType],
      sideEffects: "none"
    },
    run: (inputs, ctx) => {
      input.onRun?.(inputs);
      return [
        ctx.createArtifact({
          id: `${input.id}.out`,
          type: input.outputType,
          value: input.value
        })
      ];
    }
  };
}

test("StaticDAGScheduler runs graph nodes in dependency order and resolves node inputs", async () => {
  const task = inputArtifact();
  const order: string[] = [];
  const first = valueOperator({
    id: "first",
    inputTypes: ["task"],
    outputType: "candidate",
    value: "candidate",
    onRun: () => order.push("first")
  });
  const second = valueOperator({
    id: "second",
    inputTypes: ["candidate"],
    outputType: "final",
    value: "final",
    onRun: (inputs) => {
      order.push(`second:${inputs[0]?.id}`);
    }
  });

  const result = await new FusionRuntime().run({
    runId: "dag",
    graph: {
      id: "dag",
      inputArtifactIds: [task.id],
      nodes: [
        { id: "first", operator: first, inputs: [{ artifactId: task.id }] },
        { id: "second", operator: second, inputs: [{ nodeId: "first", type: "candidate" }] }
      ]
    },
    scheduler: new StaticDAGScheduler(),
    artifacts: [task]
  });

  assert.deepEqual(order, ["first", "second:first.out"]);
  assert.deepEqual(result.finalArtifacts.map((artifact) => artifact.id), ["second.out"]);
  assert.deepEqual(
    result.outcome.operatorSummaries?.map((summary) => summary.nodeId),
    ["first", "second"]
  );
});

test("DirectFastPathScheduler runs the single node and marks the final artifact", async () => {
  const task = inputArtifact();
  const operator = valueOperator({
    id: "direct",
    inputTypes: ["task"],
    outputType: "final",
    value: "done"
  });

  const result = await new FusionRuntime().run({
    runId: "direct",
    graph: {
      id: "direct",
      inputArtifactIds: [task.id],
      nodes: [{ id: "direct", operator, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new DirectFastPathScheduler(),
    artifacts: [task]
  });

  assert.equal(result.outcome.schedulerFamily, "direct-fast-path");
  assert.equal(result.finalArtifacts[0]?.id, "direct.out");
  assert.equal(result.trace.some((event) => event.type === "scheduler.decision"), true);
});

test("stream emits operator events before the final runtime result", async () => {
  const task = inputArtifact();
  const operator: StreamingOperator = {
    spec: {
      id: "streamer",
      kind: "streamer",
      requiredInputTypes: ["task"],
      outputTypes: ["final"],
      sideEffects: "none"
    },
    async *stream(): AsyncIterable<RuntimeEvent> {
      yield { type: "output.delta", content: "hel" };
      yield { type: "sse.chunk", data: "data: lo\n\n" };
    },
    run: (_inputs, ctx) => [
      ctx.createArtifact({
        id: "streamer.out",
        type: "final",
        value: "hello"
      })
    ]
  };

  const events: RuntimeEvent[] = [];
  for await (const event of new FusionRuntime().stream({
    runId: "stream",
    graph: {
      id: "stream",
      inputArtifactIds: [task.id],
      nodes: [{ id: "streamer", operator, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new DirectFastPathScheduler(),
    artifacts: [task]
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ["output.delta", "sse.chunk", "final"]
  );
  const final = events.at(-1);
  assert.equal(final?.type, "final");
  if (final?.type === "final") assert.equal(final.result.finalArtifacts[0]?.id, "streamer.out");
});

test("budget reserves expected cost, reconciles actual usage, and enforces caps", async () => {
  const task = inputArtifact();
  const metered: Operator = {
    spec: {
      id: "metered",
      kind: "metered",
      requiredInputTypes: ["task"],
      outputTypes: ["final"],
      sideEffects: "none",
      expectedCost: { usd: 0.5, inputTokens: 10 }
    },
    run: (_inputs, ctx) => {
      ctx.consumeBudget({ usd: 0.25, outputTokens: 4 });
      return [ctx.createArtifact({ id: "metered.out", type: "final", value: "ok" })];
    }
  };

  const ok = await new FusionRuntime().run({
    runId: "budget-ok",
    graph: {
      id: "budget-ok",
      inputArtifactIds: [task.id],
      nodes: [{ id: "metered", operator: metered, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new DirectFastPathScheduler(),
    artifacts: [task],
    budget: { maxCostUsd: 1 }
  });
  assert.equal(ok.outcome.budget.costUsd, 0.5);
  assert.equal(ok.outcome.budget.actualCostUsd, 0.25);
  assert.equal(ok.outcome.budget.reservedCostUsd, 0.25);

  const failed = await new FusionRuntime().run({
    runId: "budget-fail",
    graph: {
      id: "budget-fail",
      inputArtifactIds: [task.id],
      nodes: [{ id: "metered", operator: metered, inputs: [{ artifactId: task.id }] }]
    },
    scheduler: new DirectFastPathScheduler(),
    artifacts: [task],
    budget: { id: "tiny", maxCostUsd: 0.1 },
    failureMode: "return"
  });
  assert.equal(failed.outcome.status, "failed");
  assert.match(failed.outcome.error ?? "", /budget tiny exceeded/);
  assert.equal(failed.trace.some((event) => event.type === "budget.exceeded"), true);
});

test("operator errors produce failed outcomes and throw RuntimeExecutionError by default", async () => {
  const task = inputArtifact();
  const broken: Operator = {
    spec: {
      id: "broken",
      kind: "broken",
      requiredInputTypes: ["task"],
      outputTypes: ["final"],
      sideEffects: "none"
    },
    run: () => {
      throw new Error("boom");
    }
  };
  const graph = {
    id: "broken",
    inputArtifactIds: [task.id],
    nodes: [{ id: "broken", operator: broken, inputs: [{ artifactId: task.id }] }]
  };

  const returned = await new FusionRuntime().run({
    runId: "broken-return",
    graph,
    scheduler: new DirectFastPathScheduler(),
    artifacts: [task],
    failureMode: "return"
  });
  assert.equal(returned.outcome.status, "failed");
  assert.equal(returned.finalArtifacts.length, 0);
  assert.match(returned.outcome.error ?? "", /boom/);

  await assert.rejects(
    new FusionRuntime().run({
      runId: "broken-throw",
      graph,
      scheduler: new DirectFastPathScheduler(),
      artifacts: [task]
    }),
    (error: unknown) => error instanceof RuntimeExecutionError && error.outcome.status === "failed"
  );
});
