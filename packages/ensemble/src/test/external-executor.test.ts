import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertToolExecutionRecordV1,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  toolArgumentsHash
} from "@fusionkit/protocol";
import type {
  JsonValue,
  ModelFusionSideEffects,
  ToolCallPlanV1,
  ToolExecutorContract
} from "@fusionkit/protocol";

import {
  executeFusionKitToolBatch,
  FusionKitToolExecutorClient,
  FusionKitToolExecutorClientError,
  FusionKitToolExecutorError,
  type FusionKitToolExecutionRequest,
  startFusionKitToolExecutorServer
} from "../external-executor.js";
import { createToolExecutor, registerDemoTools } from "../tool-executor.js";
import type { ToolExecutor } from "../tool-executor.js";

function contract(overrides: Partial<ToolExecutorContract> = {}): ToolExecutorContract {
  return {
    executor_id: "exec_fusionkit",
    mode: "demo_safe",
    environment_id: "env_local",
    tool_policy_id: "policy_readonly",
    allowed_tools: ["read_file", "list_files", "echo", "write_file", "fetch"],
    side_effects: ["none", "read"],
    limits: { timeoutMs: 1000, maxOutputBytes: 4096 },
    timeoutMs: 1000,
    budget: { maxSpendUsd: 0 },
    audit_sink: "memory",
    ...overrides
  };
}

