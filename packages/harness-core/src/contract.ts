import type { ZodType } from "zod";

import type { JsonValue } from "@routekit/contracts";

import type { ApprovalDecision, ApprovalPolicy } from "./approvals.js";
import type { HarnessEvent } from "./events.js";
import type { HarnessKind } from "./kinds.js";
import type { HarnessStatus } from "./status.js";

/**
 * Opaque, versioned per-driver resume state. Persisted by the session store
 * so a later process can resume the native CLI session (codex thread id,
 * claude session id, ACP session id). A cursor that fails to parse means
 * "no resume", never an error.
 */
export type ResumeCursor = {
  version: number;
  kind: HarnessKind;
  data: JsonValue;
};

export type SessionTurnInput = {
  prompt: string;
  /** Kills/interrupts the in-flight turn; drivers MUST honor it. */
  signal?: AbortSignal;
};

/**
 * One live native session on a harness CLI. `sendTurn` streams canonical
 * events; approvals surface as `request.opened` events answered via
 * `respondToRequest`. All teardown paths settle pending approvals.
 */
export interface SessionHandle {
  readonly sessionId: string;
  sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent>;
  respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void>;
  interrupt(): Promise<void>;
  /** The current resume state, when the driver supports native resume. */
  resumeCursor(): ResumeCursor | undefined;
  stop(): Promise<void>;
}

export type StartSessionOptions = {
  cwd: string;
  model?: string;
  /** Resume a previously persisted native session when possible. */
  resume?: ResumeCursor;
  approvalPolicy?: ApprovalPolicy;
};

/**
 * One materialized configuration of a driver. The instance owns ALL of its
 * state (processes, sessions, caches); `dispose()` releases everything —
 * teardown is structural, not a lifecycle enum. Two instances created from
 * different configs share no mutable state.
 */
export interface HarnessInstance {
  readonly kind: HarnessKind;
  status(): HarnessStatus;
  startSession(options: StartSessionOptions): Promise<SessionHandle>;
  dispose(): Promise<void>;
}

export type DriverContext = {
  /** Source environment for probes and child allowlists. */
  env?: Record<string, string | undefined>;
  /** Overrides the status snapshot cache directory. */
  statusCacheDir?: string;
};

/**
 * A static factory for one CLI kind. A plain value, not a service: multiple
 * instances of the same driver with different configs must coexist. Config
 * decoding happens exactly once, at the registry boundary, through
 * `configSchema` — driver bodies never see raw `unknown`.
 */
export interface HarnessDriver<Config> {
  readonly kind: HarnessKind;
  readonly configSchema: ZodType<Config>;
  /** Probe installed/version/auth/models without creating an instance. */
  probe(context?: DriverContext): Promise<HarnessStatus>;
  createInstance(config: Config, context?: DriverContext): Promise<HarnessInstance>;
}

/**
 * Config-erased driver for heterogeneous collections. `any` (not `unknown`)
 * so concrete drivers assign without casts; the registry re-establishes
 * safety by always decoding through the driver's own schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHarnessDriver = HarnessDriver<any>;
