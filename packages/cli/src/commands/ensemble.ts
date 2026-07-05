import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Command } from "commander";

import {
  createCommandHarness,
  createMockHarness,
  createMockJudgeSynthesizer,
  runEnsemble,
  runUnifiedHarnessE2E
} from "@fusionkit/ensemble";
import type { EnsembleDescriptor } from "@fusionkit/ensemble";
import { assertHarnessRunRequestV1, assertHarnessRunResultV1 } from "@fusionkit/protocol";
import { gitText } from "@fusionkit/workspace";

import { uiStream } from "@fusionkit/cli-ui";

import { runHarnessSmokeDashboard } from "../dashboard.js";
import { fail } from "../shared/errors.js";
import {
  collect,
  ensembleModels,
  liveSmokeTargets,
  parseTimeoutMs,
  unifiedHarnessKinds
} from "../shared/options.js";
import { registerEnsembleConfig } from "./ensemble-config.js";
import { buildGatewayCommand } from "./ensemble-gateway.js";
import {
  type HandoffPayload,
  handoffSideEffects,
  parseHandoffTask,
  readStdinJson,
  recordsForResult,
  renderEnsembleSummary,
  renderHarnessSmokeDashboardSummary,
  safeId,
  selectHandoffHarness,
  skippedHandoffRecords,
  writeEnsembleOutput
} from "./ensemble-records.js";

type EnsembleRunOpts = {
  harness: string;
  command?: string;
  repo: string;
  out?: string;
  id?: string;
  model?: string[];
  judge: string;
  policy: string;
  timeoutMs?: string;
  taskFile?: string;
};

type EnsembleHandoffOpts = {
  harness: string;
  command?: string;
  repo: string;
  out?: string;
  id?: string;
  model?: string[];
  judge: string;
  policy: string;
  timeoutMs?: string;
};

type EnsembleDashboardOpts = {
  repo: string;
  out?: string;
  timeoutMs?: string;
  liveSmoke?: string[];
};

type EnsembleE2EOpts = {
  fusionBackend?: string;
  harness?: string[];
  command?: string;
  repo: string;
  out?: string;
  id?: string;
  model?: string[];
  judgeModel?: string;
  timeoutMs?: string;
  taskFile?: string;
};

async function runEnsembleRun(task: string[], opts: EnsembleRunOpts): Promise<void> {
  const prompt =
    opts.taskFile !== undefined ? readFileSync(opts.taskFile, "utf8") : task.join(" ").trim();
  if (!prompt.trim()) fail("a task prompt or --task-file is required");
  const harnessId = opts.harness;
  if (harnessId !== "mock" && harnessId !== "command") {
    fail('--harness must be "mock" or "command"');
  }
  const repo = resolve(opts.repo);
  const outDir = resolve(opts.out ?? ".fusionkit/ensemble-cli");
  const timeoutMs = parseTimeoutMs(opts.timeoutMs, 30000);
  if (harnessId === "command" && !opts.command) {
    fail("--command is required when --harness command");
  }
  const id = opts.id ?? `ensemble_${Date.now()}`;
  const harness =
    harnessId === "command"
      ? createCommandHarness({ command: opts.command ?? "", cwd: repo, timeoutMs })
      : createMockHarness();
  const judgeId = opts.judge;
  const descriptor: EnsembleDescriptor = {
    id,
    harness,
    models: ensembleModels(opts.model, harnessId),
    runtime: { id: "local" },
    judge:
      judgeId === "none"
        ? { id: "none" }
        : {
            id: judgeId,
            synthesizer: createMockJudgeSynthesizer({
              output: {
                decision: "synthesize",
                finalOutput: "CI-safe ensemble smoke synthesis",
                rationale: "synthetic smoke run",
                patch: { content: "", author: "judge" }
              }
            })
          },
    policy: {
      id: opts.policy,
      allowedTools: harnessId === "command" ? ["shell_command"] : ["read_file"],
      sideEffects: harnessId === "command" ? "tool_execution" : "read_only",
      timeoutMs
    },
    prompt,
    sourceRepo: "handoffkit",
    baseGitSha: gitText(repo, ["rev-parse", "HEAD"]).trim(),
    workspace: repo,
    outputRoot: outDir,
    cleanupWorktrees: true
  };
  const result = await runEnsemble(descriptor);
  assertHarnessRunRequestV1(result.harnessRunRequest);
  assertHarnessRunResultV1(result.harnessRunResult);
  writeEnsembleOutput(outDir, result);
  uiStream().write(renderEnsembleSummary(outDir, result) + "\n");
  if (result.harnessRunResult.status !== "succeeded" || result.failureSummary) {
    process.exitCode = 1;
  }
}

