import { artifactHash } from "@routekit/contracts";
import {
  PANEL_DEPTH_HEADER
} from "@fusionkit/gateway";
import {
  claudeModelAlias,
  ModelRoutedBackend,
  OpenAiBackend,
  startGateway
} from "@routekit/gateway";
import type { Backend } from "@routekit/gateway";
import {
  buildChildEnv,
  captureWorktreeDiff,
  commandOnPath,
  normalizeApiBaseUrl,
  runCliCapture
} from "@routekit/runtime";
import type { CliCaptureResult } from "@routekit/runtime";

import { claudeAgentsJson, claudeEnv } from "./launch.js";

import { KernelBackend, traceCandidate } from "@fusionkit/ensemble";
import type { FusionTraceCarrier } from "@fusionkit/ensemble";
import { createClaudeStreamStepEmitter, parseClaudeStreamJson, resolveClaudeCliModel } from "./stream-trajectory.js";
import type {
  EnsembleDescriptor,
  FusedSubagentAccess,
  HarnessAdapter,
  HarnessCandidateOutput,
  HarnessRunInput
} from "@fusionkit/ensemble";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_ENV_NAMES = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
];

export type ClaudeCodeHarnessEnv = Record<string, string | undefined>;

export type ClaudeCodeHarnessOptions = {
  id?: string;
  /** CLI binary to spawn (defaults to `claude`). */
  command?: string;
  /** Fusion router base URL the CLI's model calls go to. */
  fusionBackendUrl?: string;
  /** Bearer token presented to the router (defaults to `local`). */
  apiKey?: string;
  /**
   * Per-model router endpoints keyed by `EnsembleModel.id`. When a candidate's
   * id is present, the CLI is pointed at that endpoint and requests the endpoint
   * id as its model.
   */
  modelEndpoints?: Record<string, string>;
  /** Defaults to `process.env`; tests can pass `{}` for deterministic skips. */
  env?: ClaudeCodeHarnessEnv;
  timeoutMs?: number;
  skipWhenUnavailable?: boolean;
  /** Trace carrier of the enclosing run/turn; candidates span under it. */
  trace?: FusionTraceCarrier;
  turn?: number;
  /** Enable native sub-agents inside panel members (default on). */
  subagents?: boolean;
  /**
   * Fused sub-agent access: router-gateway members get one session-scoped
   * `--agents` definition per fused ensemble, and their translation gateway
   * routes `fusion-*` (and `claude-fusion-*`) requests to the front-door
   * fusion gateway stamped with the panel depth. Native-Anthropic members are
   * unaffected (their turns never pass a gateway that could route fusion ids).
   */
  fusedSubagents?: FusedSubagentAccess;
};

const DEFAULT_CLAUDE_COMMAND = "claude";

function unavailableReasonFor(command: string, env: ClaudeCodeHarnessEnv): string | undefined {
  return commandOnPath(command, env)
    ? undefined
    : `Claude CLI "${command}" was not found on PATH; install the Claude Code CLI and log in.`;
}

export function claudeCodeHarnessCredentialSkipReason(
  env: ClaudeCodeHarnessEnv = process.env,
  options: ClaudeCodeHarnessOptions = {}
): string | undefined {
  return unavailableReasonFor(options.command ?? DEFAULT_CLAUDE_COMMAND, env);
}


/**
 * True when the `claude` CLI can serve this panel model natively: an
 * Anthropic-family id (`claude*`/`anthropic*`) or one `resolveClaudeCliModel`
 * maps to a CLI family alias (opus/sonnet/haiku/fable).
 */
function isNativeAnthropicModel(model: string): boolean {
  return claudeModelAlias(model) === model || resolveClaudeCliModel(model) !== model;
}

/**
 * Per-candidate translation gateway for a non-Anthropic panel member: an
 * in-process server speaking the Anthropic Messages dialect whose chat core
 * forwards to the member's fusion router endpoint, always requesting the
 * router endpoint id. The claude CLI selects the member via its `claude-`
 * alias (Claude Code only accepts `claude`/`anthropic`-prefixed ids); the
 * alias is mapped back here, never sent upstream.
 */
