import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonValue, ModelFusionStatus } from "@warrant/protocol";
import { newSpanId, TRACE_ID_HEADER, TRACE_SPAN_HEADER } from "@warrant/protocol";
import { gitText } from "@warrant/workspace";

import { createAgentHarness } from "./agent.js";
import { claudeCodeHarness } from "./claude-code.js";
import { createCommandHarness } from "./command.js";
import { codexHarness } from "./codex.js";
import { createMockHarness } from "./mock.js";
import { runEnsemble } from "./run.js";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  EnsembleRunResult,
  HarnessAdapter,
  HarnessArtifact,
  HarnessTrajectory
} from "./harness.js";
import type {
  JudgeInput,
  JudgeSynthesisOutput,
  JudgeSynthesizer
} from "./judge.js";

export type UnifiedHarnessKind =
  | "mock"
  | "command"
  | "agent"
  | "codex"
  | "claude-code"
  | "cursor-acp"
  | "cursor-desktop";

export type UnifiedHarnessMatrixResult = {
  harness: UnifiedHarnessKind;
  modelIds: string[];
  status: ModelFusionStatus;
  message: string;
  ensemble?: EnsembleRunResult;
  artifacts: Record<string, string>;
  details: Record<string, JsonValue>;
};

export type UnifiedHarnessE2EResult = {
  id: string;
  generatedAt: string;
  fusionBackendUrl: string;
  repo: string;
  results: UnifiedHarnessMatrixResult[];
  reportPath?: string;
};

export type CursorHarnessRunnerInput = {
  kind: Extract<UnifiedHarnessKind, "cursor-acp" | "cursor-desktop">;
  model: EnsembleModel;
  fusionBackendUrl: string;
  repo: string;
  outDir: string;
  timeoutMs?: number;
  cursorKitDir?: string;
};

export type CursorHarnessRunnerResult = {
  status: ModelFusionStatus;
  message: string;
  artifacts?: Record<string, string>;
  details?: Record<string, JsonValue>;
};

export type UnifiedHarnessE2EOptions = {
  id?: string;
  fusionBackendUrl: string;
  fusionApiKey?: string;
  repo: string;
  outputRoot: string;
  prompt: string;
  harnesses: UnifiedHarnessKind[];
  models: EnsembleModel[];
  command?: string;
  timeoutMs?: number;
  judgeModel?: string;
  cursorKitDir?: string;
  cursorRunner?: (input: CursorHarnessRunnerInput) => Promise<CursorHarnessRunnerResult>;
  /**
   * Per-candidate model backend URLs keyed by `EnsembleModel.id`. When a
   * candidate's model id is present, its command harness is pointed at that
   * endpoint instead of the shared `fusionBackendUrl`, so each panel model can
   * back its own real candidate (e.g. a local MLX trio).
   */
  modelEndpoints?: Record<string, string>;
  /**
   * Observability correlation id. When set, the agent harness, panel-model
   * calls, and the FusionKit trajectory synthesis are all tagged with this
   * trace so the companion app can reconstruct one session.
   */
  traceId?: string;
};

function normalizeFusionBackendUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeFusionBackendUrl(baseUrl);
  return normalized.endsWith("/v1")
    ? `${normalized}/chat/completions`
    : `${normalized}/v1/chat/completions`;
}

