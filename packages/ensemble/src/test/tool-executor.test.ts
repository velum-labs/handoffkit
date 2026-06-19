import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assertToolExecutionRecordV1 } from "@fusionkit/protocol";
import type { ToolExecutorContract } from "@fusionkit/protocol";

import { createToolExecutor, registerDemoTools } from "../tool-executor.js";
import { createMockHarness } from "../mock.js";
import { runEnsemble } from "../run.js";

function contract(overrides: Partial<ToolExecutorContract> = {}): ToolExecutorContract {
  return {
    executor_id: "exec_demo",
    mode: "demo_safe",
    environment_id: "env_a",
    tool_policy_id: "policy_read",
    allowed_tools: ["read_file", "echo"],
    side_effects: ["none", "read"],
    limits: { timeoutMs: 1000 },
    audit_sink: "memory",
    ...overrides
  };
}

function repoFixture(): { repo: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "tool-executor-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "hello tools\n");
  return { repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("read-only duplicate calls dedupe only under matching policy and environment", async () => {
  const fixture = repoFixture();
  try {
    const executor = createToolExecutor(contract());
    registerDemoTools(executor, fixture.repo);
    const request = {
      tool_name: "read_file",
      arguments: { path: "README.md" },
      side_effects: "read" as const
    };
    const first = await executor.execute(request);
    const second = await executor.execute(request);
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(second.record.execution_id, first.record.execution_id);

    const other = createToolExecutor(contract({ environment_id: "env_b" }));
    registerDemoTools(other, fixture.repo);
    const third = await other.execute(request);
    assert.notEqual(third.record.execution_id, first.record.execution_id);
  } finally {
    fixture.cleanup();
  }
});

test("write and external calls are denied by default", async () => {
  const executor = createToolExecutor(contract({ allowed_tools: ["write_file", "fetch"] }));
  const write = await executor.execute({
    tool_name: "write_file",
    arguments: { path: "README.md" },
    side_effects: "write"
  });
  const external = await executor.execute({
    tool_name: "fetch",
    arguments: { url: "https://example.com" },
    side_effects: "external"
  });
  assert.equal(write.record.status, "failed");
  assert.equal(write.record.error?.kind, "tool_denied");
  assert.equal(external.record.status, "failed");
  assert.equal(external.record.error?.kind, "tool_denied");
});

test("allowed read-only tools emit valid tool-execution-record.v1", async () => {
  const fixture = repoFixture();
  try {
    const executor = createToolExecutor(contract());
    registerDemoTools(executor, fixture.repo);
    const result = await executor.execute({
      tool_name: "read_file",
      arguments: { path: "README.md" },
      side_effects: "read"
    });
    assertToolExecutionRecordV1(result.record);
    assert.equal(result.record.status, "succeeded");
    assert.ok(result.record.output_hash?.startsWith("sha256:"));
  } finally {
    fixture.cleanup();
  }
});

test("candidate summaries include tool execution ids", async () => {
  const toolRecord = {
    execution_id: "exec_candidate_read",
    plan_id: "plan_candidate_read",
    status: "succeeded" as const,
    output_hash: "sha256:" + "a".repeat(64)
  };
  const result = await runEnsemble({
    id: "tool_summary",
    harness: createMockHarness({
      candidates: {
        fast: { toolRecords: [toolRecord] }
      }
    }),
    models: [{ id: "fast", model: "fake-fast" }],
    runtime: { id: "local" },
    judge: { id: "none" },
    policy: { id: "policy", allowedTools: ["read_file"], sideEffects: "read_only" },
    prompt: "tool summary",
    sourceRepo: "handoffkit",
    baseGitSha: "a".repeat(40)
  });
  assert.equal(result.toolRecords[0]?.execution_id, "exec_candidate_read");
  assert.deepEqual(result.summary?.candidates[0]?.toolExecutionIds, ["exec_candidate_read"]);
});
