import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { artifactHash } from "@fusionkit/protocol";
import type { JsonValue } from "@fusionkit/protocol";

import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessAdapter,
  HarnessCandidateOutput
} from "./harness.js";

const DEFAULT_CURSOR_COMMAND = "cursor-agent";
const DEFAULT_BRIDGE_MODEL_NAME = "local-fusion";
const DEFAULT_BRIDGE_PROVIDER_MODEL = "fusion-panel";
const BRIDGE_START_TIMEOUT_MS = 20_000;

export type CursorRunMode = "ask" | "agent";

export type CursorExecInput = {
  prompt: string;
  cwd: string;
  fusionBackendUrl: string;
  apiKey?: string;
  model: EnsembleModel;
  cursorKitDir: string;
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
  cursorKitDir?: string;
  fusionBackendUrl?: string;
  apiKey?: string;
  modelName?: string;
  providerModel?: string;
  mode?: CursorRunMode;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  runner?: CursorExecRunner;
  skipWhenUnavailable?: boolean;
};

type CursorAvailability =
  | { available: true; cursorKitDir: string; command: string }
  | { available: false; reason: string };

type PreparedCursorHarness = {
  env: Record<string, string>;
  availability: CursorAvailability;
};

function definedEnv(
  env: Record<string, string | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function normalizeModelBaseUrl(fusionBackendUrl: string): string {
  const trimmed = fusionBackendUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

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

function resolveCursorKitDir(
  options: CursorHarnessOptions,
  env: Record<string, string>
): string | undefined {
  return (
    options.cursorKitDir ??
    env.WARRANT_CURSORKIT_DIR ??
    env.FUSIONKIT_CURSORKIT_DIR
  );
}

function resolveAvailability(
  options: CursorHarnessOptions,
  env: Record<string, string>
): CursorAvailability {
  const command = options.command ?? DEFAULT_CURSOR_COMMAND;
  if (options.runner !== undefined) {
    return {
      available: true,
      cursorKitDir: resolveCursorKitDir(options, env) ?? ".",
      command
    };
  }
  const cursorKitDir = resolveCursorKitDir(options, env);
  if (cursorKitDir === undefined) {
    return {
      available: false,
      reason:
        "Cursorkit checkout is not configured; set WARRANT_CURSORKIT_DIR or pass cursorKitDir."
    };
  }
  if (!existsSync(join(cursorKitDir, "dist/src/cli.js"))) {
    return {
      available: false,
      reason: `Cursorkit bridge build was not found at ${join(cursorKitDir, "dist/src/cli.js")}; run pnpm build in the Cursorkit checkout.`
    };
  }
  if (!commandOnPath(command, env)) {
    return {
      available: false,
      reason: `Cursor CLI "${command}" was not found on PATH; install the Cursor CLI (https://cursor.com/cli) and log in.`
    };
  }
  return { available: true, cursorKitDir, command };
}

export function cursorHarnessUnavailableReason(
  env: Record<string, string | undefined> = process.env,
  options: Pick<CursorHarnessOptions, "command" | "cursorKitDir"> = {}
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
  const transcript = `Cursor adapter skipped: ${input.reason}`;
  const hash = artifactHash(transcript);
  return {
    candidateId: `${input.descriptor.id}_${input.model.id}_${input.ordinal}`,
    model: input.model,
    status: "skipped",
    transcript,
    log: transcript,
    artifacts: [
      {
        artifact_id: `artifact_${input.descriptor.id}_${input.model.id}_cursor_skip`,
        kind: "log",
        hash,
        redaction_status: "synthetic"
      }
    ],
    verification: {
      status: "skipped",
      evidence: [input.reason]
    },
    error: {
      kind: "capability_missing",
      message: input.reason,
      retryable: false
    },
    metadata: {
      adapter: "cursor",
      skip_reason: input.reason
    }
  };
}

/**
 * Drives the real cursor-agent CLI in ACP mode against a freshly spawned
 * Cursorkit bridge whose local-model backend points at the fusion gateway.
 * The bridge runs with BRIDGE_AGENT_TOOL_POLICY=all so Cursor can read, edit
 * (apply_patch/write_file), and run shell commands inside the worktree.
 */
async function defaultCursorRunner(
  input: CursorExecInput
): Promise<CursorExecResult> {
  const bridgePort = 9700 + Math.floor(Math.random() * 250);
  const bridgeEnv: Record<string, string> = { ...input.env };
  for (const key of Object.keys(bridgeEnv)) {
    if (
      key.startsWith("BRIDGE_") ||
      key.startsWith("MODEL_") ||
      key.startsWith("CURSOR_UPSTREAM")
    ) {
      delete bridgeEnv[key];
    }
  }
  Object.assign(bridgeEnv, {
    BRIDGE_PORT: String(bridgePort),
    BRIDGE_ROUTE_INVENTORY: "true",
    BRIDGE_AGENT_TOOL_POLICY: "all",
    BRIDGE_AGENT_TOOL_MAX_ITERATIONS: "24",
    CURSOR_UPSTREAM_BASE_URL: "https://api2.cursor.sh",
    MODEL_BASE_URL: normalizeModelBaseUrl(input.fusionBackendUrl),
    MODEL_API_KEY: input.apiKey ?? "local",
    MODEL_NAME: input.modelName,
    MODEL_PROVIDER_MODEL: input.providerModel,
    MODEL_CONTEXT_TOKEN_LIMIT: "128000"
  });

  let bridgeOut = "";
  const bridge = spawn(process.execPath, ["dist/src/cli.js", "serve"], {
    cwd: input.cursorKitDir,
    env: bridgeEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  bridge.stdout.on("data", (chunk: Buffer) => {
    bridgeOut += chunk.toString("utf8");
  });
  bridge.stderr.on("data", (chunk: Buffer) => {
    bridgeOut += chunk.toString("utf8");
  });

  const timeoutMs = input.timeoutMs ?? 180_000;
  try {
    const deadline = Date.now() + BRIDGE_START_TIMEOUT_MS;
    while (!/bridge listening/.test(bridgeOut) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!/bridge listening/.test(bridgeOut)) {
      return {
        status: "failed",
        transcript: bridgeOut,
        toolEvents: 0,
        reason: "Cursorkit bridge did not start in time."
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
    bridge.kill("SIGTERM");
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
    "text",
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
      const transcript = [stdout, stderr].filter(Boolean).join("\n");
      if (timedOut) {
        resolve({
          status: "failed",
          transcript,
          reason: "cursor-agent timed out"
        });
        return;
      }
      resolve({
        status: code === 0 ? "succeeded" : "failed",
        transcript,
        exitCode: code ?? 0,
        ...(code === 0 ? {} : { reason: stderr.slice(0, 500) })
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
        verification: status,
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

      const fusionBackendUrl =
        options.fusionBackendUrl ?? state.env.FUSIONKIT_BASE_URL;
      if (fusionBackendUrl === undefined || fusionBackendUrl.length === 0) {
        return skippedCandidate({
          descriptor,
          model,
          ordinal,
          reason:
            "Fusion backend URL is not configured for the Cursor harness."
        });
      }

      const cwd = worktree?.path ?? descriptor.workspace ?? process.cwd();
      let result: CursorExecResult;
      try {
        result = await runner({
          prompt: descriptor.prompt,
          cwd,
          fusionBackendUrl,
          ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
          model,
          cursorKitDir: state.availability.cursorKitDir,
          command: state.availability.command,
          modelName: options.modelName ?? DEFAULT_BRIDGE_MODEL_NAME,
          providerModel:
            options.providerModel ?? model.model ?? DEFAULT_BRIDGE_PROVIDER_MODEL,
          mode: modeFor(descriptor, options.mode),
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : descriptor.policy.timeoutMs !== undefined
              ? { timeoutMs: descriptor.policy.timeoutMs }
              : {}),
          env: state.env
        });
      } catch (error) {
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
      const candidateId = `${descriptor.id}_${model.id}_${ordinal}`;
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
      return {
        candidateId,
        model,
        status,
        ...(worktree
          ? { branchName: worktree.branchName, worktreePath: worktree.path }
          : {}),
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
        verification: {
          status,
          evidence: [
            `tool_events=${result.toolEvents}`,
            outputHash,
            ...(result.diff !== undefined ? ["worktree_diff"] : [])
          ],
          ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {})
        },
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
