import type {
  ActorRef,
  ChainedEvent,
  HandoffEnvelope,
  ReceiptBundle,
  RunStatus
} from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";
import { pullRun } from "@warrant/workspace";
import type { PullResult } from "@warrant/workspace";

import type { RuntimeTarget } from "./targets.js";

const TERMINAL: RunStatus[] = ["completed", "failed", "cancelled"];

export type WaitOptions = {
  timeoutMs?: number;
  pollMs?: number;
};

export type WaitOutcome = {
  status: RunStatus;
  /** Present when the run is blocked on a human decision. */
  consentRequirements: string[];
};

/**
 * A continuation that became a governed run. Wraps the plane API with the
 * operations a continuation caller needs: wait, approve, receipt, pull.
 */
export class HandoffRun {
  readonly runId: string;
  readonly target: RuntimeTarget;
  readonly envelope: HandoffEnvelope;
  readonly envelopeHash: string;
  private readonly client: PlaneClient;
  private readonly actor: ActorRef;
  private readonly workspaceDir: string;
  private readonly onTerminal: (runId: string, status: RunStatus) => void;
  private readonly onPulled: (runId: string, mode: PullResult["mode"]) => void;

  constructor(input: {
    runId: string;
    target: RuntimeTarget;
    envelope: HandoffEnvelope;
    envelopeHash: string;
    client: PlaneClient;
    actor: ActorRef;
    workspaceDir: string;
    onTerminal: (runId: string, status: RunStatus) => void;
    onPulled: (runId: string, mode: PullResult["mode"]) => void;
  }) {
    this.runId = input.runId;
    this.target = input.target;
    this.envelope = input.envelope;
    this.envelopeHash = input.envelopeHash;
    this.client = input.client;
    this.actor = input.actor;
    this.workspaceDir = input.workspaceDir;
    this.onTerminal = input.onTerminal;
    this.onPulled = input.onPulled;
  }

  async status(): Promise<RunStatus> {
    const view = await this.client.getRun(this.runId);
    return view.status;
  }

  async events(): Promise<ChainedEvent[]> {
    const view = await this.client.getRun(this.runId);
    return view.events;
  }

  /**
   * Poll until the run is terminal or blocked on consent. Consent is a
   * human decision; the SDK surfaces it instead of spinning forever.
   */
  async wait(options: WaitOptions = {}): Promise<WaitOutcome> {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    const pollMs = options.pollMs ?? 300;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await this.client.getRun(this.runId);
      if (TERMINAL.includes(view.status)) {
        this.onTerminal(this.runId, view.status);
        return { status: view.status, consentRequirements: [] };
      }
      if (view.status === "awaiting_approval") {
        return {
          status: view.status,
          consentRequirements: view.consentRequirements
        };
      }
      if (Date.now() >= deadline) {
        throw new Error(`run ${this.runId} did not finish within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Grant required consent as the given actor (defaults to the context actor). */
  async approve(actor?: ActorRef): Promise<RunStatus> {
    const result = await this.client.approve(this.runId, actor ?? this.actor);
    return result.status;
  }

  /** Cancel the run if it has not been claimed by a runner yet. */
  async cancel(actor?: ActorRef): Promise<RunStatus> {
    const result = await this.client.cancel(this.runId, actor ?? this.actor);
    return result.status;
  }

  /** The signed, offline-verifiable receipt bundle. */
  receipt(): Promise<ReceiptBundle> {
    return this.client.getBundle(this.runId);
  }

  /**
   * Divergence-safe pull of the run's output into the local workspace:
   * applied in place when the workspace is clean at the contract base ref,
   * otherwise materialized on a dedicated branch.
   */
  async pull(options: { repoDir?: string } = {}): Promise<PullResult> {
    const bundle = await this.receipt();
    const diffHash = bundle.receipt.workspaceOut.diffHash;
    if (!diffHash) {
      this.onPulled(this.runId, "empty");
      return { mode: "empty" };
    }
    const diff = await this.client.getBlob(diffHash);
    const result = pullRun(
      options.repoDir ?? this.workspaceDir,
      this.runId,
      bundle.contract.workspace.baseRef,
      diff
    );
    this.onPulled(this.runId, result.mode);
    return result;
  }
}
