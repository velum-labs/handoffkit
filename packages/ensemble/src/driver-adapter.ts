import type { ModelFusionErrorKind, ModelFusionHarnessKind } from "@fusionkit/protocol";
import type { FusionTraceCarrier } from "@fusionkit/tracing";
import {
  HarnessError,
  DEFAULT_AUTOMATION_APPROVAL_POLICY
} from "@routekit/harness-core";
import { artifactHash } from "@routekit/contracts";
import type { JsonValue, ReasoningSelection } from "@routekit/contracts";
import type {
  AnyHarnessDriver,
  ApprovalPolicy,
  DriverContext,
  HarnessDriver,
  HarnessErrorCode,
  HarnessEvent,
  ResumeCursor
} from "@routekit/harness-core";
import type { HarnessKind } from "@routekit/harness-core";

import { traceCandidate } from "./candidate-trace.js";
import type {
  EnsembleDescriptor,
  HarnessAdapter,
  HarnessCandidateOutput,
  HarnessCapabilities,
  HarnessRunInput,
  HarnessTrajectory,
  TrajectoryStep
} from "./harness.js";
import { diffWorkspace } from "./worktree.js";

const MAX_STEP_TEXT = 4000;
const MAX_TOOL_INPUT = 600;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Bridge a harness-core {@link HarnessDriver} into the ensemble panel's
 * {@link HarnessAdapter}: one driver instance per panel, one native session
 * per candidate (in its worktree), streaming canonical {@link HarnessEvent}s
 * that are folded into a candidate output. This is the supported path for the
 * panel to consume the driver architecture; each turn advances the driver's
 * own session so multi-turn front-door runs reuse native resume.
 */
/** How a panel candidate's model routes: its own endpoint, or the shared one. */
export type DriverModelRoute = {
  /** The ensemble model id (routing key). */
  modelId: string;
  /** The namespaced model id the CLI should request when routed per model. */
  model: string;
  /** OpenAI-compatible endpoint the CLI's model calls go to. */
  endpointUrl: string;
};

export type DriverHarnessOptions<Config> = {
  driver: HarnessDriver<Config>;
  /**
   * Build the per-candidate driver config. The panel routes each model to its
   * own endpoint (or the shared fusion backend), so config is resolved per
   * candidate rather than shared: one native session per model, each pointed
   * at that model's route.
   */
  configForModel: (route: DriverModelRoute) => Config;
  /** Per-model endpoints keyed by ensemble model id (panel routing). */
  modelEndpoints?: Record<string, string>;
  /** The shared gateway URL for models without a dedicated endpoint. */
  gatewayUrl: string;
  /** Env/status-cache context for probes and child allowlists. */
  context?: DriverContext;
  /** Panel default is autoApprove:all (headless, disposable worktrees). */
  approvalPolicy?: ApprovalPolicy;
  /**
   * Resume cursors keyed by ensemble model id, for multi-turn continuation.
   * The caller (the gateway) owns one map per conversation so a follow-up turn
   * resumes each panel member's native session instead of re-prompting a fresh
   * process. Keyed by model id (stable across turns), not the per-turn
   * candidate id.
   */
  resumeCursors?: Map<string, ResumeCursor>;
  /** Trace carrier of the enclosing run/turn; candidates span under it. */
  trace?: FusionTraceCarrier;
  turn?: number;
  reasoning?: ReasoningSelection;
};