function repoFixture(): { repo: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "fusionkit-tool-executor-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  mkdirSync(join(repo, "packages"));
  writeFileSync(join(repo, "README.md"), "hello fusionkit\n");
  writeFileSync(join(repo, "packages", "demo.txt"), "demo\n");
  return { repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function executorFixture(repo: string, overrides: Partial<ToolExecutorContract> = {}): ToolExecutor {
  const executor = createToolExecutor(contract(overrides));
  registerDemoTools(executor, repo);
  executor.register({
    definition: {
      tool_name: "list_files",
      side_effects: "read",
      description: "Return a deterministic file list."
    },
    execute() {
      return { files: ["README.md", "packages/demo.txt"] };
    }
  });
  return executor;
}

function plan(
  toolName: string,
  args: JsonValue,
  sideEffects: ModelFusionSideEffects = "read_only",
  planId = `plan_${toolName}`
): ToolCallPlanV1 {
  return {
    schema: "tool-call-plan.v1",
    schema_version: "v1",
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: "test",
    producer_version: "0.1.0",
    producer_git_sha: "0".repeat(40),
    created_at: "2026-06-16T00:00:00.000Z",
    plan_id: planId,
    tool_name: toolName,
    arguments_hash: toolArgumentsHash(args),
    side_effects: sideEffects,
    status: "pending"
  };
}

function request(
  overrides: Partial<{
    candidate_id: string;
    tool_call_id: string;
    plan: ToolCallPlanV1;
    arguments: JsonValue;
    environment_id: string;
    tool_policy_id: string;
  }> = {}
): FusionKitToolExecutionRequest {
  const args = overrides.arguments ?? { path: "README.md" };
  return {
    candidate_id: "candidate_a",
    tool_call_id: "tool_call_a",
    plan: plan("read_file", args),
    arguments: args,
    environment_id: "env_local",
    tool_policy_id: "policy_readonly",
    ...overrides
  };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

test("batch execution returns schema-valid records grouped by candidate and tool call", async () => {
  const fixture = repoFixture();
  try {
    const executor = executorFixture(fixture.repo);
    const response = await executeFusionKitToolBatch(executor, {
      requests: [
        request({
          candidate_id: "candidate_a",
          tool_call_id: "tool_call_read",
          plan: plan("read_file", { path: "README.md" }, "read_only", "plan_read"),
          arguments: { path: "README.md" }
        }),
        request({
          candidate_id: "candidate_b",
          tool_call_id: "tool_call_list",
          plan: plan("list_files", { path: "packages" }, "read_only", "plan_list"),
          arguments: { path: "packages" }
        })
      ]
    });

    assert.equal(response.results.length, 2);
    assert.equal(response.results[0]?.candidate_id, "candidate_a");
    assert.equal(response.results[0]?.tool_call_id, "tool_call_read");
    assert.equal(response.results[0]?.record.plan_id, "plan_read");
    assert.equal(response.results[1]?.candidate_id, "candidate_b");
    assert.equal(response.results[1]?.tool_call_id, "tool_call_list");
    for (const result of response.results) {
      assertToolExecutionRecordV1(result.record);
      assert.equal(result.record.status, "succeeded");
    }
  } finally {
    fixture.cleanup();
  }
});

test("identical read-only requests dedupe under matching policy and environment", async () => {
  const fixture = repoFixture();
  try {
    const executor = executorFixture(fixture.repo);
    const response = await executeFusionKitToolBatch(executor, {
      requests: [
        request({
          candidate_id: "candidate_a",
          tool_call_id: "tool_call_a",
          plan: plan("read_file", { path: "README.md" }, "read_only", "plan_a"),
          arguments: { path: "README.md" }
        }),
        request({
          candidate_id: "candidate_b",
          tool_call_id: "tool_call_b",
          plan: plan("read_file", { path: "README.md" }, "read_only", "plan_b"),
          arguments: { path: "README.md" }
        })
      ]
    });

    assert.equal(response.results[0]?.deduped, false);
    assert.equal(response.results[1]?.deduped, true);
    assert.equal(
      response.results[1]?.record.execution_id,
      response.results[0]?.record.execution_id
    );
    assert.equal(response.results[1]?.record.plan_id, "plan_b");

    const otherEnvironment = executorFixture(fixture.repo, { environment_id: "env_other" });
    const third = await executeFusionKitToolBatch(otherEnvironment, {
      requests: [
        request({
          environment_id: "env_other",
          plan: plan("read_file", { path: "README.md" }, "read_only", "plan_c"),
          arguments: { path: "README.md" }
        })
      ]
    });
    assert.notEqual(
      third.results[0]?.record.execution_id,
      response.results[0]?.record.execution_id
    );
  } finally {
    fixture.cleanup();
  }
});

test("write, external, and unknown tools return failure taxonomy records", async () => {
  const fixture = repoFixture();
  try {
    const executor = executorFixture(fixture.repo, {
      allowed_tools: ["read_file", "list_files", "echo", "write_file", "fetch", "missing_tool"],
      side_effects: ["none", "read", "write", "external"]
    });
    const response = await executeFusionKitToolBatch(executor, {
      requests: [
        request({
          tool_call_id: "tool_call_write",
          plan: plan("write_file", { path: "README.md" }, "writes_workspace", "plan_write"),
          arguments: { path: "README.md" }
        }),
        request({
          tool_call_id: "tool_call_fetch",
          plan: plan("fetch", { url: "https://example.com" }, "network", "plan_fetch"),
          arguments: { url: "https://example.com" }
        }),
        request({
          tool_call_id: "tool_call_missing",
          plan: plan("missing_tool", {}, "read_only", "plan_missing"),
          arguments: {}
        })
      ]
    });

    assert.equal(response.results[0]?.record.status, "failed");
    assert.equal(response.results[0]?.record.error?.kind, "tool_denied");
    assert.equal(response.results[1]?.record.status, "failed");
    assert.equal(response.results[1]?.record.error?.kind, "tool_denied");
    assert.equal(response.results[2]?.record.status, "unsupported");
    assert.equal(response.results[2]?.record.error?.kind, "capability_missing");
  } finally {
    fixture.cleanup();
  }
});

test("batch validation rejects policy and argument mismatches", async () => {
  const fixture = repoFixture();
  try {
    const executor = executorFixture(fixture.repo);
    await assert.rejects(
      () =>
        executeFusionKitToolBatch(executor, {
          requests: [request({ environment_id: "env_other" })]
        }),
      (error: unknown) =>
        error instanceof FusionKitToolExecutorError &&
        error.status === 403 &&
        error.code === "environment_mismatch"
    );

    const badPlan = plan("read_file", { path: "README.md" }, "read_only", "plan_bad");
    await assert.rejects(
      () =>
        executeFusionKitToolBatch(executor, {
          requests: [
            request({
              plan: badPlan,
              arguments: { path: "packages/demo.txt" }
            })
          ]
        }),
      (error: unknown) =>
        error instanceof FusionKitToolExecutorError &&
        error.status === 400 &&
        error.code === "arguments_hash_mismatch"
    );

    const invalidPlan = {
      ...plan("read_file", { path: "README.md" }, "read_only", "plan_invalid"),
      status: "not-a-status"
    } as unknown as ToolCallPlanV1;
    await assert.rejects(
      () =>
        executeFusionKitToolBatch(executor, {
          requests: [request({ plan: invalidPlan })]
        }),
      (error: unknown) =>
        error instanceof FusionKitToolExecutorError &&
        error.status === 400 &&
        error.code === "invalid_request" &&
        error.message.includes("plan invalid")
    );
  } finally {
    fixture.cleanup();
  }
});

test("HTTP server and client enforce auth and validate bad requests", async () => {
  const fixture = repoFixture();
  const executor = executorFixture(fixture.repo);
  const started = await startFusionKitToolExecutorServer({
    executor,
    port: 0,
    authToken: "secret"
  });
  try {
    const health = await fetch(`${started.url}/v1/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "warrant-tool-executor"
    });

    const unauthenticated = await fetch(`${started.url}/v1/fusionkit/tool-executions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [] })
    });
    assert.equal(unauthenticated.status, 401);

    const client = new FusionKitToolExecutorClient(started.url, "secret");
    const success = await client.execute({
      requests: [request()]
    });
    assert.equal(success.results[0]?.record.status, "succeeded");

    const malformed = await fetch(`${started.url}/v1/fusionkit/tool-executions`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json"
      },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    const malformedBody = (await malformed.json()) as { code?: string };
    assert.equal(malformedBody.code, "invalid_json");

    await assert.rejects(
      () =>
        client.execute({
          requests: [request({ tool_policy_id: "policy_other" })]
        }),
      (error: unknown) =>
        error instanceof FusionKitToolExecutorClientError && error.status === 403
    );
  } finally {
    await close(started.server);
    fixture.cleanup();
  }
});
