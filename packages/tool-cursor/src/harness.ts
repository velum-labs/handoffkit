import { artifactHash } from "@routekit/contracts";
import type { JsonValue } from "@routekit/contracts";

import { resolveCursorkitCli } from "@fusionkit/ensemble";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessAdapter,
  HarnessCandidateOutput
} from "@fusionkit/ensemble";

import { traceCandidate } from "@fusionkit/ensemble";
import type { FusionTraceCarrier } from "@fusionkit/ensemble";
import {
  buildChildEnv,
  captureWorktreeDiff,
  commandOnPath,
  definedEnv,
  reservePort,
  runCliCapture,
  spawnLogged,
  terminate,
  waitForOutput
} from "@routekit/runtime";
import type { CliCaptureResult } from "@routekit/runtime";

import { createCursorStreamStepEmitter, parseCursorStreamJson } from "./stream-trajectory.js";
import {
  CURSOR_BRIDGE_MODEL_NAME,
  FUSION_PANEL_MODEL,
  buildSkippedCandidate,
} from "@fusionkit/tools";

import {
  CURSOR_AGENT_TOOL_MAX_ITERATIONS,
  CURSOR_AGENT_TOOL_POLICY,
  cursorBridgeEnv
} from "./bridge-config.js";

const DEFAULT_CURSOR_COMMAND = "cursor-agent";
const DEFAULT_BRIDGE_MODEL_NAME = CURSOR_BRIDGE_MODEL_NAME;
const DEFAULT_BRIDGE_PROVIDER_MODEL = FUSION_PANEL_MODEL;
const BRIDGE_START_TIMEOUT_MS = 20_000;

export type CursorRunMode = "ask" | "agent";

export type CursorExecInput = {
  prompt: string;
  cwd: string;
  fusionBackendUrl: string;
  apiKey?: string;
  model: EnsembleModel;
  command: string;
  modelName: string;
  providerModel: string;
  mode: CursorRunMode;
  timeoutMs?: number;
  env: Record<string, string>;
  onStdoutLine?: (line: string) => void;
  /**
   * Aborts the bridge and cursor-agent child processes (panel cancellation /
   * straggler policy). The abort reason's message is surfaced as `reason`.
   */
  signal?: AbortSignal;
};

export type CursorExecResult = {
  status: "succeeded" | "failed";
  transcript: string;
  diff?: string;
  toolEvents: number;
  exitCode?: number;
  reason?: string;
};

export type CursorExecRunner = (
  input: CursorExecInput
) => Promise<CursorExecResult> | CursorExecResult;

export type CursorHarnessOptions = {
  id?: string;
  command?: string;
  fusionBackendUrl?: string;
  apiKey?: string;
  modelName?: string;
  providerModel?: string;
  mode?: CursorRunMode;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  runner?: CursorExecRunner;
  skipWhenUnavailable?: boolean;
  /**
   * Per-model router endpoints keyed by `EnsembleModel.id`. When a candidate's
   * model id is present, the Cursorkit bridge is pointed at that endpoint and
   * routes the endpoint id as its provider model (so the router routes to this
   * panel member).
   */
  modelEndpoints?: Record<string, string>;
  /** Trace carrier of the enclosing run/turn; candidates span under it. */
  trace?: FusionTraceCarrier;
  turn?: number;
};

type CursorAvailability =
  | { available: true; command: string }
  | { available: false; reason: string };

type PreparedCursorHarness = {
  env: Record<string, string>;
  availability: CursorAvailability;
};

function resolveAvailability(
  options: CursorHarnessOptions,
  env: Record<string, string>
): CursorAvailability {
  const command = options.command ?? DEFAULT_CURSOR_COMMAND;
  if (options.runner !== undefined) {
    return { available: true, command };
  }
  // Cursorkit ships as a bundled dependency, so only the Cursor CLI itself is a
  // runtime prerequisite.
  if (!commandOnPath(command, env)) {
    return {
      available: false,
      reason: `Cursor CLI "${command}" was not found on PATH; install the Cursor CLI (https://cursor.com/cli) and log in.`
    };
  }
  return { available: true, command };
}

export function cursorHarnessUnavailableReason(
  env: Record<string, string | undefined> = process.env,
  options: Pick<CursorHarnessOptions, "command"> = {}
): string | undefined {
  const availability = resolveAvailability(options, definedEnv(env));
  return availability.available ? undefined : availability.reason;
}

