import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";

import {
  canonicalize,
  hashCanonical,
  PolicyDeniedError,
  sha256Hex
} from "@warrant/protocol";
import type {
  ActorRef,
  BudgetSpec,
  Checkpoint,
  CheckpointTier,
  DisclosureReport,
  HandoffEnvelope,
  RunRequestInput,
  RunStatus,
  SemanticState,
  ToolCallRecord,
  ToolJournal
} from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";
import { captureWorkspace } from "@warrant/workspace";
import type { CapturedWorkspace, PullResult } from "@warrant/workspace";

import { agents, toAgentSpec } from "./agents.js";
import type { AgentDescriptor } from "./agents.js";
import { localFirst, planContinuation } from "./policy.js";
import type { ContinuationPolicy, PlanningDecision } from "./policy.js";
import { reviewRuns, reviewStrategies } from "./review.js";
import type { ReviewResult, ReviewStrategy } from "./review.js";
import { HandoffRun } from "./run.js";
import type { RuntimeTarget } from "./targets.js";
import { wrapTools } from "./tools.js";
import type { ToolLike } from "./tools.js";

export type HandoffConfig = {
  /** Path to the local git workspace this work starts in. */
  workspace: string;
  /** Plane connection: an existing client or url + admin token. */
  plane: PlaneClient | { url: string; adminToken: string };
  /** Who is asking. Defaults to the OS user. */
  actor?: ActorRef;
  /** Default agent for continuations. Defaults to the mock harness. */
  agent?: AgentDescriptor;
  /** Client-side continuation policy. Defaults to `localFirst()`. */
  policy?: ContinuationPolicy;
  /** Secret names continuations may request by default. */
  secrets?: string[];
  /** Hosts continuations may reach by default (deny-by-default egress). */
  allowHosts?: string[];
  /** Untracked-file glob allowlist applied at workspace capture. */
  allowUntracked?: string[];
  budget?: BudgetSpec;
};

export type ContinueOptions = {
  task: string;
  agent?: AgentDescriptor;
  reason?: string;
  secrets?: string[];
  allowHosts?: string[];
  /** Free-form transcript to carry as semantic state. */
  transcript?: string;
  /** Reuse an existing checkpoint instead of capturing a fresh one. */
  checkpoint?: Checkpoint;
  budget?: BudgetSpec;
};

export type ParallelOptions = Omit<ContinueOptions, "task">;

export type HandoffTraceEvent =
  | { type: "checkpoint.created"; ts: string; checkpointId: string; tier: CheckpointTier; message?: string }
  | { type: "continuation.planned"; ts: string; decision: PlanningDecision["decision"]; target: string; reasons: string[] }
  | { type: "envelope.created"; ts: string; envelopeId: string; envelopeHash: string; target: string }
  | { type: "run.requested"; ts: string; runId: string; status: RunStatus; task: string }
  | { type: "run.terminal"; ts: string; runId: string; status: RunStatus }
  | { type: "results.pulled"; ts: string; runId: string; mode: PullResult["mode"] }
  | { type: "tool.called"; ts: string; toolName: string; inputHash: string; outputHash?: string; ok: boolean; durationMs: number };

/** Where the work stands: derivable, recomputed, never source of truth. */
export type HandoffSummary = {
  workspace: string;
  checkpoints: number;
  toolCalls: number;
  continuations: { planned: number; denied: number };
  runs: { runId: string; task: string; target: string; status: RunStatus }[];
  pulls: number;
};

function defaultActor(): ActorRef {
  return { kind: "human", id: process.env.USER ?? "developer" };
}

/**
 * The continuation context. One object that can checkpoint local work,
 * plan a continuation under policy, hand the work to a governed runner
 * pool, and pull the results (and the receipts) back.
 *
 * Built entirely on Warrant primitives: every continuation is a signed
 * run contract, every result is an offline-verifiable receipt, and the
 * envelope hash is pinned inside the contract.
 */
export class Handoff {
  private readonly client: PlaneClient;
  private readonly workspaceDir: string;
  private readonly actor: ActorRef;
  private readonly agent: AgentDescriptor;
  private readonly policy: ContinuationPolicy;
  private readonly secrets: string[];
  private readonly allowHosts: string[];
  private readonly allowUntracked: string[];
  private readonly budget: BudgetSpec;
  private readonly traceEvents: HandoffTraceEvent[] = [];
  private readonly toolJournal: ToolCallRecord[] = [];
  private readonly requestedRuns: { runId: string; task: string; target: string }[] = [];
  private lastEnvelopeValue?: HandoffEnvelope;