function startCandidateRouterGateway(input: {
  endpointUrl: string;
  endpointId: string;
  apiKey: string;
  fusedSubagents?: FusedSubagentAccess;
}): ReturnType<typeof startGateway> {
  const primary: Backend = new OpenAiBackend({
    baseUrl: normalizeApiBaseUrl(input.endpointUrl),
    apiKey: input.apiKey,
    defaultModel: input.endpointId,
    forceModel: input.endpointId
  });
  // Fused sub-agent access: the member's Task-tool agents pin `claude-fusion-*`
  // model ids; route those (and the raw `fusion-*` ids) to the front-door
  // fusion gateway — which strips the claude alias itself — stamped with the
  // panel depth so fused access never recurses another level down.
  const fused = input.fusedSubagents;
  const backend: Backend =
    fused === undefined || fused.ensembles.length === 0
      ? primary
      : new ModelRoutedBackend({
          routedModelIds: fused.ensembles.flatMap((ensemble) => [
            ensemble.modelId,
            claudeModelAlias(ensemble.modelId)
          ]),
          routed: new OpenAiBackend({
            baseUrl: normalizeApiBaseUrl(fused.gatewayUrl),
            ...(fused.authToken !== undefined ? { apiKey: fused.authToken } : {}),
            headers: { [PANEL_DEPTH_HEADER]: String(fused.depth) }
          }),
          primary
        });
  return startGateway({
    backend: new KernelBackend(backend, {
      workflowIds: {
        chat: "native-passthrough-turn",
        models: "native-passthrough-models",
        embeddings: "native-passthrough-embeddings"
      }
    })
  });
}

type ClaudePrintResult = {
  status: "succeeded" | "failed";
  /** Raw stdout (the stream-json event stream we reconstruct the trajectory from). */
  stdout: string;
  /** Human-readable transcript (stdout + stderr) for logs/artifacts. */
  transcript: string;
  exitCode?: number;
  reason?: string;
};

/**
 * Drive the `claude` CLI in headless print mode inside the worktree and
 * reconstruct the trajectory by parsing its `--output-format stream-json`
 * stdout. Anthropic-family panel members run against the native Anthropic
 * backend; other members are pointed at a per-candidate translation gateway
 * (`gateway`) that speaks the Anthropic Messages dialect and routes to the
 * member's fusion router endpoint (see `runViaRouterGateway`).
 */
async function driveClaudePrint(input: {
  command: string;
  cwd: string;
  prompt: string;
  model: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** When set, point the CLI at this Anthropic-dialect gateway instead of api.anthropic.com. */
  gateway?: { baseUrl: string; authToken: string };
  /** Session-scoped `--agents` JSON (fused sub-agent definitions). */
  agentsJson?: string;
  onStdoutLine?: (line: string) => void;
  /** Aborts the claude child process (panel cancellation / straggler policy). */
  signal?: AbortSignal;
}): Promise<ClaudePrintResult> {
  // The prompt travels via stdin (`claude -p` reads it there when no
  // positional prompt is given): argv would cap the prompt size and expose it
  // in `ps`.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    input.model,
    ...(input.agentsJson !== undefined ? ["--agents", input.agentsJson] : [])
  ];
  const childEnv: Record<string, string> = { ...input.env };
  if (input.gateway !== undefined) {
    // Route this candidate through its translation gateway (the same env shim
    // the launcher uses). Ambient Anthropic credentials must not win over the
    // gateway token, so strip the API key.
    Object.assign(childEnv, claudeEnv(input.gateway.baseUrl, input.gateway.authToken));
    delete childEnv.ANTHROPIC_API_KEY;
  } else {
    // Run against the native Anthropic backend: ambient ANTHROPIC_API_KEY
    // (loaded by the fusion stack) authenticates the run; strip any inherited
    // gateway base URL.
    delete childEnv.ANTHROPIC_BASE_URL;
  }
  let result: CliCaptureResult;
  try {
    result = await runCliCapture(input.command, args, {
      cwd: input.cwd,
      env: childEnv,
      timeoutMs: input.timeoutMs,
      stdin: input.prompt,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.onStdoutLine !== undefined ? { onStdoutLine: input.onStdoutLine } : {})
    });
  } catch (error) {
    return {
      status: "failed",
      stdout: "",
      transcript: "",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  const transcript = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.timedOut) {
    return { status: "failed", stdout: result.stdout, transcript, reason: "claude CLI timed out" };
  }
  if (result.aborted) {
    return {
      status: "failed",
      stdout: result.stdout,
      transcript,
      reason: result.abortReason ?? "aborted"
    };
  }
  if (result.exitCode === 0) {
    return { status: "succeeded", stdout: result.stdout, transcript, exitCode: result.exitCode };
  }
  const failureReason = result.stderr.trim().slice(0, 500) || transcript.trim().slice(-500);
  return {
    status: "failed",
    stdout: result.stdout,
    transcript,
    exitCode: result.exitCode,
    reason:
      failureReason.length > 0 ? failureReason : `claude CLI exited with code ${result.exitCode}`
  };
}

