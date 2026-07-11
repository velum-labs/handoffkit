import assert from "node:assert/strict";
import test from "node:test";
import { graph, registerWorkflow } from "../kernel.js";
import { defineOperator } from "../kernel-helpers.js";
import { StaticDAGScheduler } from "../runtime.js";
import { resolveTopology, topology, topologyHash } from "../topology-spec.js";

test("topology hash is canonical across param key order", () => {
  const a = topology({
    workflowId: "test-hash",
    params: { panel: ["a", "b"], judge: "a", nested: { z: 1, a: 2 } },
    k: 1
  });
  const b = topology({
    workflowId: "test-hash",
    params: { nested: { a: 2, z: 1 }, judge: "a", panel: ["a", "b"] },
    k: 1
  });
  assert.equal(topologyHash(a), topologyHash(b));
});

test("topology resolves a registered workflow and derives step mode", () => {
  registerWorkflow("topology-spec-test", () =>
    graph("topology-test-graph")
      .node(
        "noop",
        defineOperator(
          {
            id: "noop",
            kind: "schema_validation",
            inputTypes: [],
            outputTypes: [],
            sideEffects: "none"
          },
          async () => []
        )
      )
      .scheduler(new StaticDAGScheduler())
      .compile()
  );
  const spec = topology({
    workflowId: "topology-spec-test",
    params: {},
    k: 4,
    panelMode: "step"
  });
  const resolved = resolveTopology(spec);
  assert.equal(resolved.panelMode, "step");
  assert.equal(resolved.hash, topologyHash(spec));
  assert.equal(resolved.workflow.graph.id, "topology-test-graph");
});

test("topology rejects k/panel mode conflicts", () => {
  const spec = topology({
    workflowId: "does-not-matter",
    params: {},
    k: 1,
    panelMode: "trajectory"
  });
  assert.throws(() => resolveTopology(spec), /conflicts with k/);
});

