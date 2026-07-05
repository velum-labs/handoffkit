import { jsonSchema, tool } from "ai";
import type { Tool } from "ai";

import { agents } from "./agents.js";
import { handoff, Handoff } from "./handoff.js";
import type { HandoffRun } from "./run.js";
import { scorecardFor } from "./review.js";
import type { Scorecard } from "./review.js";
import type { ContinuationPolicy } from "./policy.js";
import { targets } from "./targets.js";
import type { RuntimeTarget } from "./targets.js";
import { PolicyDeniedError, verifyReceiptBundle } from "@fusionkit/protocol";
import type {
  ActorRef,
  AgentSpec,
  ReceiptBundle,
  RunStatus,
  SessionIsolation
} from "@fusionkit/protocol";
import { RUNTIME_TIMEOUT_MS } from "@fusionkit/runtime-utils";
import { PlaneClient } from "@fusionkit/sdk";

/**
 * `swarmTools()` gives a *cloud orchestrator harness* (Claude Code dynamic
 * workflows, Codex goals — anything run through `HarnessAgent`) the governed
 * dispatch surface it lacks: fan a goal out across cheap local Pi workers,
 * inspect them, compose their disjoint results, and escalate the rest to a
 * cloud target. The orchestration *loop* stays the harness's own; Warrant
 * contributes only the execution boundary, exactly as `remoteTools()` does
 * for app-owned loops.
 *
 * Every tool is host-executed (the harness calls it; this process runs it),
 * each dispatch and escalation is a signed governed run with an offline-
 * verifiable receipt, and the only writes that reach the workspace of record
 * are pulls of those governed runs. The orchestrator's own sandbox is never
 * mirrored back. Judgment is the orchestrator's; the *evidence* it judges on
 * — the deterministic `Scorecard` and the receipt — is Warrant's.
 *
 * Structural invariant: only the orchestrator receives these tools. Workers
 * are plain `pi` runs and cannot dispatch, so fan-out depth is one.
 */

export type SwarmPlane = PlaneClient | { url: string; adminToken: string };

export type SwarmToolsConfig = {
  /** Local git workspace whose state every governed run materializes. */
  workspace: string;
  plane: SwarmPlane;
  /** Pool of runners with a pi harness backend: the cheap local workers. */
  workerPool: string;
  /** Pool that runs escalations (a real-OS tier for the cloud agent). */
  cloudPool: string;
  actor?: ActorRef;
  secrets?: string[];
  allowHosts?: string[];
  allowUntracked?: string[];
  /** Client-side continuation policy (fan-out ceiling, allowed pools). Defaults to localFirst(). */
  policy?: ContinuationPolicy;
  /** Per-run wait ceiling. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Agent for workers. Defaults to pi (the local-swarm harness). */
  workerAgent?: AgentSpec;
  /** Session tier for workers. Defaults to "hermetic" (just-bash + pi). */
  workerSession?: SessionIsolation;
  /** Session tier for escalations. Defaults to "process". */
  cloudSession?: SessionIsolation;
  /** Agent for escalations. Defaults to claude-code. */
  cloudAgent?: AgentSpec;
  /** Cap on cloud escalations for the lifetime of this toolset. Defaults to the fan-out ceiling. */
  maxEscalations?: number;
  /** Max bytes of each pulled diff returned to the orchestrator. Defaults to 4 KiB. */
  diffExcerptBytes?: number;
};

/** Alternative wiring: attach to an existing pi-default continuation context. */
export type SwarmToolsContextConfig = Omit<
  SwarmToolsConfig,
  "workspace" | "plane" | "secrets" | "allowHosts" | "allowUntracked" | "actor" | "policy"
> & {
  context: Handoff;
};

export type WorkerTaskInput = {
  prompt: string;
  /** Files this worker is meant to touch. Surfaced in the prompt; verified from evidence. */
  fileScope?: string[];
};

export type DispatchInput = { tasks: WorkerTaskInput[] };
export type DispatchOutput = {
  dispatched: { runId: string; prompt: string }[];
  /** True when the requested fan-out exceeded the continuation policy ceiling. */
  budgetExceeded: boolean;
  reason: string;
};

export type StatusInput = { runIds: string[] };
export type StatusOutput = {
  statuses: { runId: string; status: RunStatus; known: boolean }[];
};

