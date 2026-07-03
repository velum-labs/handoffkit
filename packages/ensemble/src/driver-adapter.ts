import { captureWorktreeDiff } from "@fusionkit/runtime-utils";

import { artifactHash } from "@fusionkit/protocol";
import type { JsonValue, ModelFusionErrorKind, ModelFusionHarnessKind } from "@fusionkit/protocol";
import {
  HarnessError,
  PANEL_APPROVAL_POLICY,
  toModelFusionErrorKind,
  toModelFusionHarnessKind
} from "@fusionkit/harness-core";
import type {
  AnyHarnessDriver,
  ApprovalPolicy,
  DriverContext,
  HarnessDriver,
  HarnessErrorCode,
  HarnessEvent,
  HarnessInstance,
  ResumeCursor
} from "@fusionkit/harness-core";

import { traceCandidate } from "./candidate-trace.js";
import type {
  EnsembleDescriptor,
  HarnessAdapter,
  HarnessCandidateOutput,
  HarnessCapabilities,
  HarnessRunInput
} from "./harness.js";

/**
 * Bridge a harness-core {@link HarnessDriver} into the ensemble panel's
 * {@link HarnessAdapter}: one driver instance per panel, one native session
 * per candidate (in its worktree), streaming canonical {@link HarnessEvent}s
 * that are folded into a candidate output. This is the supported path for the
 * panel to consume the driver architecture; each turn advances the driver's
 * own session so multi-turn front-door runs reuse native resume.
 */
export type DriverHarnessOptions<Config> = {
  driver: HarnessDriver<Config>;
  /** Base config; per-candidate model is overlaid from the ensemble model. */
  config: Config;
  /** Env/status-cache context for probes and child allowlists. */
  context?: DriverContext;
  /** Panel default is autoApprove:all (headless, disposable worktrees). */
  approvalPolicy?: ApprovalPolicy;
  /** Resume cursors keyed by candidate id, for multi-turn continuation. */
  resumeCursors?: Map<string, ResumeCursor>;
  traceId?: string;
  parentSpanId?: string;
  turn?: number;
};

type PreparedDriverHarness = {
  instance: HarnessInstance;
};

type FoldedTurn = {
  status: HarnessCandidateOutput["status"];
  finalOutput: string;
  toolCount: number;
  error?: { message: string; code: string };
};

function foldEvents(events: readonly HarnessEvent[]): FoldedTurn {
  const assistant: string[] = [];
  let toolCount = 0;
  let status: HarnessCandidateOutput["status"] = "failed";
  let error: FoldedTurn["error"] | undefined;
  for (const event of events) {
    switch (event.type) {
      case "content.delta":
        if (event.stream === "assistant_text") assistant.push(event.text);
        break;
      case "tool.call":
      case "item.completed":
        if (event.type === "tool.call" || event.itemType !== "assistant_message") toolCount += 1;
        break;
      case "turn.completed":
        status = event.endReason === "completed" ? "succeeded" : "failed";
        break;
      case "turn.failed":
        status = "failed";
        error = { message: event.message, code: event.errorCode };
        break;
      default:
        break;
    }
  }
  return {
    status,
    finalOutput: assistant.join(""),
    toolCount,
    ...(error !== undefined ? { error } : {})
  };
}

export function createDriverHarness<Config>(
  options: DriverHarnessOptions<Config>
): HarnessAdapter {
  const harnessKind: ModelFusionHarnessKind = toModelFusionHarnessKind(options.driver.kind);
  const approvalPolicy = options.approvalPolicy ?? PANEL_APPROVAL_POLICY;
  return {
    id: options.driver.kind,
    harnessKind,
    prepare: async (): Promise<PreparedDriverHarness> => ({
      instance: await options.driver.createInstance(options.config, options.context)
    }),
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
      const { descriptor, model, ordinal, worktree, prepared, signal } = input;
      const state = prepared as PreparedDriverHarness;
      const candidateId = `${descriptor.id}_${model.id}_${ordinal}`;
      const cwd = worktree?.path ?? descriptor.workspace ?? process.cwd();
      const tracer = traceCandidate(
        {
          ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
          ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
          ...(options.turn !== undefined ? { turn: options.turn } : {})
        },
        {
          candidateId,
          modelId: model.id,
          model: model.model,
          ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {})
        }
      );

      const resume = options.resumeCursors?.get(candidateId);
      const session = await state.instance.startSession({
        cwd,
        approvalPolicy,
        ...(model.model !== undefined ? { model: model.model } : {}),
        ...(resume !== undefined ? { resume } : {})
      });
      const events: HarnessEvent[] = [];
      try {
        for await (const event of session.sendTurn({
          prompt: descriptor.prompt,
          ...(signal !== undefined ? { signal } : {})
        })) {
          events.push(event);
        }
      } finally {
        options.resumeCursors?.set(candidateId, session.resumeCursor() ?? options.resumeCursors.get(candidateId) ?? { version: 1, kind: options.driver.kind, data: {} });
        await session.stop().catch(() => undefined);
      }

      const folded = foldEvents(events);
      const diff = captureWorktreeDiff(cwd);
      const transcript = folded.finalOutput.length > 0 ? folded.finalOutput : `(${options.driver.kind} produced no text)`;
      const outputHash = artifactHash(transcript);
      tracer.finished({
        status: folded.status,
        steps: [],
        finalOutput: folded.finalOutput
      });
      return {
        candidateId,
        model,
        status: folded.status,
        ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {}),
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
    collectArtifacts: () => [],
    cleanup: async ({ prepared }) => {
      const state = prepared as PreparedDriverHarness | undefined;
      await state?.instance.dispose().catch(() => undefined);
    }
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
