import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateToolPolicy,
  modelFusionSideEffects,
  toolArgumentsHash,
  toolCallKey,
  toolSideEffectClassFromModelFusion
} from "../tool-executor.js";
import type { ToolExecutorContract, ToolExecutionRequest, ToolExecutionResult } from "../tool-executor.js";

const contract: ToolExecutorContract = {
  executor_id: "exec_demo",
  mode: "demo_safe",
  environment_id: "env_local",
  tool_policy_id: "policy_readonly",
  allowed_tools: ["read_file", "echo"],
  side_effects: ["none", "read"],
  limits: { timeoutMs: 1000, maxOutputBytes: 1024 },
  timeoutMs: 1000,
  budget: { maxSpendUsd: 0 },
  audit_sink: "memory"
};

test("tool call keys are stable and policy scoped", () => {
  const request: ToolExecutionRequest = {
    tool_name: "read_file",
    arguments: { path: "README.md" },
    side_effects: "read"
  };
  assert.equal(toolArgumentsHash(request.arguments).startsWith("sha256:"), true);
  assert.equal(toolCallKey({ contract, request }), toolCallKey({ contract, request }));
  assert.notEqual(
    toolCallKey({ contract, request }),
    toolCallKey({
      contract: { ...contract, environment_id: "env_other" },
      request
    })
  );
  assert.equal(
    toolCallKey({ contract, request }),
    toolCallKey({
      contract,
      request: {
        ...request,
        candidate_id: "candidate_b",
        plan_id: "tool_plan_other"
      }
    })
  );
});

test("tool policy allows read-only configured tools and denies unsafe calls", () => {
  const allowed = evaluateToolPolicy(contract, {
    tool_name: "read_file",
    arguments: { path: "README.md" },
    side_effects: "read"
  });
  assert.equal(allowed.decision, "allow");
  assert.ok(allowed.decision === "allow" && allowed.dedupeKey);

  const unknown = evaluateToolPolicy(contract, {
    tool_name: "write_file",
    arguments: { path: "README.md" },
    side_effects: "write"
  });
  assert.equal(unknown.decision, "deny");

  const external = evaluateToolPolicy(
    { ...contract, allowed_tools: ["fetch"], side_effects: ["external"] },
    { tool_name: "fetch", arguments: { url: "https://example.com" }, side_effects: "external" }
  );
  assert.equal(external.decision, "deny");
});

test("tool side effects map to model-fusion side effects", () => {
  assert.equal(modelFusionSideEffects("none"), "none");
  assert.equal(modelFusionSideEffects("read"), "read_only");
  assert.equal(modelFusionSideEffects("write"), "writes_workspace");
  assert.equal(modelFusionSideEffects("external"), "network");
  assert.equal(toolSideEffectClassFromModelFusion("none"), "none");
  assert.equal(toolSideEffectClassFromModelFusion("read_only"), "read");
  assert.equal(toolSideEffectClassFromModelFusion("writes_workspace"), "write");
  assert.equal(toolSideEffectClassFromModelFusion("network"), "external");
  assert.throws(() => toolSideEffectClassFromModelFusion("unknown"));
});

test("tool execution result shape remains JSON-safe", () => {
  const result: ToolExecutionResult = {
    record: {
      schema: "tool-execution-record.v1",
      schema_version: "v1",
      schema_bundle_hash: "sha256:75792f89c091b6ab4fd317a15fb03fd73438563dceff5ccf9f5d7c752dbf35f3",
      producer: "test",
      producer_version: "0.1.0",
      producer_git_sha: "0".repeat(40),
      created_at: "2026-06-16T00:00:00.000Z",
      execution_id: "exec_1",
      plan_id: "plan_1",
      status: "succeeded",
      output_hash: toolArgumentsHash({ ok: true })
    },
    output: { ok: true },
    deduped: false,
    decision: { decision: "allow", reason: "test" }
  };
  assert.doesNotThrow(() => JSON.stringify(result));
});