export type PullInput = { runId: string };
export type PullOutput = {
  runId: string;
  status: RunStatus;
  /** "accepted": pulled onto the workspace; "escalate": failed or overlapping. */
  verdict: "accepted" | "escalate";
  reason: string;
  filesChanged: string[];
  /** Paths that collided with already-pulled work (verdict "escalate"). */
  conflictingPaths?: string[];
  scorecard?: Scorecard;
  diffExcerpt?: string;
  receipt?: { contractHash: string; eventsHead: string; verified: boolean };
};

export type EscalateInput = { task: string; reason?: string };
export type EscalateOutput = {
  runId?: string;
  status?: RunStatus;
  /** True when the escalation budget for this toolset is exhausted. */
  budgetExceeded: boolean;
  reason: string;
  filesChanged?: string[];
  receipt?: { contractHash: string; eventsHead: string; verified: boolean };
};

export type SwarmToolSet = {
  dispatch_workers: Tool<DispatchInput, DispatchOutput>;
  worker_status: Tool<StatusInput, StatusOutput>;
  pull_worker: Tool<PullInput, PullOutput>;
  escalate_task: Tool<EscalateInput, EscalateOutput>;
};

/** One evidence record per governed run the orchestrator drove through these tools. */
export type SwarmRunRecord = {
  tool: "dispatch_workers" | "pull_worker" | "escalate_task";
  runId: string;
  status: RunStatus;
  verdict?: "accepted" | "escalate";
  contractHash?: string;
  receiptVerified?: boolean;
};

export type SwarmTools = {
  /** AI SDK-compatible tools; pass as `HarnessAgent`'s `tools`. */
  tools: SwarmToolSet;
  /** One record per governed run driven through these tools. */
  calls(): SwarmRunRecord[];
  /** The underlying pi-default continuation context (trace, summary, …). */
  context: Handoff;
};

const DEFAULT_TIMEOUT_MS = RUNTIME_TIMEOUT_MS.session;
const DEFAULT_DIFF_EXCERPT_BYTES = 4 * 1024;
const DEFAULT_WORKER_SESSION: SessionIsolation = "hermetic";
const DEFAULT_CLOUD_SESSION: SessionIsolation = "process";

/** Distinct workspace paths a run changed, from its receipt's boundary events. */
function changedPaths(bundle: ReceiptBundle): string[] {
  const paths = new Set<string>();
  for (const entry of bundle.events) {
    if (entry.event.type === "file.changed") paths.add(entry.event.path);
  }
  return [...paths];
}

function withScope(task: WorkerTaskInput): string {
  if (!task.fileScope || task.fileScope.length === 0) return task.prompt;
  return (
    `${task.prompt}\n\nScope: confine your changes to these files: ` +
    `${task.fileScope.join(", ")}. Do not modify files outside this set.`
  );
}

function receiptEvidence(bundle: ReceiptBundle): {
  contractHash: string;
  eventsHead: string;
  verified: boolean;
} {
  return {
    contractHash: bundle.receipt.contractHash,
    eventsHead: bundle.receipt.eventsHead,
    verified: verifyReceiptBundle(bundle).ok
  };
}

