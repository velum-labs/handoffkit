import type { RunContract, RunEvent, SessionIsolation } from "@warrant/protocol";

import type { BackendExecutionKind, PreparedExecution } from "./execution.js";

/** Everything a backend needs to execute one governed session. */
export type SessionExecution = {
  contract: RunContract;
  /** Materialized workspace on the runner host. */
  repoDir: string;
  secrets: { name: string; value: string }[];
  /** The backend-ready invocation prepared once by the runner. */
  execution: PreparedExecution;
  emit: (event: RunEvent) => void;
};

export type SessionBackendResult = {
  exitCode: number;
  log: Buffer;
};

/**
 * A session isolation backend. The runner owns workspace materialization,
 * output collection, event flushing, and receipt signing; the backend owns
 * only the execution boundary itself. The built-in backend is "process";
 * stronger tiers (hermetic interpreter, microVMs) are injected so the
 * runner kernel stays dependency-free.
 */
export type SessionBackend = {
  readonly isolation: SessionIsolation;
  /** Execution kinds this backend can execute. Undefined means all. */
  supports?(kind: BackendExecutionKind, contract: RunContract): boolean;
  execute(input: SessionExecution): Promise<SessionBackendResult>;
};