function modeFor(
  descriptor: EnsembleDescriptor,
  override: CursorRunMode | undefined
): CursorRunMode {
  if (override !== undefined) return override;
  switch (descriptor.policy.sideEffects) {
    case "none":
    case "read_only":
      return "ask";
    case "writes_workspace":
    case "network":
    case "tool_execution":
    case "unknown":
      return "agent";
    default: {
      const exhausted: never = descriptor.policy.sideEffects;
      throw new Error(`unsupported side effects policy: ${String(exhausted)}`);
    }
  }
}

function skippedCandidate(input: {
  descriptor: EnsembleDescriptor;
  model: EnsembleModel;
  ordinal: number;
  reason: string;
}): HarnessCandidateOutput {
  return buildSkippedCandidate({
    ...input,
    adapter: "cursor",
    transcript: `Cursor adapter skipped: ${input.reason}`
  });
}

/**
 * Drives the real cursor-agent CLI in ACP mode against a freshly spawned
 * Cursorkit bridge whose local-model backend points at the fusion gateway.
 * The bridge runs with BRIDGE_AGENT_TOOL_POLICY=all so Cursor can read, edit
 * (apply_patch/write_file), and run shell commands inside the worktree.
 */
export async function defaultCursorRunner(
  input: CursorExecInput
): Promise<CursorExecResult> {
  // Hold a real free loopback port until the bridge is about to bind it, so
  // parallel candidates cannot collide on (or steal) the same bridge port.
  const reservation = await reservePort();
  const bridgePort = reservation.port;
  const bridgeEnv = cursorBridgeEnv({
    baseEnv: input.env,
    port: bridgePort,
    gatewayUrl: input.fusionBackendUrl,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    modelName: input.modelName,
    providerModel: input.providerModel
  });
  Object.assign(bridgeEnv, {
    BRIDGE_AGENT_TOOL_POLICY: CURSOR_AGENT_TOOL_POLICY,
    BRIDGE_AGENT_TOOL_MAX_ITERATIONS: String(CURSOR_AGENT_TOOL_MAX_ITERATIONS)
  });

  const { serveCli } = resolveCursorkitCli();
  await reservation.release();
  const bridge = spawnLogged(process.execPath, [serveCli, "serve"], {
    cwd: input.cwd,
    env: bridgeEnv
  });

  const timeoutMs = input.timeoutMs ?? 180_000;
  // Abort must also tear down the bridge, not just cursor-agent: a candidate
  // dropped by the straggler policy may still be waiting on bridge startup.
  const onAbort = (): void => terminate(bridge.child);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (input.signal?.aborted === true) {
      return {
        status: "failed",
        transcript: "",
        toolEvents: 0,
        reason: abortReasonText(input.signal)
      };
    }
    try {
      await waitForOutput(bridge, /bridge listening/, {
        timeoutMs: BRIDGE_START_TIMEOUT_MS,
        label: "Cursorkit bridge"
      });
    } catch (error) {
      return {
        status: "failed",
        transcript: bridge.log(),
        toolEvents: 0,
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    const printResult = await driveCursorAgentPrint({
      command: input.command,
      bridgePort,
      modelName: input.modelName,
      mode: input.mode,
      cwd: input.cwd,
      prompt: input.prompt,
      timeoutMs,
      env: input.env,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.onStdoutLine !== undefined ? { onStdoutLine: input.onStdoutLine } : {})
    });

    const diff = captureWorktreeDiff(input.cwd);
    return {
      status: printResult.status,
      transcript: printResult.transcript,
      toolEvents: diff !== undefined && diff.length > 0 ? 1 : 0,
      ...(printResult.exitCode !== undefined ? { exitCode: printResult.exitCode } : {}),
      ...(diff !== undefined ? { diff } : {}),
      ...(printResult.reason !== undefined ? { reason: printResult.reason } : {})
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    // Tear down the whole bridge process group (serve may spawn children),
    // escalating to SIGKILL if it ignores the grace period.
    terminate(bridge.child);
    bridge.closeLog();
  }
}

function abortReasonText(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (reason !== undefined && reason !== null) return String(reason);
  return "aborted";
}

type PrintResult = {
  status: "succeeded" | "failed";
  transcript: string;
  exitCode?: number;
  reason?: string;
};

/**
 * Drives cursor-agent in headless print mode (`-p`), which "has access to all
 * tools, including write and shell". The bridge runs the Cursor tool loop over
 * the SSE/BidiAppend transport, so the agent can read, apply_patch/write, and
 * run shell inside the worktree. `--trust` skips the workspace-trust prompt and
 * `--force` auto-approves tool actions. For read-only tasks we pass `--mode ask`.
 *
 * Output is requested as `stream-json` so we can (a) reconstruct the native
 * trajectory from the structured events (see {@link parseCursorStreamJson}) and
 * (b) read the terminal `result` event's `is_error` as the authoritative success
 * signal — the process exit code is unreliable through the bridge. The raw
 * JSON-lines stdout is returned as the transcript for the harness to parse.
 */
async function driveCursorAgentPrint(input: {
  command: string;
  bridgePort: number;
  modelName: string;
  mode: CursorRunMode;
  cwd: string;
  prompt: string;
  timeoutMs: number;
  env: Record<string, string>;
  onStdoutLine?: (line: string) => void;
  signal?: AbortSignal;
}): Promise<PrintResult> {
  // The prompt travels via stdin (`cursor-agent -p` reads piped input): argv
  // would cap the prompt size and expose it in `ps`.
  const args = [
    "-p",
    "--force",
    "--trust",
    "--output-format",
    "stream-json",
    "--model",
    input.modelName,
    "--endpoint",
    `http://127.0.0.1:${input.bridgePort}`
  ];
  if (input.mode === "ask") {
    args.push("--mode", "ask");
  }

  let result: CliCaptureResult;
  try {
    result = await runCliCapture(input.command, args, {
      cwd: input.cwd,
      // Allowlisted child env: baseline system vars plus cursor-agent's own
      // CURSOR_* config/login state — never the parent's full environment.
      env: buildChildEnv({ base: input.env, allow: [/^CURSOR_/] }),
      timeoutMs: input.timeoutMs,
      stdin: input.prompt,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.onStdoutLine !== undefined ? { onStdoutLine: input.onStdoutLine } : {})
    });
  } catch (error) {
    return {
      status: "failed",
      transcript: "",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  if (result.timedOut) {
    return { status: "failed", transcript: result.stdout, reason: "cursor-agent timed out" };
  }
  if (result.aborted) {
    return {
      status: "failed",
      transcript: result.stdout,
      reason: result.abortReason ?? "aborted"
    };
  }
  // Prefer the structured terminal `result` event over the exit code: the
  // bridge can exit non-zero even after a clean, completed answer.
  const parsed = parseCursorStreamJson(result.stdout);
  const status: PrintResult["status"] = parsed.sawResult
    ? parsed.isError
      ? "failed"
      : "succeeded"
    : result.exitCode === 0
      ? "succeeded"
      : "failed";
  return {
    status,
    transcript: result.stdout,
    exitCode: result.exitCode,
    ...(status === "failed"
      ? {
          // Never an empty string: the protocol schema rejects empty
          // error.message, and a killed cursor-agent can leave stderr blank.
          reason: parsed.isError
            ? parsed.finalOutput || "cursor-agent reported an error"
            : result.stderr.trim().slice(0, 500) ||
              `cursor-agent exited with code ${result.exitCode}`
        }
      : {})
  };
}

export function createCursorHarness(
  options: CursorHarnessOptions = {}
): HarnessAdapter {
  const id = options.id ?? "cursor";
  const runner = options.runner ?? defaultCursorRunner;
  const skipWhenUnavailable = options.skipWhenUnavailable ?? true;
  return {
    id,
    harnessKind: "cursor",
    prepare: (): PreparedCursorHarness => {
      const env = definedEnv(options.env ?? process.env);
      return { env, availability: resolveAvailability(options, env) };
    },
    capabilities: () => {
      const env = definedEnv(options.env ?? process.env);
      const available = resolveAvailability(options, env).available;
      const status = available ? "supported" : "degraded";
      return {
        workspace_read: status,
        workspace_write: status,
        apply_patch: status,
        tool_call_loop: status,
        tool_records: status,
        route_observation: "supported",
        adapter_available: available ? "supported" : "unsupported"
      };
    },
    verificationProfile: () => ({
      id: `${id}-verification`,
      requiredEvidence: [
        "cursor-agent transcript",
        "session status",
        "worktree diff or skip reason"
      ]
    }),
    run: async ({ descriptor, model, ordinal, prepared, worktree, signal }) => {
      const state = prepared as PreparedCursorHarness;
      if (!state.availability.available) {
        if (!skipWhenUnavailable) {
          throw new Error(state.availability.reason);
        }
        return skippedCandidate({
          descriptor,
          model,
          ordinal,
          reason: state.availability.reason
        });
      }

      // Per-model routing: a configured endpoint for this model id points the
      // bridge at that endpoint and routes the endpoint id as the provider model.
      const endpointUrl = options.modelEndpoints?.[model.id];
      const fusionBackendUrl =
        endpointUrl ?? options.fusionBackendUrl ?? state.env.FUSIONKIT_BASE_URL;
      if (fusionBackendUrl === undefined || fusionBackendUrl.length === 0) {
        return skippedCandidate({
          descriptor,
          model,
          ordinal,
          reason:
            "Fusion backend URL is not configured for the Cursor harness."
        });
      }

      const candidateId = `${descriptor.id}_${model.id}_${ordinal}`;
      // Emit per-candidate trace events so the companion app shows this
      // candidate's trajectory live (started now, finished when the run completes).
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

      const cwd = worktree?.path ?? descriptor.workspace ?? process.cwd();
      let result: CursorExecResult;
      const emitStep = createCursorStreamStepEmitter((step) => tracer.step(step));
      try {
        result = await runner({
          prompt: descriptor.prompt,
          cwd,
          fusionBackendUrl,
          ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
          model,
          command: state.availability.command,
          modelName: options.modelName ?? DEFAULT_BRIDGE_MODEL_NAME,
          providerModel:
            endpointUrl !== undefined
              ? model.id
              : options.providerModel ?? model.model ?? DEFAULT_BRIDGE_PROVIDER_MODEL,
          mode: modeFor(descriptor, options.mode),
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : descriptor.policy.timeoutMs !== undefined
              ? { timeoutMs: descriptor.policy.timeoutMs }
              : {}),
          env: state.env,
          onStdoutLine: emitStep,
          ...(signal !== undefined ? { signal } : {})
        });
      } catch (error) {
        tracer.finished({ status: "failed", steps: [], finishReason: "error" });
        return skippedCandidate({
          descriptor,
          model,
          ordinal,
          reason: error instanceof Error ? error.message : String(error)
        });
      }

      const transcript = result.transcript;
      const outputHash = artifactHash(
        transcript.length > 0 ? transcript : `cursor:${descriptor.id}`
      );
      const status: HarnessCandidateOutput["status"] = result.status;
      // Reconstruct the native trajectory from cursor-agent's stream-json stdout
      // so the candidate can be fused (the fusion panel's product is the
      // trajectory, not the patch). Without steps there is no usable candidate.
      const reconstructed = parseCursorStreamJson(transcript);
      const trajectory =
        reconstructed.steps.length > 0
          ? {
              trajectoryId: candidateId,
              modelId: model.id,
              model: model.model,
              candidateId,
              harnessKind: "cursor" as const,
              status,
              steps: reconstructed.steps,
              finalOutput:
                reconstructed.finalOutput.length > 0 ? reconstructed.finalOutput : transcript,
              ...(result.diff !== undefined && result.diff.length > 0 ? { diff: result.diff } : {})
            }
          : undefined;
      const artifacts: HarnessCandidateOutput["artifacts"] = [
        {
          artifact_id: `artifact_${descriptor.id}_${model.id}_cursor_transcript`,
          kind: "transcript",
          hash: outputHash,
          redaction_status: "synthetic"
        }
      ];
      if (result.diff !== undefined && result.diff.length > 0) {
        artifacts.push({
          artifact_id: `artifact_${descriptor.id}_${model.id}_cursor_patch`,
          kind: "patch",
          hash: artifactHash(result.diff),
          redaction_status: "synthetic"
        });
      }
      tracer.finished({
        status,
        steps: reconstructed.steps,
        ...(reconstructed.finalOutput.length > 0 ? { finalOutput: reconstructed.finalOutput } : {})
      });
      return {
        candidateId,
        model,
        status,
        ...(worktree
          ? { branchName: worktree.branchName, worktreePath: worktree.path }
          : {}),
        ...(trajectory !== undefined ? { trajectory } : {}),
        transcript,
        ...(result.diff !== undefined ? { diff: result.diff } : {}),
        log: transcript,
        artifacts,
        toolRecords: [
          {
            execution_id: `exec_${candidateId}_cursor`,
            plan_id: `plan_${candidateId}_cursor`,
            status,
            output_hash: outputHash,
            ...(status === "failed"
              ? {
                  error: {
                    kind: "provider_error",
                    message: result.reason || "Cursor run failed.",
                    retryable: false
                  }
                }
              : {})
          }
        ],
        ...(status === "failed"
          ? {
              error: {
                kind: "provider_error",
                message: result.reason || "Cursor run failed.",
                retryable: false
              }
            }
          : {}),
        metadata: {
          adapter: "cursor",
          mode: modeFor(descriptor, options.mode),
          tool_events: result.toolEvents,
          has_diff: result.diff !== undefined && result.diff.length > 0
        } satisfies Record<string, JsonValue>
      };
    },
    collectArtifacts: () => [],
    cleanup: () => undefined
  };
}

export const cursorHarness = createCursorHarness;