  constructor(config: HandoffConfig) {
    this.client =
      config.plane instanceof PlaneClient
        ? config.plane
        : new PlaneClient(config.plane.url, config.plane.adminToken);
    this.workspaceDir = resolve(config.workspace);
    this.actor = config.actor ?? defaultActor();
    this.agent = config.agent ?? agents.mock();
    this.policy = config.policy ?? localFirst();
    this.secrets = config.secrets ?? [];
    this.allowHosts = config.allowHosts ?? [];
    this.allowUntracked = config.allowUntracked ?? [];
    this.budget = config.budget ?? {};
  }

  /** The local workspace this context is bound to. */
  get workspacePath(): string {
    return this.workspaceDir;
  }

  /** Local trace: every planning, envelope, run, pull, and tool decision. */
  trace(): HandoffTraceEvent[] {
    return [...this.traceEvents];
  }

  /**
   * Wrap an AI SDK-shaped toolset (any tools with `execute`) so every call
   * is journaled. The journal travels as content-addressed semantic state
   * in the next checkpoint, so a continuation carries what the loop's tools
   * saw and did. Tools still execute locally, in the caller's process —
   * this is capture, not orchestration. For governed *remote* execution,
   * use @warrant/adapter-ai-sdk's remoteTools instead.
   */
  tools<T extends Record<string, ToolLike>>(toolset: T): T {
    return wrapTools(
      toolset,
      () => this.toolJournal.length,
      ({ record, inputHash, outputHash, ok }) => {
        this.toolJournal.push(record);
        this.record({
          type: "tool.called",
          ts: record.ts,
          toolName: record.toolName,
          inputHash,
          ...(outputHash !== undefined ? { outputHash } : {}),
          ok,
          durationMs: record.durationMs
        });
      }
    );
  }

  /**
   * Deterministic check: would the continuation policy permit moving this
   * work to the target? Pure — evaluates nothing but policy, records
   * nothing, moves nothing. The v1 planner has no model-based triggers;
   * "needs" means "is allowed and available under policy".
   */
  needs(target: RuntimeTarget, options: Partial<ContinueOptions> = {}): boolean {
    return (
      planContinuation(this.policy, {
        target,
        secrets: options.secrets ?? this.secrets,
        budget: options.budget ?? this.budget,
        parallelism: 1
      }).decision === "continue"
    );
  }

  /** Recomputed view over the trace plus live run statuses from the plane. */
  async summary(): Promise<HandoffSummary> {
    const runs: HandoffSummary["runs"] = [];
    for (const requested of this.requestedRuns) {
      const view = await this.client.getRun(requested.runId);
      runs.push({ ...requested, status: view.status });
    }
    let checkpoints = 0;
    let toolCalls = 0;
    let planned = 0;
    let denied = 0;
    let pulls = 0;
    for (const event of this.traceEvents) {
      switch (event.type) {
        case "checkpoint.created":
          checkpoints++;
          break;
        case "tool.called":
          toolCalls++;
          break;
        case "continuation.planned":
          planned++;
          if (event.decision === "deny") denied++;
          break;
        case "results.pulled":
          pulls++;
          break;
        case "envelope.created":
        case "run.requested":
        case "run.terminal":
          break;
        default: {
          const exhausted: never = event;
          throw new Error(`unreachable trace event: ${String(exhausted)}`);
        }
      }
    }
    return {
      workspace: this.workspaceDir,
      checkpoints,
      toolCalls,
      continuations: { planned, denied },
      runs,
      pulls
    };
  }

  /** The most recent envelope this context produced. */
  lastEnvelope(): HandoffEnvelope | undefined {
    return this.lastEnvelopeValue;
  }

  private record(event: HandoffTraceEvent): void {
    this.traceEvents.push(event);
  }

  private capture(): CapturedWorkspace {
    return captureWorkspace(this.workspaceDir, {
      allowUntracked: this.allowUntracked
    });
  }

  private async uploadCapture(captured: CapturedWorkspace): Promise<void> {
    await this.client.putBlob(captured.bundle);
    if (captured.dirtyDiff) await this.client.putBlob(captured.dirtyDiff);
    for (const file of captured.untracked) {
      await this.client.putBlob(file.content);
    }
  }

  /** Snapshot the tool journal as a content-addressed blob payload. */
  private journalSnapshot():
    | { blob: Buffer; hash: string }
    | undefined {
    if (this.toolJournal.length === 0) return undefined;
    const journal: ToolJournal = {
      version: "warrant.tooljournal.v1",
      entries: [...this.toolJournal]
    };
    const blob = Buffer.from(canonicalize(journal), "utf8");
    return { blob, hash: sha256Hex(blob) };
  }

