import { readFileSync } from "node:fs";

import {
  artifactHash,
  assertToolExecutionRecordV1,
  evaluateToolPolicy,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  modelFusionSideEffects,
  toolArgumentsHash,
  toolCallKey
} from "@fusionkit/protocol";
import type {
  JsonValue,
  ToolDefinition,
  ToolExecutionRecordV1,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolExecutorContract,
  ToolPolicyDecision,
  ToolSideEffectClass
} from "@fusionkit/protocol";
import { resolveInsideWorkspace } from "@fusionkit/workspace";

export type ToolImplementation = {
  definition: ToolDefinition;
  execute(args: JsonValue): Promise<JsonValue> | JsonValue;
};

export type ToolExecutor = {
  contract: ToolExecutorContract;
  register(tool: ToolImplementation): void;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
};

function metadata(createdAt: string) {
  return {
    schema: "tool-execution-record.v1" as const,
    schema_version: "v1" as const,
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: "handoffkit-ensemble",
    producer_version: "0.1.0",
    producer_git_sha: "0".repeat(40),
    created_at: createdAt
  };
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

function executionRecord(input: {
  contract: ToolExecutorContract;
  request: ToolExecutionRequest;
  status: ToolExecutionRecordV1["status"];
  output?: JsonValue;
  decision: ToolPolicyDecision;
  createdAt: string;
}): ToolExecutionRecordV1 {
  const argumentsHash = toolArgumentsHash(input.request.arguments);
  const record: ToolExecutionRecordV1 = {
    ...metadata(input.createdAt),
    execution_id: `tool_exec_${toolCallKey({
      contract: input.contract,
      request: input.request
    }).slice(0, 16)}`,
    plan_id:
      input.request.plan_id ??
      `tool_plan_${argumentsHash.slice("sha256:".length, "sha256:".length + 16)}`,
    status: input.status,
    ...(input.output !== undefined ? { output_hash: artifactHash(JSON.stringify(input.output)) } : {}),
    ...(input.status !== "succeeded"
      ? {
          error: {
            kind: input.decision.decision === "deny" ? input.decision.errorKind : "internal_error",
            message: input.decision.reason,
            retryable: false
          }
        }
      : {})
  };
  assertToolExecutionRecordV1(record);
  return record;
}

export function createToolExecutor(contract: ToolExecutorContract): ToolExecutor {
  const tools = new Map<string, ToolImplementation>();
  const dedupe = new Map<string, ToolExecutionResult>();
  return {
    contract,
    register(tool) {
      tools.set(tool.definition.tool_name, tool);
    },
    async execute(request) {
      const decision = evaluateToolPolicy(contract, request);
      const createdAt = new Date().toISOString();
      if (decision.decision === "deny") {
        return {
          record: executionRecord({
            contract,
            request,
            status: "failed",
            decision,
            createdAt
          }),
          deduped: false,
          decision
        };
      }
      if (decision.dedupeKey !== undefined && dedupe.has(decision.dedupeKey)) {
        const cached = dedupe.get(decision.dedupeKey);
        if (cached !== undefined) {
          return {
            record: executionRecord({
              contract,
              request,
              status: cached.record.status,
              output: cached.output,
              decision,
              createdAt
            }),
            ...(cached.output !== undefined ? { output: cached.output } : {}),
            deduped: true,
            decision
          };
        }
      }
      const tool = tools.get(request.tool_name);
      if (tool === undefined) {
        const denied: ToolPolicyDecision = {
          decision: "deny",
          reason: `tool ${request.tool_name} is not registered`,
          errorKind: "capability_missing"
        };
        return {
          record: executionRecord({
            contract,
            request,
            status: "unsupported",
            decision: denied,
            createdAt
          }),
          deduped: false,
          decision: denied
        };
      }
      const output = await tool.execute(request.arguments);
      const result: ToolExecutionResult = {
        record: executionRecord({
          contract,
          request,
          status: "succeeded",
          output,
          decision,
          createdAt
        }),
        output,
        deduped: false,
        decision
      };
      if (decision.dedupeKey !== undefined) dedupe.set(decision.dedupeKey, result);
      return result;
    }
  };
}

export function registerDemoTools(executor: ToolExecutor, workspace: string): void {
  executor.register({
    definition: {
      tool_name: "read_file",
      side_effects: "read",
      description: "Read a workspace-relative file."
    },
    execute(args) {
      const path = asObject(args).path;
      if (typeof path !== "string") throw new Error("read_file requires path");
      return {
        path,
        content: readFileSync(resolveInsideWorkspace(workspace, path), "utf8")
      };
    }
  });
  executor.register({
    definition: {
      tool_name: "echo",
      side_effects: "none",
      description: "Echo a JSON-safe value."
    },
    execute(args) {
      return args;
    }
  });
}

export function sideEffectsForTool(sideEffects: ToolSideEffectClass): ReturnType<typeof modelFusionSideEffects> {
  return modelFusionSideEffects(sideEffects);
}
