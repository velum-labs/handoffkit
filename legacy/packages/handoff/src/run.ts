import { isTerminalStatus } from "@fusionkit/protocol";
import type {
  ActorRef,
  ChainedEvent,
  CheckpointTier,
  HandoffEnvelope,
  ReceiptBundle,
  RunStatus
} from "@fusionkit/protocol";
import { PlaneClient } from "@fusionkit/sdk";
import { pullRun } from "@fusionkit/workspace";
import type { PullResult } from "@fusionkit/workspace";

import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS
} from "./defaults.js";
import type { IsolationStrategy } from "./isolation.js";
import type { RuntimeTarget } from "./targets.js";

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
  /** Human-readable planner explanation for why this continuation ran. */
  readonly explanation: string;
  /** Isolation strategy applied at pull time. */
  readonly isolate?: IsolationStrategy;
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
    explanation?: string;
    isolate?: IsolationStrategy;
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
    this.explanation = input.explanation ?? "";
    if (input.isolate) this.isolate = input.isolate;
    this.client = input.client;
    this.actor = input.actor;
    this.workspaceDir = input.workspaceDir;
    this.onTerminal = input.onTerminal;
    this.onPulled = input.onPulled;
  }

  /** The checkpoint tier this continuation carried. */
  get tier(): CheckpointTier {
    return this.envelope.checkpoint.tier;
  }

  /** Deep link to this run in the control panel. */
  get url(): string {
    return this.client.runUiUrl(this.runId);
  }

  /** Where the signed evidence lives: bundle download via the CLI. */
  get auditUrl(): string {
    return this.client.runBundleUrl(this.runId);
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
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const pollMs = options.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    // Polling against a consistent per-iteration snapshot: terminal states
    // are absorbing, so a status flip between polls is observed on the next
    // iteration rather than lost. The interval and ceiling are shared with
    // Handoff.stream via ./defaults.js and caller-tunable per wait().
    for (;;) {
      const view = await this.client.getRun(this.runId);
      if (isTerminalStatus(view.status)) {
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

  /**
   * The session's combined stdout/stderr, fetched by the content hash
   * recorded in the event chain. Empty when the session produced no output.
   */
  async sessionLog(): Promise<string> {
    const events = await this.events();
    // Reverse scan returns the newest log artifact, which by the harness
    // convention supersedes earlier ones — exactly the right pick when a
    // session emitted more than one.
    for (let i = events.length - 1; i >= 0; i--) {
      const entry = events[i];
      if (!entry) continue;
      const event = entry.event;
      if (event.type === "artifact.created" && event.kind === "log") {
        const blob = await this.client.getBlob(event.hash);
        return blob.toString("utf8");
      }
    }
    return "";
  }

  /**
   * Exit code of the session's final harness command (the run's overall
   * outcome by convention). Sessions that execute multiple commands surface
   * each one as its own command.executed entry in events() for callers that
   * need per-command results.
   */
  async commandExitCode(): Promise<number | undefined> {
    const events = await this.events();
    for (let i = events.length - 1; i >= 0; i--) {
      const entry = events[i];
      if (!entry) continue;
      if (entry.event.type === "command.executed") {
        return entry.event.exitCode;
      }
    }
    return undefined;
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
   * otherwise materialized on a dedicated branch. A `branch()` isolation
   * strategy (set here or at continueIn/parallel time) always lands on a
   * branch and never touches the working tree.
   */
  async pull(
    options: { repoDir?: string; isolate?: IsolationStrategy } = {}
  ): Promise<PullResult> {
    const bundle = await this.receipt();
    const diffHash = bundle.receipt.workspaceOut.diffHash;
    if (!diffHash) {
      this.onPulled(this.runId, "empty");
      return { mode: "empty" };
    }
    const isolate = options.isolate ?? this.isolate;
    const diff = await this.client.getBlob(diffHash);
    const result = pullRun(
      options.repoDir ?? this.workspaceDir,
      this.runId,
      bundle.contract.workspace.baseRef,
      diff,
      { forceBranch: isolate?.id === "branch" }
    );
    this.onPulled(this.runId, result.mode);
    return result;
  }
}