  private buildCheckpoint(
    captured: CapturedWorkspace,
    message?: string,
    transcriptHash?: string,
    toolJournalHash?: string
  ): Checkpoint {
    const semantic: SemanticState = {
      ...(transcriptHash ? { transcriptHash } : {}),
      ...(toolJournalHash ? { toolJournalHash } : {}),
      ...(message ? { note: message } : {})
    };
    const hasSemantic =
      transcriptHash !== undefined || toolJournalHash !== undefined;
    return {
      version: "warrant.checkpoint.v1",
      checkpointId: `chk_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      tier: "workspace",
      ...(message ? { message } : {}),
      ...(hasSemantic ? { semantic } : {}),
      workspace: captured.manifest
    };
  }

  /**
   * Capture resumable state: the workspace manifest (git base ref, dirty
   * diff, allowlisted untracked files) plus an optional transcript as
   * semantic state. Content moves to the plane blob store; secret-pattern
   * files are denied capture and the denial is recorded in the manifest.
   */
  async checkpoint(
    message?: string,
    options: { transcript?: string } = {}
  ): Promise<Checkpoint> {
    const captured = this.capture();
    await this.uploadCapture(captured);
    let transcriptHash: string | undefined;
    if (options.transcript !== undefined) {
      const blob = Buffer.from(options.transcript, "utf8");
      transcriptHash = sha256Hex(blob);
      await this.client.putBlob(blob);
    }
    const journal = this.journalSnapshot();
    if (journal) await this.client.putBlob(journal.blob);
    const checkpoint = this.buildCheckpoint(
      captured,
      message,
      transcriptHash,
      journal?.hash
    );
    this.record({
      type: "checkpoint.created",
      ts: checkpoint.createdAt,
      checkpointId: checkpoint.checkpointId,
      tier: checkpoint.tier,
      ...(message ? { message } : {})
    });
    return checkpoint;
  }

  /** Deterministic continuation planning; never moves anything. */
  plan(
    target: RuntimeTarget,
    options: Partial<ContinueOptions> = {},
    parallelism = 1
  ): PlanningDecision {
    const decision = planContinuation(this.policy, {
      target,
      secrets: options.secrets ?? this.secrets,
      budget: options.budget ?? this.budget,
      parallelism
    });
    this.record({
      type: "continuation.planned",
      ts: new Date().toISOString(),
      decision: decision.decision,
      target: target.id,
      reasons: decision.reasons
    });
    return decision;
  }

  private buildEnvelope(
    target: RuntimeTarget,
    checkpoint: Checkpoint,
    options: ContinueOptions
  ): HandoffEnvelope {
    const agent = options.agent ?? this.agent;
    return {
      version: "warrant.envelope.v1",
      envelopeId: `env_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      source: { kind: "local", actor: this.actor, host: hostname() },
      target: { kind: "runner-pool", pool: target.pool },
      checkpoint,
      agent: toAgentSpec(agent),
      task: { prompt: options.task },
      ...(options.reason ? { reason: options.reason } : {}),
      secrets: (options.secrets ?? this.secrets).map((name) => ({
        name,
        scope: "requested"
      })),
      network: {
        defaultDeny: true,
        allowHosts: options.allowHosts ?? this.allowHosts
      },
      budget: options.budget ?? this.budget,
      disclosure: this.policy.disclosure
    };
  }

  private buildRunRequest(
    envelope: HandoffEnvelope,
    envelopeHash: string
  ): RunRequestInput {
    if (!envelope.checkpoint.workspace) {
      throw new Error("envelope checkpoint is missing a workspace manifest");
    }
    return {
      requestedBy: this.actor,
      agentKind: envelope.agent.kind,
      ...(envelope.agent.version ? { agentVersion: envelope.agent.version } : {}),
      prompt: envelope.task.prompt,
      pool: envelope.target.pool,
      secretNames: envelope.secrets.map((claim) => claim.name),
      workspace: envelope.checkpoint.workspace,
      network: envelope.network,
      budget: envelope.budget,
      disclosure: envelope.disclosure,
      continuation: {
        envelopeHash,
        checkpointId: envelope.checkpoint.checkpointId,
        tier: envelope.checkpoint.tier
      }
    };
  }