function sideEffectsForHarness(kind: UnifiedHarnessKind): EnsembleDescriptor["policy"]["sideEffects"] {
  switch (kind) {
    case "mock":
      return "read_only";
    case "command":
      return "tool_execution";
    case "agent":
      return "writes_workspace";
    case "codex":
    case "claude-code":
    case "cursor-acp":
    case "cursor-desktop":
      return "writes_workspace";
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

function harnessAdapter(kind: UnifiedHarnessKind, options: UnifiedHarnessE2EOptions): HarnessAdapter {
  switch (kind) {
    case "mock":
      return createMockHarness();
    case "agent":
      return createAgentHarness({
        modelEndpoints: options.modelEndpoints ?? {},
        fallbackBaseUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
        ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.traceId !== undefined ? { traceId: options.traceId } : {})
      });
    case "command": {
      if (!options.command) {
        throw new Error("--command is required for the command unified harness");
      }
      return createCommandHarness({
        command: options.command,
        timeoutMs: options.timeoutMs,
        env: ({ model }) => {
          const backend = options.modelEndpoints?.[model.id] ?? options.fusionBackendUrl;
          return {
            FUSIONKIT_BASE_URL: normalizeFusionBackendUrl(backend),
            FUSIONKIT_CHAT_COMPLETIONS_URL: chatCompletionsUrl(backend),
            FUSIONKIT_MODEL: model.model,
            FUSIONKIT_MODEL_ID: model.id,
            ...(options.fusionApiKey ? { FUSIONKIT_API_KEY: options.fusionApiKey } : {}),
            ...(options.traceId ? { FUSION_TRACE_ID: options.traceId } : {})
          };
        }
      });
    }
    case "codex":
      return codexHarness({
        timeoutMs: options.timeoutMs,
        provider: {
          kind: "openai-compatible",
          baseUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
          ...(options.fusionApiKey ? { apiKey: options.fusionApiKey } : {})
        }
      });
    case "claude-code":
      return claudeCodeHarness({ timeoutMs: options.timeoutMs });
    case "cursor-acp":
    case "cursor-desktop":
      throw new Error(`${kind} runs through the Cursor harness adapter path`);
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

function responseShapeFor(kind: UnifiedHarnessKind): string {
  switch (kind) {
    case "mock":
    case "command":
      return "Return a concise markdown summary and include any final patch guidance.";
    case "agent":
      return (
        "Respond to the user in the natural shape the request calls for: a direct answer, " +
        "a plan, or the concrete code change. Reply in first person as the assistant."
      );
    case "codex":
      return "Return a Codex-style result summary with patch and verification evidence.";
    case "claude-code":
      return "Return a Claude Code-style transcript summary with patch/worktree evidence.";
    case "cursor-acp":
    case "cursor-desktop":
      return "Return text suitable for Cursor ACP session/update plus route evidence notes.";
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

function trajectoryFuseUrl(baseUrl: string): string {
  return `${normalizeFusionBackendUrl(baseUrl)}/v1/fusion/trajectories:fuse`;
}

function trajectoryToWire(trajectory: HarnessTrajectory): Record<string, unknown> {
  return {
    trajectory_id: trajectory.trajectoryId,
    model_id: trajectory.modelId,
    status: trajectory.status,
    steps: trajectory.steps,
    final_output: trajectory.finalOutput,
    ...(trajectory.candidateId !== undefined ? { candidate_id: trajectory.candidateId } : {}),
    ...(trajectory.model !== undefined ? { model: trajectory.model } : {}),
    ...(trajectory.harnessKind !== undefined ? { harness_kind: trajectory.harnessKind } : {}),
    ...(trajectory.diff !== undefined && trajectory.diff.length > 0 ? { diff: trajectory.diff } : {}),
    ...(trajectory.verification !== undefined
      ? {
          verification: {
            status: trajectory.verification.status,
            evidence: trajectory.verification.evidence,
            ...(trajectory.verification.exitCode !== undefined
              ? { exit_code: trajectory.verification.exitCode }
              : {})
          }
        }
      : {})
  };
}

export function createFusionKitJudgeSynthesizer(input: {
  fusionBackendUrl: string;
  model: string;
  apiKey?: string;
  responseShape: string;
  traceId?: string;
}): JudgeSynthesizer {
  const authHeaders: Record<string, string> = input.apiKey
    ? { authorization: `Bearer ${input.apiKey}` }
    : {};
  const traceHeaders: Record<string, string> =
    input.traceId !== undefined
      ? { [TRACE_ID_HEADER]: input.traceId, [TRACE_SPAN_HEADER]: newSpanId() }
      : {};
  return {
    async synthesize(judgeInput: JudgeInput): Promise<JudgeSynthesisOutput> {
      // Trajectory-level fusion: when candidates carry agent trajectories, fuse
      // them through FusionKit's trajectory-aware, intent-agnostic synthesizer,
      // which returns the answer in the request's native shape and first person.
      const trajectories = judgeInput.candidates
        .map((candidate) => candidate.trajectory)
        .filter((trajectory): trajectory is HarnessTrajectory => trajectory !== undefined);
      if (trajectories.length > 0) {
        const fuseResponse = await fetch(trajectoryFuseUrl(input.fusionBackendUrl), {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders, ...traceHeaders },
          body: JSON.stringify({
            messages: [{ role: "user", content: judgeInput.descriptor.prompt }],
            trajectories: trajectories.map(trajectoryToWire)
          })
        });
        if (!fuseResponse.ok) {
          throw new Error(
            `FusionKit trajectory fusion failed: ${fuseResponse.status} ${(await fuseResponse.text()).slice(0, 500)}`
          );
        }
        const fused = (await fuseResponse.json()) as { final_output?: string; rationale?: string };
        return {
          decision: "synthesize",
          finalOutput: fused.final_output ?? "",
          rationale: fused.rationale ?? "FusionKit trajectory fusion",
          contributions: trajectories.map((trajectory) => ({
            candidateId: trajectory.candidateId ?? trajectory.trajectoryId,
            reason: `fused ${trajectory.status} trajectory`
          }))
        };
      }
      const response = await fetch(chatCompletionsUrl(input.fusionBackendUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: input.model,
          messages: [
            {
              role: "system",
              content:
                "You synthesize coding harness candidate evidence. " +
                input.responseShape
            },
            {
              role: "user",
              content: JSON.stringify({
                prompt: judgeInput.descriptor.prompt,
                candidates: judgeInput.candidates,
                toolRecords: judgeInput.toolRecords,
                artifacts: judgeInput.artifacts
              })
            }
          ],
          temperature: 0,
          max_tokens: 800
        })
      });
      if (!response.ok) {
        throw new Error(`FusionKit judge request failed: ${response.status}`);
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const finalOutput = body.choices?.[0]?.message?.content ?? "";
      return {
        decision: "synthesize",
        finalOutput,
        rationale: "FusionKit judge synthesis",
        contributions: judgeInput.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          reason: `included ${candidate.status} candidate evidence`
        }))
      };
    }
  };
}