async function runEnsembleHandoff(extra: string[], opts: EnsembleHandoffOpts): Promise<void> {
  if (extra.length > 0) {
    fail("ensemble handoff reads task payload from stdin and does not accept positional arguments");
  }
  const payload = readStdinJson();
  const task = parseHandoffTask(payload);
  const repo = resolve(opts.repo);
  const outDir = resolve(opts.out ?? ".warrant/ensemble-handoff");
  const timeoutMs = parseTimeoutMs(opts.timeoutMs, 30000);
  const id = opts.id ?? `handoff_${safeId(task.task_id)}`;
  const harnessId = opts.harness;
  const selection = selectHandoffHarness(harnessId, opts.command, repo, timeoutMs);
  if ("skipReason" in selection) {
    process.stdout.write(
      JSON.stringify({
        records: skippedHandoffRecords({
          task,
          descriptorId: id,
          repo,
          harnessKind: selection.harnessKind,
          harnessId: selection.harnessId,
          reason: selection.skipReason
        })
      }) + "\n"
    );
    return;
  }

  const handoffPayload = payload as HandoffPayload;
  const descriptor: EnsembleDescriptor = {
    id,
    harness: selection.harness,
    models: ensembleModels(opts.model, harnessId),
    runtime: { id: "handoff-local" },
    judge: {
      id: opts.judge,
      synthesizer: createMockJudgeSynthesizer({
        output: {
          decision: "synthesize",
          finalOutput: "CI-safe handoff synthesis",
          rationale: "synthetic handoff smoke run",
          patch: { content: "", author: "judge" }
        }
      })
    },
    policy: {
      id: opts.policy ?? "handoff-smoke",
      allowedTools: task.allowed_tools,
      sideEffects: handoffSideEffects(harnessId, task),
      timeoutMs
    },
    prompt: task.prompt ?? "",
    sourceRepo: "handoffkit",
    baseGitSha: gitText(repo, ["rev-parse", "HEAD"]).trim(),
    workspace: repo,
    outputRoot: outDir,
    cleanupWorktrees: true,
    metadata: {
      handoff_protocol: "fusionkit-command-v1",
      benchmark_task_id: task.task_id,
      ...(typeof handoffPayload.manifest_path === "string"
        ? { benchmark_manifest_path: handoffPayload.manifest_path }
        : {}),
      ...(typeof handoffPayload.category === "string"
        ? { benchmark_category: handoffPayload.category }
        : {})
    }
  };
  const result = await runEnsemble(descriptor);
  writeEnsembleOutput(outDir, result);
  process.stdout.write(JSON.stringify({ records: recordsForResult(task, result) }) + "\n");
}

async function runEnsembleDashboard(extra: string[], opts: EnsembleDashboardOpts): Promise<void> {
  if (extra.length > 0) fail("ensemble dashboard does not accept positional arguments");
  const timeoutMs = parseTimeoutMs(opts.timeoutMs, 30000);
  const dashboard = await runHarnessSmokeDashboard({
    repo: resolve(opts.repo),
    ...(opts.out !== undefined ? { outputRoot: resolve(opts.out) } : {}),
    timeoutMs,
    liveSmoke: liveSmokeTargets(opts.liveSmoke)
  });
  uiStream().write(renderHarnessSmokeDashboardSummary(dashboard) + "\n");
  if (
    dashboard.records.some(
      (record) => record.purpose === "live" && record.result.status !== "succeeded"
    )
  ) {
    process.exitCode = 1;
  }
}