function toModelFusionHarnessKind(kind: HarnessKind): ModelFusionHarnessKind {
  switch (kind) {
    case "codex":
      return "codex";
    case "claude_code":
      return "claude_code";
    case "cursor":
      return "cursor";
    case "opencode":
    case "generic":
      return "generic";
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported harness kind: ${String(exhausted)}`);
    }
  }
}

function toModelFusionErrorKind(error: HarnessError): ModelFusionErrorKind {
  switch (error.code) {
    case "not_installed":
    case "not_authenticated":
    case "version_unsupported":
      return "capability_missing";
    case "invalid_config":
    case "protocol_parse":
      return "validation_error";
    case "timeout":
      return "timeout";
    case "aborted":
    case "session_closed":
    case "provider_error":
      return error.category === "quota_exhausted" ? "rate_limited" : "provider_error";
    default: {
      const exhausted: never = error.code;
      throw new Error(`unsupported harness error code: ${String(exhausted)}`);
    }
  }
}

type FoldedTurn = {
  status: HarnessCandidateOutput["status"];
  finalOutput: string;
  toolCount: number;
  /** Reconstructed agent trajectory steps — the fusion panel's actual product. */
  steps: TrajectoryStep[];
  endReason: HarnessTrajectory["endReason"];
  error?: { message: string; code: string };
};

/** Map a canonical turn end reason onto the harness end-reason vocabulary. */
function endReasonKindFor(
  reason: "completed" | "interrupted" | "timeout" | "aborted" | "error"
): NonNullable<HarnessTrajectory["endReason"]>["kind"] {
  switch (reason) {
    case "completed":
      return "completed";
    case "timeout":
      return "timeout";
    case "interrupted":
    case "aborted":
      return "aborted";
    case "error":
      return "exit_error";
    default: {
      const exhausted: never = reason;
      throw new Error(`unsupported turn end reason: ${String(exhausted)}`);
    }
  }
}

/**
 * Fold the canonical event stream into a candidate result *and* a step-level
 * trajectory. The trajectory (not the transcript) is what the judge/fuse step
 * consumes, so reasoning, tool calls, tool results/observations, and the final
 * assistant output are each emitted as a `TrajectoryStep`.
 */
function foldEvents(events: readonly HarnessEvent[]): FoldedTurn {
  const assistant: string[] = [];
  const steps: TrajectoryStep[] = [];
  let toolCount = 0;
  let status: HarnessCandidateOutput["status"] = "failed";
  let endReason: HarnessTrajectory["endReason"];
  let error: FoldedTurn["error"] | undefined;
  const push = (step: Omit<TrajectoryStep, "index">): void => {
    steps.push({ index: steps.length, ...step });
  };
  for (const event of events) {
    switch (event.type) {
      case "content.delta":
        if (event.stream === "assistant_text") {
          assistant.push(event.text);
        } else if (event.stream === "reasoning_text" && event.text.length > 0) {
          push({ type: "reasoning", text: truncate(event.text, MAX_STEP_TEXT) });
        }
        break;
      case "tool.call":
        toolCount += 1;
        push({
          type: "tool_call",
          tool_name: event.name,
          ...(event.requestId !== undefined ? { tool_call_id: event.requestId } : {}),
          ...(event.input !== undefined
            ? { tool_input: truncate(JSON.stringify(event.input), MAX_TOOL_INPUT) }
            : {})
        });
        break;
      case "tool.result":
        push({
          type: "observation",
          tool_name: event.name,
          ...(event.requestId !== undefined ? { tool_call_id: event.requestId } : {}),
          ...(event.output !== undefined
            ? { text: truncate(JSON.stringify(event.output), MAX_STEP_TEXT) }
            : {}),
          is_error: event.isError
        });
        break;
      case "item.completed":
        // Drivers whose protocol reports tool activity as items (codex,
        // cursor, opencode) rather than tool.call/result events surface it as
        // an observation step here.
        if (event.itemType !== "assistant_message" && event.itemType !== "reasoning") {
          toolCount += 1;
          push({
            type: "observation",
            ...(event.detail !== undefined ? { text: truncate(event.detail, MAX_STEP_TEXT) } : {}),
            is_error: event.status === "failed"
          });
        }
        break;
      case "turn.completed":
        status = event.endReason === "completed" ? "succeeded" : "failed";
        endReason = { kind: endReasonKindFor(event.endReason) };
        break;
      case "turn.failed":
        status = "failed";
        endReason = { kind: "exit_error", detail: event.message };
        error = { message: event.message, code: event.errorCode };
        break;
      default:
        break;
    }
  }
  const finalOutput = assistant.join("");
  if (finalOutput.length > 0) push({ type: "output", text: truncate(finalOutput, MAX_STEP_TEXT) });
  return {
    status,
    finalOutput,
    toolCount,
    steps,
    endReason,
    ...(error !== undefined ? { error } : {})
  };
}

function staleResume(folded: FoldedTurn): boolean {
  if (folded.status !== "failed" || folded.error === undefined) return false;
  const stale =
    /(?:no (?:conversation|session|thread) found|(?:conversation|session|thread).*(?:not found|does not exist))/i;
  return stale.test(folded.error.message);
}

export function createDriverHarness<Config>(
  options: DriverHarnessOptions<Config>
): HarnessAdapter {
  const harnessKind: ModelFusionHarnessKind = toModelFusionHarnessKind(options.driver.kind);
  const approvalPolicy = options.approvalPolicy ?? DEFAULT_AUTOMATION_APPROVAL_POLICY;
  const routeFor = (modelId: string, model: string): DriverModelRoute => {
    const endpointUrl = options.modelEndpoints?.[modelId];
    return endpointUrl !== undefined
      ? { modelId, model: modelId, endpointUrl }
      : { modelId, model, endpointUrl: options.gatewayUrl };
  };
  return {
    id: options.driver.kind,
    harnessKind,
    // Instances are created per candidate in run() (each model routes to its
    // own endpoint), and native resume carries continuity across turns, so
    // there is no shared prepared state to build here.
    prepare: () => ({}),
    capabilities: (): HarnessCapabilities => ({
      workspace_read: "supported",
      workspace_write: "supported",
      tool_call_loop: "supported",
      tool_records: "supported",
      route_model_observation: "supported"
    }),
    verificationProfile: () => ({
      id: `${options.driver.kind}-driver-verification`,
      requiredEvidence: ["driver transcript", "turn end reason", "worktree diff or skip reason"]
    }),
    run: async (input: HarnessRunInput): Promise<HarnessCandidateOutput> => {
      const { descriptor, model, ordinal, worktree, signal } = input;
      const candidateId = `${descriptor.id}_${model.id}_${ordinal}`;
      // No silent process.cwd() fallback: a missing worktree AND workspace would
      // otherwise run the driver in the user's real checkout. Hard error instead.
      const cwd = worktree?.path ?? descriptor.workspace;
      if (cwd === undefined) {
        throw new Error(
          `${options.driver.kind} driver harness for panel model "${model.id}" has no worktree and no ` +
            "descriptor.workspace; set descriptor.workspace (or enable worktree isolation) so candidates " +
            "never run in the current directory"
        );
      }
      const tracer = traceCandidate(
        {
          ...(options.trace !== undefined ? { trace: options.trace } : {}),
          ...(options.turn !== undefined ? { turn: options.turn } : {})
        },
        {
          candidateId,
          modelId: model.id,
          model: model.model,
          ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {})
        }
      );

      const route = routeFor(model.id, model.model);
      const instance = await options.driver.createInstance(
        options.configForModel(route),
        options.context
      );
      const resume = options.resumeCursors?.get(model.id);
      let folded: FoldedTurn;
      try {
        const runSession = async (cursor: ResumeCursor | undefined): Promise<FoldedTurn> => {
          const events: HarnessEvent[] = [];
          const session = await instance.startSession({
            cwd,
            approvalPolicy,
            model: route.model,
            ...(options.reasoning !== undefined
              ? { reasoning: options.reasoning }
              : {}),
            ...(cursor !== undefined ? { resume: cursor } : {})
          });
          try {
            for await (const event of session.sendTurn({
              prompt: descriptor.prompt,
              ...(options.reasoning !== undefined
                ? { reasoning: options.reasoning }
                : {}),
              ...(signal !== undefined ? { signal } : {})
            })) {
              events.push(event);
            }
          } finally {
            const nextCursor = session.resumeCursor();
            if (nextCursor !== undefined) options.resumeCursors?.set(model.id, nextCursor);
            await session.stop().catch(() => undefined);
          }
          return foldEvents(events);
        };
        folded = await runSession(resume);
        if (resume !== undefined && staleResume(folded)) {
          // Managed panel worktrees are disposable. Some native CLIs scope
          // persisted sessions to the original worktree and reject the cursor
          // after cleanup. The front door already supplied the full
          // conversation in descriptor.prompt, so fall back to a fresh native
          // session instead of failing an otherwise valid follow-up turn.
          options.resumeCursors?.delete(model.id);
          folded = await runSession(undefined);
        }
      } finally {
        await instance.dispose().catch(() => undefined);
      }

      // Add-then-diff against the base so untracked/new files count; `has_diff`
      // no longer reports a false negative for a candidate that only created
      // files. Empty diff normalizes back to undefined for the callers below.
      const base = worktree?.baseGitSha || descriptor.baseGitSha || "HEAD";
      const rawDiff = diffWorkspace(cwd, base);
      const diff = rawDiff.length > 0 ? rawDiff : undefined;
      const transcript = folded.finalOutput.length > 0 ? folded.finalOutput : `(${options.driver.kind} produced no text)`;
      const outputHash = artifactHash(transcript);
      for (const step of folded.steps) tracer.step(step);
      tracer.finished({
        status: folded.status,
        steps: folded.steps,
        finalOutput: folded.finalOutput
      });
      // The reconstructed trajectory (steps) is the fusion panel's product; a
      // candidate without one is treated as failed by the fuse step, so it is
      // always attached when the turn produced any steps.
      const trajectory: HarnessTrajectory | undefined =
        folded.steps.length > 0
          ? {
              trajectoryId: candidateId,
              modelId: model.id,
              model: model.model,
              candidateId,
              harnessKind,
              status: folded.status,
              steps: folded.steps,
              finalOutput: folded.finalOutput.length > 0 ? folded.finalOutput : transcript,
              ...(diff !== undefined ? { diff } : {}),
              ...(folded.endReason !== undefined ? { endReason: folded.endReason } : {})
            }
          : undefined;
      return {
        candidateId,
        model,
        status: folded.status,
        ...(folded.endReason !== undefined ? { endReason: folded.endReason } : {}),
        ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {}),
        ...(trajectory !== undefined ? { trajectory } : {}),
        transcript,
        log: transcript,
        ...(diff !== undefined ? { diff } : {}),
        artifacts: [
          {
            artifact_id: `artifact_${candidateId}_${options.driver.kind}_transcript`,
            kind: "transcript",
            hash: outputHash,
            redaction_status: "synthetic"
          }
        ],
        toolRecords: [
          {
            execution_id: `exec_${candidateId}_${options.driver.kind}`,
            plan_id: `plan_${candidateId}_${options.driver.kind}`,
            status: folded.status,
            output_hash: outputHash,
            ...(folded.error !== undefined
              ? {
                  error: {
                    kind: mapErrorKind(folded.error.code),
                    message: folded.error.message,
                    retryable: false
                  }
                }
              : {})
          }
        ],
        ...(folded.error !== undefined
          ? {
              error: {
                kind: mapErrorKind(folded.error.code),
                message: folded.error.message,
                retryable: false
              }
            }
          : {}),
        metadata: {
          adapter: options.driver.kind,
          tool_events: folded.toolCount,
          has_diff: diff !== undefined && diff.length > 0
        } satisfies Record<string, JsonValue>
      };
    },
    collectArtifacts: () => []
  };
}

const HARNESS_ERROR_CODE_SET: ReadonlySet<string> = new Set<HarnessErrorCode>([
  "not_installed",
  "not_authenticated",
  "version_unsupported",
  "invalid_config",
  "session_closed",
  "protocol_parse",
  "timeout",
  "aborted",
  "provider_error"
]);

/** The wire error kind for a fusion candidate record, from a harness error code. */
function mapErrorKind(code: string): ModelFusionErrorKind {
  const knownCode: HarnessErrorCode = HARNESS_ERROR_CODE_SET.has(code)
    ? (code as HarnessErrorCode)
    : "provider_error";
  return toModelFusionErrorKind(new HarnessError(knownCode, code));
}

/** A driver registered for panel use, keyed by its kind. */
export type PanelDriver = AnyHarnessDriver;
