import type { AgentSpec } from "./types.js";

export type ExecutionEnv = {
  /** Ambient variables intentionally inherited by name. */
  inherit?: string[];
  /** Secret store names mapped onto validated environment variable names. */
  secrets?: { env: string; secretName: string }[];
  /** Non-secret literal environment values. */
  vars?: Record<string, string>;
  /** Whether the runner should inject its governed egress proxy. */
  egressProxy?: boolean;
};

export type ExecutionLogPolicy = {
  stdout: "capture";
  stderr: "merge" | "capture";
  /** Maximum captured bytes before the backend terminates the execution. */
  maxBytes?: number;
};

export type ExecutionSpec =
  | {
      kind: "shell";
      script: string;
      shell?: "sh" | "bash";
      /** Workspace-relative directory. Defaults to ".". */
      cwd?: string;
      timeoutMs?: number;
      env?: ExecutionEnv;
      log?: ExecutionLogPolicy;
    }
  | {
      kind: "argv";
      command: string;
      args: string[];
      /** Workspace-relative directory. Defaults to ".". */
      cwd?: string;
      timeoutMs?: number;
      env?: ExecutionEnv;
      log?: ExecutionLogPolicy;
    }
  | {
      kind: "agent";
      agent: AgentSpec;
      prompt: string;
      timeoutMs?: number;
      env?: ExecutionEnv;
      log?: ExecutionLogPolicy;
    };

/**
 * The default execution intent for an agent and task when a request or
 * contract carries no explicit `execution`: the "command" harness runs the
 * task as one governed shell command; every other harness receives the
 * task as its prompt. This is the single defaulting rule shared by the
 * plane (contract issue + dry run), the handoff SDK, and the runner.
 */
export function defaultExecutionSpec(agent: AgentSpec, prompt: string): ExecutionSpec {
  if (agent.kind === "command") return { kind: "shell", script: prompt };
  return { kind: "agent", agent, prompt };
}

/**
 * Resolve the execution intent of a run request: the explicit `execution`
 * when present, otherwise the shared default. The `agentKind` cast is the
 * one sanctioned place a request's free-form agent string becomes an
 * `AgentSpec`: the schema deliberately leaves it unconstrained so the
 * policy engine (not parsing) decides permissibility.
 */
export function executionFromRunRequest(request: {
  agentKind: string;
  agentVersion?: string;
  prompt: string;
  execution?: ExecutionSpec;
}): ExecutionSpec {
  if (request.execution) return request.execution;
  return defaultExecutionSpec(
    {
      kind: request.agentKind as AgentSpec["kind"],
      ...(request.agentVersion ? { version: request.agentVersion } : {})
    },
    request.prompt
  );
}
