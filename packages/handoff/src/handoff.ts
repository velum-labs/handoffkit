import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";

import {
  canonicalize,
  defaultExecutionSpec,
  hashCanonical,
  isTerminalStatus,
  PolicyDeniedError,
  PROTOCOL_VERSIONS,
  sha256Hex
} from "@warrant/protocol";
import type {
  ActorRef,
  AgentSpec,
  ArtifactKind,
  BudgetSpec,
  ChainedEvent,
  Checkpoint,
  CheckpointTier,
  DisclosureReport,
  ExecutionSpec,
  HandoffEnvelope,
  RunRequestInput,
  RunStatus,
  SessionIsolation
} from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";
import { captureWorkspace } from "@warrant/workspace";
import type { CapturedWorkspace, PullResult } from "@warrant/workspace";

import { agents } from "./agents.js";
import { HandoffCheckpointManager } from "./checkpoint-manager.js";
import {
  BLOB_UPLOAD_CONCURRENCY,
  DEFAULT_ACTOR_ID,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STREAM_TIMEOUT_MS
} from "./defaults.js";
import type { IsolationStrategy } from "./isolation.js";
import { localFirst, planContinuation } from "./policy.js";
import type { ContinuationPolicy, PlanningDecision } from "./policy.js";
import { evaluateTriggers } from "./triggers.js";
import type { FiredTrigger, TriggerState } from "./triggers.js";
import { reviewRuns, reviewStrategies } from "./review.js";
import type { ReviewResult, ReviewStrategy } from "./review.js";
import { HandoffRun } from "./run.js";
import type { RuntimeTarget } from "./targets.js";
import { HandoffTraceLog } from "./trace-log.js";
import { HandoffToolJournal } from "./tool-journal.js";
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
  agent?: AgentSpec;
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
  agent?: AgentSpec;
  /** Durable machine intent. Defaults from the selected agent and task. */
  execution?: ExecutionSpec;
  reason?: string;
  secrets?: string[];
  allowHosts?: string[];
  /** Free-form transcript to carry as semantic state. */
  transcript?: string;
  /** Reuse an existing checkpoint instead of capturing a fresh one. */
  checkpoint?: Checkpoint;
  budget?: BudgetSpec;
  /** How results land at pull time. Defaults to divergence-safe auto. */
  isolate?: IsolationStrategy;
  /** Requested session isolation on the runner. Defaults to "process". */
  session?: SessionIsolation;
};

export type ParallelOptions = Omit<ContinueOptions, "task">;

/**
 * Module-level defaults set by defineHandoffConfig. This is deliberately
 * process-global, provider-style configuration: call it once at startup
 * (like configuring a logging or tracing SDK). Code that needs isolated
 * configuration — parallel tests, multi-tenant hosts — passes everything
 * explicitly to handoff(), which always wins over these defaults and never
 * reads them after construction.
 */
let handoffDefaults: Partial<HandoffConfig> = {};

/**
 * Register provider-style defaults once; subsequent `handoff({...})` calls
 * merge them under their explicit config (explicit values win):
 *
 *   defineHandoffConfig({ plane, agent: agents.claudeCode(), policy: localFirst() });
 *   const h = handoff({ workspace: "." });
 */
export function defineHandoffConfig(
  defaults: Partial<HandoffConfig>
): Partial<HandoffConfig> {
  handoffDefaults = defaults;
  return defaults;
}

/** Configuration accepted by handoff(): defaults can supply everything but the workspace. */
export type HandoffInit = Partial<HandoffConfig> & { workspace: string };

export type HandoffTraceEvent =
  | { type: "checkpoint.created"; ts: string; checkpointId: string; tier: CheckpointTier; message?: string }
  | { type: "continuation.planned"; ts: string; decision: PlanningDecision["decision"]; target: string; reasons: string[] }
  | { type: "continuation.requested"; ts: string; reason?: string }
  | { type: "envelope.created"; ts: string; envelopeId: string; envelopeHash: string; target: string }
  | { type: "run.requested"; ts: string; runId: string; status: RunStatus; task: string }
  | { type: "run.terminal"; ts: string; runId: string; status: RunStatus }
  | { type: "results.pulled"; ts: string; runId: string; mode: PullResult["mode"] }
  | { type: "tool.called"; ts: string; toolName: string; inputHash: string; outputHash?: string; ok: boolean; durationMs: number }
  | { type: "model.routed"; ts: string; model: string; route: "local" | "cloud"; escalated: boolean; reason: string };