export function swarmTools(config: SwarmToolsConfig | SwarmToolsContextConfig): SwarmTools {
  const context =
    "context" in config
      ? config.context
      : handoff({
          workspace: config.workspace,
          plane: config.plane,
          // The default agent is pi: dispatched workers are pi runs unless a
          // call overrides. Escalations pass the cloud agent explicitly.
          agent: config.workerAgent ?? agents.pi(),
          ...(config.actor ? { actor: config.actor } : {}),
          ...(config.policy ? { policy: config.policy } : {}),
          ...(config.secrets ? { secrets: config.secrets } : {}),
          ...(config.allowHosts ? { allowHosts: config.allowHosts } : {}),
          ...(config.allowUntracked ? { allowUntracked: config.allowUntracked } : {})
        });

  const workerTarget: RuntimeTarget = targets.pool(config.workerPool);
  const cloudTarget: RuntimeTarget = targets.pool(config.cloudPool);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const diffExcerptBytes = config.diffExcerptBytes ?? DEFAULT_DIFF_EXCERPT_BYTES;
  const workerAgent = config.workerAgent ?? agents.pi();
  const workerSession = config.workerSession ?? DEFAULT_WORKER_SESSION;
  const cloudSession = config.cloudSession ?? DEFAULT_CLOUD_SESSION;
  const cloudAgent = config.cloudAgent ?? agents.claudeCode();
  const maxEscalations = config.maxEscalations;

  // State across tool calls within one orchestrator session.
  const runsById = new Map<string, { run: HandoffRun; prompt: string }>();
  const pulledPaths = new Set<string>();
  const records: SwarmRunRecord[] = [];
  let escalations = 0;

  const client =
    config && "context" in config
      ? undefined
      : config.plane instanceof PlaneClient
        ? config.plane
        : new PlaneClient(config.plane.url, config.plane.adminToken);

  async function diffExcerptFor(bundle: ReceiptBundle): Promise<string> {
    const diffHash = bundle.receipt.workspaceOut.diffHash;
    if (!diffHash || !client) return "";
    const blob = await client.getBlob(diffHash);
    const text = blob.toString("utf8");
    return text.length > diffExcerptBytes ? text.slice(0, diffExcerptBytes) : text;
  }

  const dispatch_workers = tool({
    description:
      "Fan a set of independent worker tasks out across cheap local Pi agents, " +
      "each a governed run with a signed receipt. Returns one run id per task. " +
      "Make the tasks independent and their file scopes disjoint; overlap is " +
      "detected later from receipts and downgraded to escalation. Refused with " +
      "budgetExceeded=true if the fan-out exceeds the continuation policy ceiling.",
    inputSchema: jsonSchema<DispatchInput>({
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "What this worker should do." },
              fileScope: {
                type: "array",
                items: { type: "string" },
                description: "Files this worker is meant to touch (kept disjoint across workers)."
              }
            },
            required: ["prompt"],
            additionalProperties: false
          }
        }
      },
      required: ["tasks"],
      additionalProperties: false
    }),
    execute: async ({ tasks }): Promise<DispatchOutput> => {
      if (tasks.length === 0) {
        return { dispatched: [], budgetExceeded: false, reason: "no tasks supplied" };
      }
      const prompts = tasks.map(withScope);
      try {
        const runs = await context.parallel(prompts, workerTarget, {
          agent: workerAgent,
          session: workerSession,
          reason: `swarm fan-out of ${tasks.length} worker(s)`
        });
        const dispatched = runs.map((run, i) => {
          const prompt = prompts[i] ?? "";
          runsById.set(run.runId, { run, prompt });
          records.push({ tool: "dispatch_workers", runId: run.runId, status: "created" });
          return { runId: run.runId, prompt };
        });
        return {
          dispatched,
          budgetExceeded: false,
          reason: `dispatched ${dispatched.length} worker(s) to pool "${config.workerPool}"`
        };
      } catch (error) {
        if (error instanceof PolicyDeniedError) {
          // Mirror Codex's budget_limited semantics with Warrant's own policy
          // ceiling: the orchestrator sees the refusal as a tool result and
          // can dispatch a smaller batch or escalate instead.
          return {
            dispatched: [],
            budgetExceeded: true,
            reason: error.reasons.join("; ")
          };
        }
        throw error;
      }
    }
  });

  const worker_status = tool({
    description:
      "Report the current status of dispatched workers without blocking, so the " +
      "orchestrator can interleave its own work while the swarm runs.",
    inputSchema: jsonSchema<StatusInput>({
      type: "object",
      properties: {
        runIds: { type: "array", items: { type: "string" } }
      },
      required: ["runIds"],
      additionalProperties: false
    }),
    execute: async ({ runIds }): Promise<StatusOutput> => {
      const statuses = await Promise.all(
        runIds.map(async (runId) => {
          const entry = runsById.get(runId);
          if (!entry) return { runId, status: "created" as RunStatus, known: false };
          return { runId, status: await entry.run.status(), known: true };
        })
      );
      return { statuses };
    }
  });

  const pull_worker = tool({
    description:
      "Wait for one worker to finish, then judge it from evidence. A failed worker " +
      "or one whose files overlap already-pulled work is returned with verdict " +
      "'escalate' and is NOT pulled. A clean, disjoint, completed worker is pulled " +
      "onto the workspace of record and returned with verdict 'accepted', its " +
      "deterministic scorecard, a diff excerpt, and its receipt.",
    inputSchema: jsonSchema<PullInput>({
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
      additionalProperties: false
    }),
    execute: async ({ runId }): Promise<PullOutput> => {
      const entry = runsById.get(runId);
      if (!entry) {
        return {
          runId,
          status: "created",
          verdict: "escalate",
          reason: "unknown run id; dispatch it before pulling",
          filesChanged: []
        };
      }
      const outcome = await entry.run.wait({ timeoutMs });
      if (outcome.status !== "completed") {
        records.push({
          tool: "pull_worker",
          runId,
          status: outcome.status,
          verdict: "escalate"
        });
        return {
          runId,
          status: outcome.status,
          verdict: "escalate",
          reason:
            outcome.status === "awaiting_approval"
              ? `blocked on consent: ${outcome.consentRequirements.join("; ")}`
              : `worker did not complete (status ${outcome.status})`,
          filesChanged: []
        };
      }

      const bundle = await entry.run.receipt();
      const paths = changedPaths(bundle);
      const conflicting = paths.filter((path) => pulledPaths.has(path));
      const evidence = receiptEvidence(bundle);
      if (conflicting.length > 0) {
        // Deterministic overlap, computed from receipts — never asked of a
        // model. Refuse the pull so two workers never both write a file; the
        // orchestrator escalates this task to start from the updated tree.
        records.push({
          tool: "pull_worker",
          runId,
          status: outcome.status,
          verdict: "escalate",
          contractHash: evidence.contractHash,
          receiptVerified: evidence.verified
        });
        return {
          runId,
          status: outcome.status,
          verdict: "escalate",
          reason: `output overlaps already-pulled files: ${conflicting.join(", ")}`,
          filesChanged: paths,
          conflictingPaths: conflicting,
          receipt: evidence
        };
      }

      const diffHash = bundle.receipt.workspaceOut.diffHash;
      const diffBytes = diffHash && client ? (await client.getBlob(diffHash)).length : 0;
      const scorecard = scorecardFor(bundle, diffBytes);
      const diffExcerpt = await diffExcerptFor(bundle);
      await entry.run.pull();
      for (const path of paths) pulledPaths.add(path);
      records.push({
        tool: "pull_worker",
        runId,
        status: outcome.status,
        verdict: "accepted",
        contractHash: evidence.contractHash,
        receiptVerified: evidence.verified
      });
      return {
        runId,
        status: outcome.status,
        verdict: "accepted",
        reason: "completed, disjoint, and pulled onto the workspace of record",
        filesChanged: paths,
        scorecard,
        diffExcerpt,
        receipt: evidence
      };
    }
  });

  const escalate_task = tool({
    description:
      "Re-run one task on the cloud target (a capable agent on a real-OS tier) " +
      "as a governed run, then pull its result. Use for tasks a local worker " +
      "failed or whose output collided. Bounded: refused with budgetExceeded=true " +
      "once the escalation budget is exhausted.",
    inputSchema: jsonSchema<EscalateInput>({
      type: "object",
      properties: {
        task: { type: "string" },
        reason: { type: "string" }
      },
      required: ["task"],
      additionalProperties: false
    }),
    execute: async ({ task, reason }): Promise<EscalateOutput> => {
      if (maxEscalations !== undefined && escalations >= maxEscalations) {
        return {
          budgetExceeded: true,
          reason: `escalation budget exhausted (${maxEscalations})`
        };
      }
      escalations += 1;
      const run = await context.continueIn(cloudTarget, {
        task,
        agent: cloudAgent,
        session: cloudSession,
        reason: reason ?? "swarm escalation to cloud target"
      });
      const outcome = await run.wait({ timeoutMs });
      const status = outcome.status;
      if (status !== "completed") {
        records.push({ tool: "escalate_task", runId: run.runId, status });
        return {
          budgetExceeded: false,
          runId: run.runId,
          status,
          reason:
            status === "awaiting_approval"
              ? `blocked on consent: ${outcome.consentRequirements.join("; ")}`
              : `escalation did not complete (status ${status})`
        };
      }
      const bundle = await run.receipt();
      const paths = changedPaths(bundle);
      const evidence = receiptEvidence(bundle);
      await run.pull();
      for (const path of paths) pulledPaths.add(path);
      records.push({
        tool: "escalate_task",
        runId: run.runId,
        status,
        contractHash: evidence.contractHash,
        receiptVerified: evidence.verified
      });
      return {
        budgetExceeded: false,
        runId: run.runId,
        status,
        reason: "escalated, completed, and pulled onto the workspace of record",
        filesChanged: paths,
        receipt: evidence
      };
    }
  });

  return {
    tools: { dispatch_workers, worker_status, pull_worker, escalate_task },
    calls: () => [...records],
    context
  };
}