/**
 * Local Claude Code harness: drives the `claude` CLI in the candidate's worktree
 * pointed at the fusion router, for uniform local-worktree panel isolation. No
 * Vercel sandbox; the only prerequisite is a logged-in `claude` CLI on PATH.
 */
function createLocalClaudeCodeHarness(options: ClaudeCodeHarnessOptions): HarnessAdapter {
  const id = options.id ?? "claude-code";
  const env = options.env ?? process.env;
  const command = options.command ?? DEFAULT_CLAUDE_COMMAND;
  const skipWhenUnavailable = options.skipWhenUnavailable ?? true;
  const unavailableReason = (): string | undefined =>
    commandOnPath(command, env)
      ? undefined
      : `Claude CLI "${command}" was not found on PATH; install the Claude Code CLI and log in.`;
  return {
    id,
    harnessKind: "claude_code",
    prepare: () => ({ reason: unavailableReason() }),
    capabilities: () => {
      const ready = unavailableReason() === undefined;
      return {
        workspace_read: ready ? "supported" : "degraded",
        workspace_write: ready ? "supported" : "degraded",
        apply_patch: ready ? "supported" : "degraded",
        tool_records: "supported",
        route_model_observation: "supported",
        adapter_available: ready ? "supported" : "unsupported"
      };
    },
    verificationProfile: () => ({
      id: `${id}-verification`,
      requiredEvidence: ["claude transcript", "worktree diff or skip reason"]
    }),
    run: async (runInput): Promise<HarnessCandidateOutput> => {
      const { descriptor, model, ordinal, worktree } = runInput;
      const candidate = `${descriptor.id}_${model.id}_${ordinal}`;
      const reason = (runInput.prepared as { reason?: string } | undefined)?.reason ?? unavailableReason();
      if (reason !== undefined) {
        if (!skipWhenUnavailable) throw new Error(reason);
        return {
          candidateId: candidate,
          model,
          status: "skipped",
          ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {}),
          transcript: reason,
          summary: reason,
          error: { kind: "capability_missing", message: reason, retryable: false },
          metadata: { adapter: "claude-code", execution: "local" }
        };
      }
      // Emit per-candidate trace events so the companion app shows this
      // candidate's trajectory live (started now, finished when the run completes).
      const tracer = traceCandidate(
        {
          ...(options.trace !== undefined ? { trace: options.trace } : {}),
          ...(options.turn !== undefined ? { turn: options.turn } : {})
        },
        {
          candidateId: candidate,
          modelId: model.id,
          model: model.model,
          ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {})
        }
      );
      // Anthropic-family members run against the native Anthropic backend with
      // their id resolved to a CLI-accepted family alias. Any other panel
      // member (an OpenAI or local MLX model) cannot be served by
      // api.anthropic.com, so it runs through a per-candidate translation
      // gateway that forwards to the member's fusion router endpoint — the
      // same claude-alias passthrough trick the front door's model picker uses.
      const endpointUrl = options.modelEndpoints?.[model.id] ?? options.fusionBackendUrl;
      const viaRouter = !isNativeAnthropicModel(model.model) && endpointUrl !== undefined;
      const fusedSubagents =
        options.subagents !== false && viaRouter ? options.fusedSubagents : undefined;
      const routerGateway = viaRouter
        ? await startCandidateRouterGateway({
            endpointUrl,
            endpointId: model.id,
            apiKey: options.apiKey ?? "local",
            ...(fusedSubagents !== undefined ? { fusedSubagents } : {})
          })
        : undefined;
      const cliModel = viaRouter ? claudeModelAlias(model.id) : resolveClaudeCliModel(model.model);
      const emitStep = createClaudeStreamStepEmitter((step) => tracer.step(step));
      let result: ClaudePrintResult;
      try {
        result = await driveClaudePrint({
          command,
          cwd: worktree?.path ?? descriptor.workspace ?? process.cwd(),
          prompt: descriptor.prompt,
          model: cliModel,
          timeoutMs: options.timeoutMs ?? descriptor.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // Allowlisted child env: baseline system vars plus the Anthropic /
          // AI Gateway credential names and the CLI's own CLAUDE_* config —
          // never the parent's full environment.
          env: buildChildEnv({ base: env, allow: [...AUTH_ENV_NAMES, /^CLAUDE_/] }),
          ...(routerGateway !== undefined
            ? { gateway: { baseUrl: routerGateway.url(), authToken: options.apiKey ?? "local" } }
            : {}),
          // Fused sub-agents: one session-scoped agent per ensemble, so the
          // member's Task tool can delegate to any `fusion-<name>` ensemble
          // (its translation gateway routes those turns to the front door).
          ...(fusedSubagents !== undefined
            ? { agentsJson: claudeAgentsJson(fusedSubagents.ensembles, fusedSubagents.defaultModelId) }
            : {}),
          onStdoutLine: emitStep,
          ...(runInput.signal !== undefined ? { signal: runInput.signal } : {})
        });
      } finally {
        await routerGateway?.close();
      }
      const diff = worktree ? captureWorktreeDiff(worktree.path) : undefined;
      const outputHash = artifactHash(result.transcript.length > 0 ? result.transcript : candidate);
      const status: HarnessCandidateOutput["status"] = result.status;
      // Reconstruct the native trajectory from the CLI's stream-json stdout.
      const reconstructed = parseClaudeStreamJson(result.stdout);
      const trajectory =
        reconstructed.steps.length > 0
          ? {
              trajectoryId: candidate,
              modelId: model.id,
              model: model.model,
              candidateId: candidate,
              harnessKind: "claude_code" as const,
              status,
              steps: reconstructed.steps,
              finalOutput:
                reconstructed.finalOutput.length > 0 ? reconstructed.finalOutput : result.transcript,
              ...(diff !== undefined ? { diff } : {})
            }
          : undefined;
      tracer.finished({
        status,
        steps: reconstructed.steps,
        ...(reconstructed.finalOutput.length > 0 ? { finalOutput: reconstructed.finalOutput } : {})
      });
      return {
        candidateId: candidate,
        model,
        status,
        ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {}),
        ...(trajectory !== undefined ? { trajectory } : {}),
        transcript: result.transcript,
        log: result.transcript,
        ...(diff !== undefined ? { diff } : {}),
        artifacts: [
          {
            artifact_id: `artifact_${candidate}_claude_transcript`,
            kind: "transcript",
            hash: outputHash,
            redaction_status: "synthetic"
          }
        ],
        toolRecords: [
          {
            execution_id: `exec_${candidate}_claude`,
            plan_id: `plan_${candidate}_claude`,
            status,
            output_hash: outputHash,
            ...(status === "failed"
              ? {
                  error: {
                    kind: "provider_error" as const,
                    message: result.reason || "Claude CLI run failed.",
                    retryable: false
                  }
                }
              : {})
          }
        ],
        ...(status === "failed"
          ? {
              error: {
                kind: "provider_error" as const,
                message: result.reason || "Claude CLI run failed.",
                retryable: false
              }
            }
          : {}),
        metadata: {
          adapter: "claude-code",
          execution: "local",
          backend: viaRouter ? "fusion-router" : "anthropic-native",
          requested_model: model.model,
          cli_model: cliModel,
          step_count: reconstructed.steps.length,
          ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
          has_diff: diff !== undefined && diff.length > 0
        }
      };
    },
    collectArtifacts: () => []
  };
}

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions = {}): HarnessAdapter {
  return createLocalClaudeCodeHarness(options);
}


export function claudeCodeHarness(options: ClaudeCodeHarnessOptions = {}): HarnessAdapter {
  return createClaudeCodeHarness(options);
}
