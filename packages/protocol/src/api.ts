/**
 * Wire-level API contracts shared by the plane (server), SDK (client),
 * runner, handoff SDK, CLI, and control panel. These are data contracts,
 * not behavior: the plane implements them, everything else consumes them.
 */

import type {
  ActorRef,
  ChainedEvent,
  ContinuationRef,
  DisclosureMode,
  RunContract,
  RunStatus,
  SecretClaim
} from "./types.js";

/** A run request as accepted by `POST /v1/runs`. */
export type RunRequest = {
  runId: string;
  requestedBy: ActorRef;
  agentKind: string;
  agentVersion?: string;
  prompt: string;
  pool: string;
  secretNames: string[];
  workspace: RunContract["workspace"];
  network: RunContract["network"];
  budget: RunContract["budget"];
  disclosure: DisclosureMode;
  /** Present when the run continues prior work from a handoff envelope. */
  continuation?: ContinuationRef;
};

export type RunRequestInput = Omit<RunRequest, "runId">;

/** Outcome of policy evaluation at contract time. */
export type PolicyDecision = {
  decision: "allow" | "ask";
  reason: string;
  consentRequirements: string[];
};

/** `dryRun` output: the full disclosure report, with nothing moved. */
export type DisclosureReport = {
  dryRun: true;
  agent: { kind: string; version?: string };
  pool: string;
  workspace: {
    baseRef: string;
    bundleHash: string;
    dirtyDiffHash?: string;
    untrackedPaths: string[];
    deniedPaths: string[];
  };
  secrets: SecretClaim[];
  network: { defaultDeny: boolean; allowHosts: string[] };
  budget: { maxSpendUsd?: number; maxDurationMin?: number };
  disclosure: string;
  continuation?: ContinuationRef;
  policyDecision: PolicyDecision;
};

/** What a runner receives when it claims a contract. */
export type ClaimResult = {
  runId: string;
  contract: RunContract;
  claimToken: string;
  events: ChainedEvent[];
  secrets: { name: string; value: string }[];
};

/** Detailed view of a single run, as returned by `GET /v1/runs/:id`. */
export type RunView = {
  runId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  consentRequirements: string[];
  failureMessage?: string;
  events: ChainedEvent[];
};

/** Row in the run list, as returned by `GET /v1/runs`. */
export type RunSummary = {
  runId: string;
  status: RunStatus;
  agentKind: string;
  pool: string;
  prompt: string;
  requestedBy: ActorRef;
  createdAt: string;
  updatedAt: string;
  consentRequirements: string[];
  hasReceipt: boolean;
  continuation?: ContinuationRef;
};

/** Row in the runner list, as returned by `GET /v1/runners`. */
export type RunnerSummary = {
  runnerId: string;
  pool: string;
  keyId: string;
  enrolledAt: string;
};
