import { hashCanonical, hashCanonicalSha256 } from "@routekit/contracts";
import type { JsonValue } from "@routekit/contracts";
import type { ModelFusionSideEffects, ToolExecutionRecordV1 } from "./model-fusion.js";

export type ToolSideEffectClass = "none" | "read" | "write" | "external";
export type ToolExecutorMode = "demo_safe" | "policy_bound";
export type ToolPolicyDecision =
  | { decision: "allow"; reason: string; dedupeKey?: string }
  | { decision: "deny"; reason: string; errorKind: "tool_denied" | "capability_missing" };

export type ToolDefinition = {
  tool_name: string;
  side_effects: ToolSideEffectClass;
  description?: string;
};

export type ToolExecutorLimits = {
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type ToolExecutorBudget = {
  maxSpendUsd?: number;
};

export type ToolExecutorContract = {
  executor_id: string;
  mode: ToolExecutorMode;
  environment_id: string;
  tool_policy_id: string;
  allowed_tools: string[];
  side_effects: ToolSideEffectClass[];
  limits?: ToolExecutorLimits;
  timeoutMs?: number;
  budget?: ToolExecutorBudget;
  audit_sink?: string;
};

export type ToolExecutionRequest = {
  candidate_id?: string;
  plan_id?: string;
  tool_name: string;
  arguments: JsonValue;
  side_effects: ToolSideEffectClass;
};

export type ToolExecutionResult = {
  record: ToolExecutionRecordV1;
  output?: JsonValue;
  deduped: boolean;
  decision: ToolPolicyDecision;
};

export function toolArgumentsHash(args: JsonValue): string {
  return hashCanonicalSha256(args);
}

export function toolCallKey(input: {
  contract: ToolExecutorContract;
  request: ToolExecutionRequest;
}): string {
  return hashCanonical({
    executor_id: input.contract.executor_id,
    environment_id: input.contract.environment_id,
    tool_policy_id: input.contract.tool_policy_id,
    tool_name: input.request.tool_name,
    side_effects: input.request.side_effects,
    arguments_hash: toolArgumentsHash(input.request.arguments)
  });
}

export function modelFusionSideEffects(
  sideEffects: ToolSideEffectClass
): ModelFusionSideEffects {
  switch (sideEffects) {
    case "none":
      return "none";
    case "read":
      return "read_only";
    case "write":
      return "writes_workspace";
    case "external":
      return "network";
    default: {
      const exhausted: never = sideEffects;
      throw new Error(`unknown side effect class: ${String(exhausted)}`);
    }
  }
}

export function toolSideEffectClassFromModelFusion(
  sideEffects: ModelFusionSideEffects
): ToolSideEffectClass {
  switch (sideEffects) {
    case "none":
      return "none";
    case "read_only":
      return "read";
    case "writes_workspace":
      return "write";
    case "network":
      return "external";
    case "tool_execution":
    case "unknown":
      throw new Error(`unsupported tool side effect: ${sideEffects}`);
    default: {
      const exhausted: never = sideEffects;
      throw new Error(`unknown model-fusion side effect: ${String(exhausted)}`);
    }
  }
}

export function evaluateToolPolicy(
  contract: ToolExecutorContract,
  request: ToolExecutionRequest
): ToolPolicyDecision {
  if (!contract.allowed_tools.includes(request.tool_name)) {
    return {
      decision: "deny",
      reason: `tool ${request.tool_name} is not allowed by ${contract.tool_policy_id}`,
      errorKind: "tool_denied"
    };
  }
  if (!contract.side_effects.includes(request.side_effects)) {
    return {
      decision: "deny",
      reason: `side effect ${request.side_effects} is not allowed by ${contract.tool_policy_id}`,
      errorKind: "tool_denied"
    };
  }
  if (
    contract.mode === "demo_safe" &&
    (request.side_effects === "write" || request.side_effects === "external")
  ) {
    return {
      decision: "deny",
      reason: `demo_safe executor denies ${request.side_effects} tool calls by default`,
      errorKind: "tool_denied"
    };
  }
  return {
    decision: "allow",
    reason: "allowed by tool executor policy",
    dedupeKey:
      request.side_effects === "none" || request.side_effects === "read"
        ? toolCallKey({ contract, request })
        : undefined
  };
}
