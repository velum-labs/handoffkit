import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isFiniteK } from "@fusionkit/protocol";
import type { JsonValue, ModelFusionStatus } from "@fusionkit/protocol";
import { ensureRunOutputDir, runCliCapture } from "@fusionkit/runtime-utils";
import { envOf } from "@fusionkit/tracing";
import { deriveSourceRepo } from "./source-repo.js";
import { gitText } from "@fusionkit/workspace";
import { createAgentHarness } from "./agent.js";
import { createCommandHarness } from "./command.js";
import { resolveCursorkitCli } from "./cursorkit-path.js";
import { createMockHarness } from "./mock.js";
import { runEnsemble } from "./run.js";
import type { EnsembleDescriptor, EnsembleRunResult, HarnessAdapter } from "./harness.js";
import { createFusionKitJudgeSynthesizer } from "./panel-orchestration.js";
import { requireToolHarnessProvider, resolveToolAdapter } from "./harness-kind-registry.js";
import { chatCompletionsUrl, normalizeFusionBackendUrl } from "./unified-url.js";
import type { CursorHarnessRunnerInput, CursorHarnessRunnerResult, UnifiedHarnessE2EOptions, UnifiedHarnessE2EResult, UnifiedHarnessKind, UnifiedHarnessMatrixResult } from "./unified-types.js";
export type { CursorHarnessRunnerInput, CursorHarnessRunnerResult, UnifiedHarnessE2EOptions, UnifiedHarnessE2EResult, UnifiedHarnessMatrixResult } from "./unified-types.js";

export function sideEffectsForHarness(kind: UnifiedHarnessKind): EnsembleDescriptor["policy"]["sideEffects"] {
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
      return requireToolHarnessProvider(kind).sideEffects(kind);
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

/**
 * Whether a harness kind can honor a finite k (stop at the k-th step boundary
 * and capture the proposal). Only loops fusionkit owns qualify: the generic
 * agent harness (and the fixture-replaying mock, which has no loop to bound).
 * CLI/command harnesses cannot pause at a tool-call boundary. This is the one
 * source of that fact — preflight validation and the adapter guard both read it.
 */
export function harnessSupportsFiniteK(kind: UnifiedHarnessKind): boolean {
  return kind === "agent" || kind === "mock";
}

function harnessAdapter(kind: UnifiedHarnessKind, options: UnifiedHarnessE2EOptions): HarnessAdapter {
  if (isFiniteK(options.k) && !harnessSupportsFiniteK(kind)) {
    throw new Error(
      `finite k (k=${options.k}) is not supported by the "${kind}" harness: only the generic ` +
        `"agent" harness can stop at a step boundary. Use k=1 (harness-independent) or unset k.`
    );
  }
  switch (kind) {
    case "mock":
      return createMockHarness();
    case "agent":
      return createAgentHarness({
        modelEndpoints: options.modelEndpoints ?? {},
        fallbackBaseUrl: normalizeFusionBackendUrl(options.fusionBackendUrl),
        ...(options.fusionApiKey !== undefined ? { apiKey: options.fusionApiKey } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.trace !== undefined ? { trace: options.trace } : {}),
        ...(options.turn !== undefined ? { turn: options.turn } : {}),
        ...(options.panelIdentity !== undefined ? { panelIdentity: options.panelIdentity } : {}),
        ...(options.k !== undefined ? { k: options.k } : {})
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
            // W3C env propagation: a fusion-aware child continues the trace.
            ...(options.trace !== undefined ? envOf(options.trace) : {})
          };
        }
      });
    }
    case "codex":
    case "claude-code":
    case "cursor-acp":
    case "cursor-desktop":
      return resolveToolAdapter(kind, options);
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

export function responseShapeFor(kind: UnifiedHarnessKind): string {
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
    case "claude-code":
    case "cursor-acp":
    case "cursor-desktop":
      return requireToolHarnessProvider(kind).responseShape(kind);
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported unified harness: ${String(exhausted)}`);
    }
  }
}

export function descriptorFor(
  kind: UnifiedHarnessKind,
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
      model: options.judgeModel ?? options.models[0]?.model ?? "fusionkit/heuristic",
      synthesizer: createFusionKitJudgeSynthesizer({
        fusionBackendUrl: options.fusionBackendUrl,
        model: options.judgeModel ?? options.models[0]?.model ?? "fusionkit/heuristic",
        apiKey: options.fusionApiKey,
        responseShape: responseShapeFor(kind),
        ...(options.trace !== undefined ? { trace: options.trace } : {}),
        ...(options.turn !== undefined ? { turn: options.turn } : {})
      })
    },
    policy: {
      id: "unified-e2e",
      allowedTools: ["read_file", "write_file", "apply_patch", "run_tests", "shell_command"],
      sideEffects: sideEffectsForHarness(kind),
      timeoutMs: options.timeoutMs,
      ...(options.stragglerGraceMs !== undefined ? { stragglerGraceMs: options.stragglerGraceMs } : {})
    },
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    prompt: options.prompt,
    sourceRepo: deriveSourceRepo(options.repo),
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
  const { harnessCli } = resolveCursorkitCli();
  const suite = input.kind === "cursor-acp" ? "acp" : "desktop-route";
  const args = [
    harnessCli,
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
  ensureRunOutputDir(input.outDir);
  const result = await runCliCapture(process.execPath, args, {
    cwd: input.outDir,
    // The probe CLI enforces its own per-step timeout; this outer deadline is
    // the group-kill backstop so a hung probe cannot leak processes.
    timeoutMs: (input.timeoutMs ?? 60_000) + 30_000
  });
  const logPath = join(input.outDir, `${input.kind}-${input.model.id}.log`);
  writeFileSync(logPath, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  return {
    status: result.exitCode === 0 ? "succeeded" : "failed",
    message: result.exitCode === 0 ? `${input.kind} completed` : `${input.kind} failed`,
    artifacts: { log: logPath },
    details: { exitCode: result.exitCode }
  };
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
        timeoutMs: options.timeoutMs
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
  ensureRunOutputDir(outputRoot);
  const results: UnifiedHarnessMatrixResult[] = [];
  for (const kind of options.harnesses) {
    if (
      (kind === "cursor-acp" || kind === "cursor-desktop") &&
      options.cursorRunner !== undefined
    ) {
      // Explicit probe runner: drive the Cursorkit harness suite and record a
      // route/transcript probe instead of producing real ensemble candidates.
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