function descriptorFor(
  kind: Exclude<UnifiedHarnessKind, "cursor-acp" | "cursor-desktop">,
  options: UnifiedHarnessE2EOptions
): EnsembleDescriptor {
  const id = `${options.id ?? "unified_e2e"}_${kind.replace(/-/g, "_")}`;
  return {
    id,
    harness: harnessAdapter(kind, options),
    models: options.models,
    runtime: { id: "unified-local" },
    judge: {
      id: "fusionkit-judge",
      model: options.judgeModel ?? options.models[0]?.model ?? "fusionkit/router",
      synthesizer: createFusionKitJudgeSynthesizer({
        fusionBackendUrl: options.fusionBackendUrl,
        model: options.judgeModel ?? options.models[0]?.model ?? "fusionkit/router",
        apiKey: options.fusionApiKey,
        responseShape: responseShapeFor(kind),
        ...(options.traceId !== undefined ? { traceId: options.traceId } : {})
      })
    },
    policy: {
      id: "unified-e2e",
      allowedTools: ["read_file", "write_file", "apply_patch", "run_tests", "shell_command"],
      sideEffects: sideEffectsForHarness(kind),
      timeoutMs: options.timeoutMs
    },
    prompt: options.prompt,
    sourceRepo: "handoffkit",
    baseGitSha: gitText(options.repo, ["rev-parse", "HEAD"]).trim(),
    workspace: options.repo,
    outputRoot: options.outputRoot,
    cleanupWorktrees: true,
    metadata: {
      unified_harness_e2e: true,
      fusion_backend_url: normalizeFusionBackendUrl(options.fusionBackendUrl),
      response_shape: responseShapeFor(kind)
    }
  };
}

function statusForResult(result: EnsembleRunResult): ModelFusionStatus {
  return result.failureSummary ? "failed" : result.harnessRunResult.status;
}