async function runEnsembleE2E(task: string[], opts: EnsembleE2EOpts): Promise<void> {
  const prompt =
    opts.taskFile !== undefined ? readFileSync(opts.taskFile, "utf8") : task.join(" ").trim();
  if (!prompt.trim()) fail("a task prompt or --task-file is required");
  const fusionBackendUrl = opts.fusionBackend;
  if (!fusionBackendUrl) fail("--fusion-backend is required");
  const timeoutMs = parseTimeoutMs(opts.timeoutMs, 30000);
  const repo = resolve(opts.repo);
  const outDir = resolve(opts.out ?? ".warrant/ensemble-e2e");
  const models = ensembleModels(opts.model);
  const result = await runUnifiedHarnessE2E({
    id: opts.id ?? `unified_${Date.now()}`,
    fusionBackendUrl,
    repo,
    outputRoot: outDir,
    prompt,
    harnesses: unifiedHarnessKinds(opts.harness),
    models,
    ...(opts.command !== undefined ? { command: opts.command } : {}),
    timeoutMs,
    ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {})
  });
  const counts = new Map<string, number>();
  for (const row of result.results) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const countText = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
  uiStream().write(`unified e2e [${countText}]\n`);
  uiStream().write(`results: ${result.results.length}\n`);
  uiStream().write(`report: ${result.reportPath}\n`);
  for (const row of result.results) {
    uiStream().write(`  ${row.harness}: ${row.status} (${row.message})\n`);
  }
  if (result.results.some((row) => row.status === "failed")) {
    process.exitCode = 1;
  }
}

export function registerEnsemble(program: Command): void {
  const ensemble = new Command("ensemble").description(
    "manage named ensembles; advanced subcommands are harness-dev tools"
  );

  registerEnsembleConfig(ensemble);

  ensemble
    .command("run")
    .description("advanced/maintainer: run a local ensemble smoke")
    .argument("[task...]", "task prompt")
    .option("--harness <h>", "harness to run: mock | command", "mock")
    .option("--command <cmd>", "shell command for command harness")
    .option("--repo <dir>", "workspace repository", ".")
    .option("--out <dir>", "output directory")
    .option("--id <id>", "descriptor id")
    .option("--model <spec>", "candidate model mapping ID=MODEL (repeatable)", collect)
    .option("--judge <id>", "judge id", "mock")
    .option("--policy <id>", "policy id", "local-smoke")
    .option("--timeout-ms <n>", "command timeout")
    .option("--task-file <file>", "read task prompt from file")
    .action(runEnsembleRun);

  ensemble
    .command("handoff")
    .description("advanced/maintainer: FusionKit stdin/stdout handoff executor")
    .argument("[extra...]", "(handoff reads its task from stdin)")
    .option("--harness <h>", "mock | command | claude-code | codex", "mock")
    .option("--command <cmd>", "shell command for command harness")
    .option("--repo <dir>", "workspace repository", ".")
    .option("--out <dir>", "output directory")
    .option("--id <id>", "descriptor id")
    .option("--model <spec>", "candidate model mapping ID=MODEL (repeatable)", collect)
    .option("--judge <id>", "judge id", "mock")
    .option("--policy <id>", "policy id", "local-smoke")
    .option("--timeout-ms <n>", "command/coding harness timeout")
    .action(runEnsembleHandoff);

  ensemble
    .command("dashboard")
    .description("advanced/maintainer: generate a harness smoke dashboard")
    .argument("[extra...]", "(dashboard takes no positional arguments)")
    .option("--repo <dir>", "workspace repository", ".")
    .option("--out <dir>", "output directory")
    .option("--timeout-ms <n>", "command timeout")
    .option("--live-smoke <target>", "include env-gated live smoke: claude-code | codex (repeatable)", collect)
    .action(runEnsembleDashboard);

  ensemble
    .command("e2e")
    .description("advanced/maintainer: run the unified FusionKit-backed harness matrix")
    .argument("[task...]", "task prompt")
    .option("--fusion-backend <url>", "FusionKit/OpenAI-compatible backend URL")
    .option("--harness <target>", "mock | command | codex | claude-code | cursor-acp | cursor-desktop (repeatable)", collect)
    .option("--command <cmd>", "command harness script")
    .option("--repo <dir>", "workspace repository", ".")
    .option("--out <dir>", "output directory")
    .option("--id <id>", "descriptor id")
    .option("--model <spec>", "panel model mapping ID=MODEL (repeatable)", collect)
    .option("--judge-model <model>", "model used for judge synthesis")
    .option("--timeout-ms <n>", "candidate timeout")
    .option("--task-file <file>", "read task prompt from file")
    .action(runEnsembleE2E);

  ensemble.addCommand(buildGatewayCommand());

  program.addCommand(ensemble);
}