/** A model routing decision reported by h.model (see withModel). */
export type ModelDecision = {
  model: string;
  route: "local" | "cloud";
  escalated: boolean;
  reason: string;
};

/** Where the work stands: derivable, recomputed, never source of truth. */
export type HandoffSummary = {
  workspace: string;
  checkpoints: number;
  toolCalls: number;
  continuations: { planned: number; denied: number; requested: number };
  modelRoutes: { local: number; cloud: number; escalations: number };
  runs: { runId: string; task: string; target: string; status: RunStatus }[];
  pulls: number;
};

/** Live event stream over a set of runs (see Handoff.stream). */
export type HandoffStreamEvent =
  | { type: "run.status"; runId: string; status: RunStatus }
  | { type: "run.event"; runId: string; event: ChainedEvent }
  | { type: "artifact.ready"; runId: string; kind: ArtifactKind; hash: string }
  | { type: "run.terminal"; runId: string; status: RunStatus };

/**
 * Actor used when none is configured: the OS user, falling back to a fixed
 * id. Callers who need a real identity pass `actor` in HandoffConfig (or
 * via defineHandoffConfig); this fallback exists so local experimentation
 * works without ceremony while still attributing runs to *someone*.
 */
function defaultActor(): ActorRef {
  return { kind: "human", id: process.env.USER ?? DEFAULT_ACTOR_ID };
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
  private readonly agent: AgentSpec;
  private readonly policy: ContinuationPolicy;
  private readonly secrets: string[];
  private readonly allowHosts: string[];
  private readonly allowUntracked: string[];
  private readonly budget: BudgetSpec;
  private readonly traceLog = new HandoffTraceLog();
  private readonly toolJournal = new HandoffToolJournal();
  private readonly requestedRuns: { runId: string; task: string; target: string }[] = [];
  private readonly checkpointsState = new HandoffCheckpointManager();
  private lastEnvelopeValue?: HandoffEnvelope;
  private userRequestedContinuation = false;
  private modelEscalationCount = 0;

  constructor(init: HandoffInit) {
    const config = { ...handoffDefaults, ...init };
    if (!config.plane) {
      throw new Error(
        "handoff requires a plane (pass it in the config or via defineHandoffConfig)"
      );
    }
    this.client =
      config.plane instanceof PlaneClient
        ? config.plane
        : new PlaneClient(config.plane.url, config.plane.adminToken);
    this.workspaceDir = resolve(config.workspace);
    this.actor = config.actor ?? defaultActor();
    // mock() is the safe default agent: it invokes no vendor CLI, spends
    // nothing, and visibly writes MOCK_AGENT.md into the workspace, so an
    // unconfigured context cannot silently run a real agent. Real agents
    // are always an explicit choice (agents.claudeCode(), agents.codex(), ...).
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
    return this.traceLog.snapshot();
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
        this.toolJournal.append(record);
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

  /** Snapshot of the observable state that continuation triggers evaluate. */
  private triggerState(): TriggerState {
    return {
      userRequested: this.userRequestedContinuation,
      toolFailures: this.toolJournal.failureCount(),
      totalToolDurationMs: this.toolJournal.totalDurationMs(),
      modelEscalations: this.modelEscalationCount
    };
  }

  /** Which of the policy's continueWhen triggers currently fire, and why. */
  firedTriggers(): FiredTrigger[] {
    return evaluateTriggers(this.policy.continueWhen ?? [], this.triggerState());
  }

  /**
   * Explicitly request continuation (the user gesture). Makes
   * triggers.userRequested() fire on the next needs() check.
   */
  requestContinuation(reason?: string): void {
    this.userRequestedContinuation = true;
    this.record({
      type: "continuation.requested",
      ts: new Date().toISOString(),
      ...(reason ? { reason } : {})
    });
  }

  /**
   * Report a model routing decision (wired up by withModel from
   * @warrant/adapter-ai-sdk). Escalations feed triggers.modelEscalated().
   */
  noteModelDecision(decision: ModelDecision): void {
    if (decision.escalated) this.modelEscalationCount++;
    this.record({
      type: "model.routed",
      ts: new Date().toISOString(),
      model: decision.model,
      route: decision.route,
      escalated: decision.escalated,
      reason: decision.reason
    });
  }

  /**
   * Deterministic check: should this work continue on the target?
   * True when the continuation policy permits the target AND — if the
   * policy declares continueWhen triggers — at least one trigger fires
   * against observable context state (tool failures, slow tools, explicit
   * requests, model escalations). Pure: records nothing, moves nothing.
   */
  needs(
    target: RuntimeTarget,
    options: Partial<ContinueOptions> & { parallelism?: number } = {}
  ): boolean {
    const allowed =
      planContinuation(this.policy, {
        target,
        secrets: options.secrets ?? this.secrets,
        budget: options.budget ?? this.budget,
        // Defaults to a single run; pass `parallelism` when probing whether
        // a parallel() fan-out of that width would be permitted.
        parallelism: options.parallelism ?? 1
      }).decision === "continue";
    if (!allowed) return false;
    const triggersConfigured = this.policy.continueWhen ?? [];
    if (triggersConfigured.length === 0) return true;
    return this.firedTriggers().length > 0;
  }

  /** Recomputed view over the trace plus live run statuses from the plane. */
  async summary(): Promise<HandoffSummary> {
    // Statuses are fetched concurrently with per-run error isolation: a run
    // whose status fetch fails is reported with its last locally known
    // status ("created" at minimum) instead of rejecting the whole summary.
    const runs: HandoffSummary["runs"] = await Promise.all(
      this.requestedRuns.map(async (requested) => {
        try {
          const view = await this.client.getRun(requested.runId);
          return { ...requested, status: view.status };
        } catch {
          return { ...requested, status: "created" as RunStatus };
        }
      })
    );
    let checkpoints = 0;
    let toolCalls = 0;
    let planned = 0;
    let denied = 0;
    let requested = 0;
    let pulls = 0;
    let localRoutes = 0;
    let cloudRoutes = 0;
    let escalations = 0;
    for (const event of this.traceLog.snapshot()) {
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
        case "continuation.requested":
          requested++;
          break;
        case "model.routed":
          if (event.route === "local") localRoutes++;
          else cloudRoutes++;
          if (event.escalated) escalations++;
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
      continuations: { planned, denied, requested },
      modelRoutes: { local: localRoutes, cloud: cloudRoutes, escalations },
      runs,
      pulls
    };
  }

  /** Every checkpoint this context created, oldest first (lineage intact). */
  checkpoints(): Checkpoint[] {
    return this.checkpointsState.snapshot();
  }

  /**
   * Live, typed event stream over a set of runs: status transitions, every
   * appended chained event, artifact availability, and terminal states.
   * Completes when all runs are terminal.
   */
  async *stream(
    runs: HandoffRun[],
    options: { pollMs?: number; timeoutMs?: number } = {}
  ): AsyncGenerator<HandoffStreamEvent, void, void> {
    const pollMs = options.pollMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS);
    const lastStatus = new Map<string, RunStatus>();
    const lastSeq = new Map<string, number>();
    const terminal = new Set<string>();

    while (terminal.size < runs.length) {
      if (Date.now() > deadline) {
        throw new Error("stream timed out before all runs reached a terminal state");
      }
      for (const run of runs) {
        if (terminal.has(run.runId)) continue;
        const view = await this.client.getRun(run.runId);
        for (const entry of view.events) {
          if (entry.seq <= (lastSeq.get(run.runId) ?? -1)) continue;
          lastSeq.set(run.runId, entry.seq);
          yield { type: "run.event", runId: run.runId, event: entry };
          if (entry.event.type === "artifact.created") {
            yield {
              type: "artifact.ready",
              runId: run.runId,
              kind: entry.event.kind,
              hash: entry.event.hash
            };
          }
        }
        if (view.status !== lastStatus.get(run.runId)) {
          lastStatus.set(run.runId, view.status);
          yield { type: "run.status", runId: run.runId, status: view.status };
        }
        if (isTerminalStatus(view.status)) {
          terminal.add(run.runId);
          yield { type: "run.terminal", runId: run.runId, status: view.status };
        }
      }
      if (terminal.size < runs.length) {
        // Polling is the plane's supported transport (plain stateless HTTP);
        // the interval is shared with HandoffRun.wait and caller-tunable.
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
  }

  /** The most recent envelope this context produced. */
  lastEnvelope(): HandoffEnvelope | undefined {
    return this.lastEnvelopeValue;
  }

  private record(event: HandoffTraceEvent): void {
    this.traceLog.append(event);
  }

  private capture(): CapturedWorkspace {
    return captureWorkspace(this.workspaceDir, {
      allowUntracked: this.allowUntracked
    });
  }

  /**
   * Upload the captured workspace with bounded concurrency. Blobs are
   * content-addressed and idempotent, so a partial failure simply leaves
   * already-uploaded blobs in place — retried checkpoints reuse them and
   * the plane's reference-counting GC reclaims any that end up orphaned.
   */
  private async uploadCapture(captured: CapturedWorkspace): Promise<void> {
    const payloads: Buffer[] = [
      captured.bundle,
      ...(captured.dirtyDiff ? [captured.dirtyDiff] : []),
      ...captured.untracked.map((file) => file.content)
    ];
    let next = 0;
    const workers = Array.from(
      { length: Math.min(BLOB_UPLOAD_CONCURRENCY, payloads.length) },
      async () => {
        while (next < payloads.length) {
          const index = next++;
          const payload = payloads[index];
          if (payload) await this.client.putBlob(payload);
        }
      }
    );
    await Promise.all(workers);
  }

  /** Snapshot the tool journal as a content-addressed blob payload. */
  private journalSnapshot():
    | { blob: Buffer; hash: string }
    | undefined {
    return this.toolJournal.snapshot();
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
    const checkpoint = this.checkpointsState.create({
      captured,
      ...(message ? { message } : {}),
      ...(transcriptHash ? { transcriptHash } : {}),
      ...(journal?.hash ? { toolJournalHash: journal.hash } : {})
    });
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
      version: PROTOCOL_VERSIONS.envelope,
      envelopeId: `env_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      source: { kind: "local", actor: this.actor, host: hostname() },
      target: { kind: "runner-pool", pool: target.pool },
      // Security posture, not a tunable: egress is deny-by-default with an
      // explicit allowHosts list, and secret claims are always "requested"
      // (release is the plane's policy decision, never the SDK's). Orgs
      // that pre-approve hosts express that in plane policy, not here.
      checkpoint,
      agent,
      task: { prompt: options.task },
      execution: options.execution ?? defaultExecutionSpec(agent, options.task),
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
      disclosure: this.policy.disclosure,
      ...(options.session ? { isolation: options.session } : {})
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
      ...(envelope.execution ? { execution: envelope.execution } : {}),
      ...(envelope.isolation ? { isolation: envelope.isolation } : {}),
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
    const journal = this.journalSnapshot();
    const checkpoint =
      options.checkpoint ??
      this.checkpointsState.create({
        captured,
        ...(options.reason ? { message: options.reason } : {}),
        ...(transcriptHash ? { transcriptHash } : {}),
        ...(journal?.hash ? { toolJournalHash: journal.hash } : {}),
        remember: false
      });
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
    return this.submit(target, checkpoint, options, decision);
  }

  private async submit(
    target: RuntimeTarget,
    checkpoint: Checkpoint,
    options: ContinueOptions,
    decision: PlanningDecision
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
      explanation: decision.reasons.join("; "),
      ...(options.isolate ? { isolate: options.isolate } : {}),
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
    // One plan covers the whole fan-out by construction: parallel() takes a
    // single options object, so secrets, budget, and target — everything
    // policy evaluates — are identical for every attempt. Only the task
    // prompt differs, and prompts are not a policy input. Attempts needing
    // different secrets or budgets are separate continueIn() calls.
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
      runs.push(
        await this.submit(target, checkpoint, { ...options, task, checkpoint }, decision)
      );
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

/**
 * Create a continuation context bound to a workspace and a plane. Anything
 * not supplied here falls back to defaults registered via
 * defineHandoffConfig; the workspace is always explicit.
 */
export function handoff(init: HandoffInit): Handoff {
  return new Handoff(init);
}