async function defaultCursorRunner(input: CursorHarnessRunnerInput): Promise<CursorHarnessRunnerResult> {
  if (!input.cursorKitDir) {
    return {
      status: "skipped",
      message: "Cursorkit directory not configured",
      details: { reason: "cursor_kit_dir_missing" }
    };
  }
  const suite = input.kind === "cursor-acp" ? "acp" : "desktop-route";
  const args = [
    "test:harness",
    "--",
    "--suite",
    suite,
    "--base-url",
    normalizeFusionBackendUrl(input.fusionBackendUrl),
    "--model",
    input.model.id,
    "--provider-model",
    input.model.model,
    "--timeout-ms",
    String(input.timeoutMs ?? 60_000)
  ];
  mkdirSync(input.outDir, { recursive: true });
  return await new Promise((resolveResult) => {
    const child = spawn("pnpm", args, {
      cwd: input.cursorKitDir,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      const logPath = join(input.outDir, `${input.kind}-${input.model.id}.log`);
      writeFileSync(logPath, [stdout, stderr].filter(Boolean).join("\n"));
      resolveResult({
        status: code === 0 ? "succeeded" : "failed",
        message: code === 0 ? `${input.kind} completed` : `${input.kind} failed`,
        artifacts: { log: logPath },
        details: { exitCode: code ?? 1 }
      });
    });
  });
}

async function runCursorHarness(
  kind: Extract<UnifiedHarnessKind, "cursor-acp" | "cursor-desktop">,
  options: UnifiedHarnessE2EOptions
): Promise<UnifiedHarnessMatrixResult> {
  const runner = options.cursorRunner ?? defaultCursorRunner;
  const perModel = await Promise.all(
    options.models.map((model) =>
      runner({
        kind,
        model,
        fusionBackendUrl: options.fusionBackendUrl,
        repo: options.repo,
        outDir: join(options.outputRoot, `${kind}-${model.id}`),
        timeoutMs: options.timeoutMs,
        cursorKitDir: options.cursorKitDir
      })
    )
  );
  const failed = perModel.find((result) => result.status === "failed");
  const skipped = perModel.every((result) => result.status === "skipped");
  return {
    harness: kind,
    modelIds: options.models.map((model) => model.id),
    status: failed ? "failed" : skipped ? "skipped" : "succeeded",
    message: failed?.message ?? (skipped ? "all Cursor model probes skipped" : "Cursor probes completed"),
    artifacts: Object.assign({}, ...perModel.map((result) => result.artifacts ?? {})),
    details: {
      perModel: perModel.map((result) => ({
        status: result.status,
        message: result.message,
        ...(result.details ?? {})
      })) as JsonValue
    }
  };
}

export async function runUnifiedHarnessE2E(
  options: UnifiedHarnessE2EOptions
): Promise<UnifiedHarnessE2EResult> {
  const outputRoot = resolve(options.outputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const results: UnifiedHarnessMatrixResult[] = [];
  for (const kind of options.harnesses) {
    if (kind === "cursor-acp" || kind === "cursor-desktop") {
      results.push(await runCursorHarness(kind, options));
      continue;
    }
    const descriptor = descriptorFor(kind, options);
    const ensembleResult = await runEnsemble(descriptor);
    results.push({
      harness: kind,
      modelIds: options.models.map((model) => model.id),
      status: statusForResult(ensembleResult),
      message: ensembleResult.harnessRunResult.output_summary ?? "",
      ensemble: ensembleResult,
      artifacts: {
        ...(ensembleResult.summaryPath ? { summary: ensembleResult.summaryPath } : {})
      },
      details: {
        candidateCount: ensembleResult.candidates.length,
        artifactCount: ensembleResult.artifacts.length,
        toolRecordCount: ensembleResult.toolRecords.length,
        modelCallRecordCount: ensembleResult.modelCallRecords.length,
        judgeSynthesis: ensembleResult.judgeSynthesisRecord !== undefined
      }
    });
  }
  const report: UnifiedHarnessE2EResult = {
    id: options.id ?? "unified_e2e",
    generatedAt: new Date().toISOString(),
    fusionBackendUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
    repo: resolve(options.repo),
    results
  };
  const reportPath = join(outputRoot, "unified-e2e-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return { ...report, reportPath };
}
