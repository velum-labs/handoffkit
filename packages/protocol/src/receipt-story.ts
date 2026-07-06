import type {
  ReceiptBundle,
  RunEvent,
  SessionIsolation
} from "./types.js";

export type EventSummary = {
  tone: "plain" | "info" | "ok" | "warn" | "err";
  label: string;
  detail: string;
};

export type ReceiptStory = {
  runId: string;
  status: ReceiptBundle["receipt"]["status"];
  actor: string;
  agent: string;
  isolation: SessionIsolation;
  workspace: {
    baseRef: string;
    manifestHash: string;
    diffHash: string;
    artifactCount: number;
  };
  policyHash: string;
  secrets: string[];
  network: string[];
  eventCount: number;
  eventsHead: string;
  verificationCommand: string;
};

function short(hash: string, length = 12): string {
  return hash.slice(0, length);
}

export function summarizeRunEvent(event: RunEvent): EventSummary {
  switch (event.type) {
    case "run.created":
      return { tone: "info", label: "run.created", detail: "contract issued" };
    case "run.claimed":
      return {
        tone: "info",
        label: "run.claimed",
        detail: `${event.runnerId} ${event.runnerKeyId}`
      };
    case "workspace.materialized":
      return {
        tone: "info",
        label: "workspace.materialized",
        detail: `manifest ${short(event.manifestHash)}`
      };
    case "policy.evaluated":
      return {
        tone: event.decision === "allow" ? "ok" : "warn",
        label: "policy.evaluated",
        detail: event.reason
      };
    case "consent.requested":
      return {
        tone: "warn",
        label: "consent.requested",
        detail: event.requirement
      };
    case "consent.granted":
      return {
        tone: "ok",
        label: "consent.granted",
        detail: `${event.actor.kind}:${event.actor.id}`
      };
    case "secret.released":
      return {
        tone: "warn",
        label: "secret.released",
        detail: `${event.name} (${event.scope})`
      };
    case "command.executed":
      return {
        tone: event.exitCode === 0 ? "ok" : "err",
        label: "command.executed",
        detail: `argv ${short(event.argvHash)} exit ${event.exitCode}`
      };
    case "file.changed":
      return {
        tone: "plain",
        label: "file.changed",
        detail: `${event.path} ${short(event.contentHash)}`
      };
    case "network.connected":
      return {
        tone: event.decision === "allowed" ? "ok" : "warn",
        label: "network.connected",
        detail: `${event.host} ${event.decision}`
      };
    case "model.called":
      return {
        tone: "info",
        label: "model.called",
        detail: `${event.provider}/${event.model}`
      };
    case "boundary.crossed":
      return {
        tone: "warn",
        label: "boundary.crossed",
        detail: `${event.direction}: ${event.dataClass} ${short(event.contentHash)}`
      };
    case "artifact.created":
      return {
        tone: "info",
        label: "artifact.created",
        detail: `${event.kind} ${short(event.hash)}`
      };
    case "checkpoint.created":
      return {
        tone: "info",
        label: "checkpoint.created",
        detail: `${event.checkpointId} (${event.tier})`
      };
    case "run.completed":
      return { tone: "ok", label: "run.completed", detail: "completed" };
    case "run.failed":
      return {
        tone: "err",
        label: "run.failed",
        detail: `${event.failure}: ${event.message}`
      };
    case "run.cancelled":
      return {
        tone: "warn",
        label: "run.cancelled",
        detail: `${event.actor.kind}:${event.actor.id}`
      };
    default: {
      const exhausted: never = event;
      return { tone: "plain", label: "unknown", detail: String(exhausted) };
    }
  }
}

export function buildReceiptStory(bundle: ReceiptBundle): ReceiptStory {
  const { contract, receipt } = bundle;
  return {
    runId: receipt.runId,
    status: receipt.status,
    actor: `${contract.requestedBy.kind}:${contract.requestedBy.id}`,
    agent: contract.agent.kind,
    isolation: receipt.runner.isolation ?? "process",
    workspace: {
      baseRef: contract.workspace.baseRef,
      manifestHash: receipt.workspaceIn.manifestHash,
      diffHash: receipt.workspaceOut.diffHash,
      artifactCount: receipt.workspaceOut.artifactHashes.length
    },
    policyHash: contract.policyHash,
    secrets: receipt.secretsReleased.map((s) => `${s.name} (${s.scope})`),
    network: receipt.networkAccessed.map((n) => `${n.host} ${n.decision}`),
    eventCount: receipt.eventCount,
    eventsHead: receipt.eventsHead,
    verificationCommand: "fusionkit verify <bundle.json>"
  };
}
