import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { artifactHash } from "@fusionkit/protocol";
import type { JsonValue } from "@fusionkit/protocol";

import { resolveCursorkitCli } from "@fusionkit/ensemble";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessAdapter,
  HarnessCandidateOutput
} from "@fusionkit/ensemble";

import { traceCandidate } from "@fusionkit/ensemble";

import { parseCursorStreamJson } from "./stream-trajectory.js";
import {
  CURSOR_BRIDGE_MODEL_NAME,
  FUSION_PANEL_MODEL,
  buildSkippedCandidate,
  definedEnv,
  freePort,
  normalizeApiBaseUrl,
  scrubBridgeEnv,
  spawnLogged,
  terminate,
  waitForOutput
} from "@fusionkit/tools";

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
  /** Observability correlation for per-candidate trace events. */
  traceId?: string;
  parentSpanId?: string;
  turn?: number;
};

type CursorAvailability =
  | { available: true; command: string }
  | { available: false; reason: string };

type PreparedCursorHarness = {
  env: Record<string, string>;
  availability: CursorAvailability;
};

function commandOnPath(
  command: string,
  env: Record<string, string>
): boolean {
  if (command.includes("/")) {
    return existsSync(command);
  }
  const pathValue = env.PATH ?? process.env.PATH ?? "";
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((dir) => existsSync(join(dir, command)));
}

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
  // Reserve a real free loopback port instead of a random guess so parallel
  // candidates cannot collide on the same bridge port.
  const bridgePort = await freePort();
  const bridgeEnv: Record<string, string> = scrubBridgeEnv(input.env);
  Object.assign(bridgeEnv, {
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_ROUTE_INVENTORY: "true",
    BRIDGE_AGENT_TOOL_POLICY: "all",
    BRIDGE_AGENT_TOOL_MAX_ITERATIONS: "24",
    CURSOR_UPSTREAM_BASE_URL: "https://api2.cursor.sh",
    MODEL_BASE_URL: normalizeApiBaseUrl(input.fusionBackendUrl),
    MODEL_API_KEY: input.apiKey ?? "local",
    MODEL_NAME: input.modelName,
    MODEL_PROVIDER_MODEL: input.providerModel,
    MODEL_CONTEXT_TOKEN_LIMIT: "128000"
  });

  const { serveCli } = resolveCursorkitCli();
  const bridge = spawnLogged(process.execPath, [serveCli, "serve"], {
    cwd: input.cwd,
    env: bridgeEnv
  });

  const timeoutMs = input.timeoutMs ?? 180_000;
  try {
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
      timeoutMs
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
    // Tear down the whole bridge process group (serve may spawn children),
    // escalating to SIGKILL if it ignores the grace period.
    terminate(bridge.child);
    bridge.closeLog();
  }
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
}): Promise<PrintResult> {
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
  args.push(input.prompt);

  return await new Promise<PrintResult>((resolve) => {
    const child = spawn(input.command, args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        status: "failed",
        transcript: stdout,
        reason: error instanceof Error ? error.message : String(error)
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          status: "failed",
          transcript: stdout,
          reason: "cursor-agent timed out"
        });
        return;
      }
      // Prefer the structured terminal `result` event over the exit code: the
      // bridge can exit non-zero even after a clean, completed answer.
      const parsed = parseCursorStreamJson(stdout);
      const status: PrintResult["status"] = parsed.sawResult
        ? parsed.isError
          ? "failed"
          : "succeeded"
        : code === 0
          ? "succeeded"
          : "failed";
      resolve({
        status,
        transcript: stdout,
        exitCode: code ?? 0,
        ...(status === "failed"
          ? { reason: parsed.isError ? parsed.finalOutput || "cursor-agent reported an error" : stderr.slice(0, 500) }
          : {})
      });
    });
  });
}

function captureWorktreeDiff(cwd: string): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, "diff"], { encoding: "utf8" });
    const stdout = result.stdout ?? "";
    return result.status === 0 && stdout.length > 0 ? stdout : undefined;
  } catch {
    return undefined;
  }
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
    run: async ({ descriptor, model, ordinal, prepared, worktree }) => {
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

      const cwd = worktree?.path ?? descriptor.workspace ?? process.cwd();
      let result: CursorExecResult;
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
          env: state.env
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
                    message: result.reason ?? "Cursor run failed.",
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
                message: result.reason ?? "Cursor run failed.",
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
