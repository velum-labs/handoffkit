import { hashCanonical, type ExecutionSpec, type RunContract } from "@warrant/protocol";

import { buildAgentCommand, type AgentContext } from "./agents.js";

export type PreparedExecution =
  | {
      kind: "argv";
      cmd: string;
      args: string[];
      cwd: string;
      timeoutMs: number;
      logMaxBytes?: number;
      env: Record<string, string>;
      egressProxy: boolean;
    }
  | {
      kind: "shell";
      script: string;
      shell: "sh" | "bash";
      cwd: string;
      timeoutMs: number;
      logMaxBytes?: number;
      env: Record<string, string>;
      egressProxy: boolean;
    };

export type BackendExecutionKind = PreparedExecution["kind"];

export type PrepareExecutionInput = {
  contract: RunContract;
  mockScriptPath: string;
};

/** Session wall-clock ceiling when neither execution nor contract sets a timeout. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function timeoutMsFor(contract: RunContract, spec: ExecutionSpec): number {
  if (spec.timeoutMs !== undefined) return spec.timeoutMs;
  if (contract.budget.maxDurationMin !== undefined) {
    return contract.budget.maxDurationMin * 60 * 1000;
  }
  return DEFAULT_TIMEOUT_MS;
}

function cwdFor(spec: ExecutionSpec): string {
  return spec.kind === "agent" ? "." : spec.cwd ?? ".";
}

function envFor(spec: ExecutionSpec): {
  env: Record<string, string>;
  egressProxy: boolean;
} {
  const policy = spec.env;
  const env: Record<string, string> = {};
  for (const key of policy?.inherit ?? []) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, policy?.vars ?? {});
  for (const secret of policy?.secrets ?? []) {
    env[secret.env] = `__WARRANT_SECRET__:${secret.secretName}`;
  }
  return { env, egressProxy: policy?.egressProxy ?? true };
}

function logMaxBytesFor(spec: ExecutionSpec): number | undefined {
  return spec.log?.maxBytes;
}

export function defaultExecutionForContract(contract: RunContract): ExecutionSpec {
  if (contract.agent.kind === "command") {
    return { kind: "shell", script: contract.task.prompt };
  }
  return {
    kind: "agent",
    agent: contract.agent,
    prompt: contract.task.prompt
  };
}

function prepareAgentExecution(
  spec: Extract<ExecutionSpec, { kind: "agent" }>,
  ctx: AgentContext,
  contract: RunContract
): PreparedExecution {
  const command = buildAgentCommand(spec.agent.kind, spec.prompt, ctx);
  const { env, egressProxy } = envFor(spec);
  return {
    kind: "argv",
    cmd: command.cmd,
    args: command.args,
    cwd: cwdFor(spec),
    timeoutMs: timeoutMsFor(contract, spec),
    logMaxBytes: logMaxBytesFor(spec),
    env,
    egressProxy
  };
}

export function prepareExecution(input: PrepareExecutionInput): PreparedExecution {
  const { contract, mockScriptPath } = input;
  const spec = contract.execution ?? defaultExecutionForContract(contract);
  switch (spec.kind) {
    case "agent":
      return prepareAgentExecution(spec, { mockScriptPath }, contract);
    case "argv": {
      const { env, egressProxy } = envFor(spec);
      return {
        kind: "argv",
        cmd: spec.command,
        args: spec.args,
        cwd: cwdFor(spec),
        timeoutMs: timeoutMsFor(contract, spec),
        logMaxBytes: logMaxBytesFor(spec),
        env,
        egressProxy
      };
    }
    case "shell": {
      const { env, egressProxy } = envFor(spec);
      return {
        kind: "shell",
        script: spec.script,
        shell: spec.shell ?? "sh",
        cwd: cwdFor(spec),
        timeoutMs: timeoutMsFor(contract, spec),
        logMaxBytes: logMaxBytesFor(spec),
        env,
        egressProxy
      };
    }
    default: {
      const exhausted: never = spec;
      throw new Error(`unsupported execution spec: ${String(exhausted)}`);
    }
  }
}

export function executionHash(execution: PreparedExecution): string {
  switch (execution.kind) {
    case "argv":
      return hashCanonical({
        kind: "argv",
        cmd: execution.cmd,
        args: execution.args,
        cwd: execution.cwd
      });
    case "shell":
      return hashCanonical({
        kind: "shell",
        shell: execution.shell,
        script: execution.script,
        cwd: execution.cwd
      });
    default: {
      const exhausted: never = execution;
      throw new Error(`unsupported prepared execution: ${String(exhausted)}`);
    }
  }
}

export function requireShellExecution(
  execution: PreparedExecution
): Extract<PreparedExecution, { kind: "shell" }> {
  if (execution.kind !== "shell") {
    throw new Error(`expected shell execution, got ${execution.kind}`);
  }
  return execution;
}
