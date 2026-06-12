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

export type ExecutionResult = {
  exitCode: number;
  timedOut: boolean;
  stdout?: Buffer;
  stderr?: Buffer;
  log: Buffer;
  executionHash: string;
};

export const DEFAULT_EXECUTION_LOG_POLICY: ExecutionLogPolicy = {
  stdout: "capture",
  stderr: "merge"
};