  /**
   * "What would move?" — the disclosure report for a continuation,
   * computed without uploading, issuing, or executing anything.
   */
  async dryRun(
    target: RuntimeTarget,
    options: ContinueOptions
  ): Promise<{ report: DisclosureReport; envelope: HandoffEnvelope; decision: PlanningDecision }> {
    const decision = this.plan(target, options);
    if (decision.decision === "deny") {
      throw new PolicyDeniedError(decision.reasons);
    }
    const captured = this.capture();
    let transcriptHash: string | undefined;
    if (options.transcript !== undefined) {
      transcriptHash = sha256Hex(Buffer.from(options.transcript, "utf8"));
    }
    const checkpoint =
      options.checkpoint ??
      this.buildCheckpoint(
        captured,
        options.reason,
        transcriptHash,
        this.journalSnapshot()?.hash
      );
    const envelope = this.buildEnvelope(target, checkpoint, options);
    const envelopeHash = hashCanonical(envelope);
    const report = await this.client.dryRun(
      this.buildRunRequest(envelope, envelopeHash)
    );
    return { report, envelope, decision };
  }

  /**
   * Continue this work in the target pool: plan under policy (fail
   * closed), checkpoint, wrap the continuation in a content-addressed
   * envelope, and submit it as a governed run whose signed contract pins
   * the envelope hash.
   */
  async continueIn(
    target: RuntimeTarget,
    options: ContinueOptions
  ): Promise<HandoffRun> {
    const decision = this.plan(target, options);
    if (decision.decision === "deny") {
      throw new PolicyDeniedError(decision.reasons);
    }
    const checkpoint =
      options.checkpoint ??
      (await this.checkpoint(options.reason, {
        ...(options.transcript !== undefined
          ? { transcript: options.transcript }
          : {})
      }));
    return this.submit(target, checkpoint, options);
  }

  private async submit(
    target: RuntimeTarget,
    checkpoint: Checkpoint,
    options: ContinueOptions
  ): Promise<HandoffRun> {
    const envelope = this.buildEnvelope(target, checkpoint, options);
    // Store the canonical JSON bytes so the blob address equals the
    // envelope's content hash, which the signed contract pins.
    const envelopeHash = hashCanonical(envelope);
    await this.client.putBlob(Buffer.from(canonicalize(envelope), "utf8"));
    this.lastEnvelopeValue = envelope;
    this.record({
      type: "envelope.created",
      ts: envelope.createdAt,
      envelopeId: envelope.envelopeId,
      envelopeHash,
      target: target.id
    });

    const created = await this.client.requestRun(
      this.buildRunRequest(envelope, envelopeHash)
    );
    this.requestedRuns.push({
      runId: created.runId,
      task: options.task,
      target: target.id
    });
    this.record({
      type: "run.requested",
      ts: new Date().toISOString(),
      runId: created.runId,
      status: created.status,
      task: options.task
    });
    return new HandoffRun({
      runId: created.runId,
      target,
      envelope,
      envelopeHash,
      client: this.client,
      actor: this.actor,
      workspaceDir: this.workspaceDir,
      onTerminal: (runId, status) =>
        this.record({
          type: "run.terminal",
          ts: new Date().toISOString(),
          runId,
          status
        }),
      onPulled: (runId, mode) =>
        this.record({
          type: "results.pulled",
          ts: new Date().toISOString(),
          runId,
          mode
        })
    });
  }

  /**
   * Fan the same checkpoint out across several isolated attempts. Each
   * attempt is its own governed run with its own contract, envelope, and
   * receipt; outputs land on separate branches at pull time.
   */
  async parallel(
    tasks: string[],
    target: RuntimeTarget,
    options: ParallelOptions = {}
  ): Promise<HandoffRun[]> {
    if (tasks.length === 0) throw new Error("parallel requires at least one task");
    const decision = this.plan(
      target,
      { ...options, task: tasks[0] ?? "" },
      tasks.length
    );
    if (decision.decision === "deny") {
      throw new PolicyDeniedError(decision.reasons);
    }
    const checkpoint =
      options.checkpoint ??
      (await this.checkpoint(options.reason ?? `fan-out of ${tasks.length} attempts`, {
        ...(options.transcript !== undefined
          ? { transcript: options.transcript }
          : {})
      }));
    const runs: HandoffRun[] = [];
    for (const task of tasks) {
      runs.push(await this.submit(target, checkpoint, { ...options, task, checkpoint }));
    }
    return runs;
  }

  /** Compare fan-out attempts with a typed, deterministic strategy. */
  review(
    runs: HandoffRun[],
    options: { choose?: ReviewStrategy } = {}
  ): Promise<ReviewResult> {
    return reviewRuns(
      this.client,
      runs,
      options.choose ?? reviewStrategies.smallestDiff()
    );
  }
}

/** Create a continuation context bound to a workspace and a plane. */
export function handoff(config: HandoffConfig): Handoff {
  return new Handoff(config);
}
