import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createCommandHarness, createMockHarness } from "@fusionkit/ensemble";
import type { EnsembleRunResult, HarnessAdapter } from "@fusionkit/ensemble";

import { bold, dim, glyph, green, red } from "@fusionkit/cli-ui";

import type { HarnessSmokeDashboard } from "../dashboard.js";
import {
  assertBenchmarkTaskRecordV1,
  assertHarnessCandidateRecordV1,
  assertJudgeSynthesisRecordV1,
  assertModelCallRecordV1,
  assertModelFusionRecord,
  assertToolExecutionRecordV1,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH
} from "@fusionkit/protocol";
import type {
  BenchmarkTaskRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  ModelFusionHarnessKind,
  ModelFusionRecordV1,
  ModelFusionSideEffects,
  ToolExecutionRecordV1
} from "@fusionkit/protocol";
import { gitText } from "@fusionkit/workspace";

import { fail } from "../shared/errors.js";
import { toolRegistry } from "../tools.js";

export type HandoffPayload = {
  category?: string;
  manifest_path?: string;
  task?: unknown;
};

export type HandoffHarnessSelection =
  | { harness: HarnessAdapter; harnessKind: ModelFusionHarnessKind }
  | { skipReason: string; harnessKind: ModelFusionHarnessKind; harnessId: string };

export function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function writeEnsembleOutput(outDir: string, result: EnsembleRunResult): void {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "candidates"), { recursive: true });
  mkdirSync(join(outDir, "model-call-records"), { recursive: true });
  writeJson(join(outDir, "summary.json"), result.summary ?? {});
  writeJson(join(outDir, "harness-run-request.json"), result.harnessRunRequest);
  writeJson(join(outDir, "harness-run-result.json"), result.harnessRunResult);
  for (const candidate of result.candidates) {
    assertHarnessCandidateRecordV1(candidate);
    writeJson(join(outDir, "candidates", `${safeId(candidate.candidate_id)}.json`), candidate);
  }
  for (const record of result.modelCallRecords) {
    assertModelCallRecordV1(record);
    writeJson(join(outDir, "model-call-records", `${safeId(record.call_id)}.json`), record);
  }
  if (result.judgeSynthesisRecord !== undefined) {
    assertJudgeSynthesisRecordV1(result.judgeSynthesisRecord);
    writeJson(join(outDir, "judge-synthesis-record.json"), result.judgeSynthesisRecord);
  }
}

export function readStdinJson(): unknown {
  const input = readFileSync(0, "utf8").trim();
  if (!input) fail("handoff payload is required on stdin");
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    fail(`handoff payload must be valid JSON: ${(error as Error).message}`);
  }
}

export function parseHandoffTask(payload: unknown): BenchmarkTaskRecordV1 {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    fail("handoff payload must be a JSON object");
  }
  const task = (payload as HandoffPayload).task;
  assertBenchmarkTaskRecordV1(task);
  return task;
}

export function baseGitSha(repo: string): string {
  try {
    return gitText(repo, ["rev-parse", "HEAD"]).trim();
  } catch {
    return "0".repeat(40);
  }
}

function metadata<S extends ModelFusionRecordV1["schema"]>(schema: S, createdAt: string) {
  return {
    schema,
    schema_version: "v1" as const,
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: "handoffkit-cli",
    producer_version: "0.1.0",
    producer_git_sha: "0".repeat(40),
    created_at: createdAt
  };
}

function toolRecordsForResult(result: EnsembleRunResult): ToolExecutionRecordV1[] {
  return result.toolRecords.map((record): ToolExecutionRecordV1 => {
    const toolRecord: ToolExecutionRecordV1 = {
      ...metadata("tool-execution-record.v1", result.harnessRunResult.created_at),
      execution_id: record.execution_id,
      plan_id: record.plan_id,
      status: record.status,
      ...(record.output_hash !== undefined ? { output_hash: record.output_hash } : {}),
      ...(record.error !== undefined ? { error: record.error } : {})
    };
    assertToolExecutionRecordV1(toolRecord);
    return toolRecord;
  });
}

export function recordsForResult(
  task: BenchmarkTaskRecordV1,
  result: EnsembleRunResult
): ModelFusionRecordV1[] {
  const toolRecords = toolRecordsForResult(result);
  const records: ModelFusionRecordV1[] = [
    task,
    result.harnessRunRequest,
    result.harnessRunResult,
    ...result.candidates,
    ...result.modelCallRecords,
    ...toolRecords
  ];
  if (result.judgeSynthesisRecord !== undefined) records.push(result.judgeSynthesisRecord);
  for (const record of records) assertModelFusionRecord(record);
  return records;
}

export function skippedHandoffRecords(input: {
  task: BenchmarkTaskRecordV1;
  descriptorId: string;
  repo: string;
  harnessKind: ModelFusionHarnessKind;
  harnessId: string;
  reason: string;
}): ModelFusionRecordV1[] {
  const createdAt = new Date().toISOString();
  const request: HarnessRunRequestV1 = {
    ...metadata("harness-run-request.v1", createdAt),
    request_id: `ensemble_req_${input.descriptorId}`,
    harness_kind: input.harnessKind,
    source_repo: "handoffkit",
    base_git_sha: baseGitSha(input.repo),
    prompt: input.task.prompt ?? "",
    prompt_hash: input.task.prompt_hash,
    allowed_tools: input.task.allowed_tools,
    side_effects: "unknown",
    requested_capabilities: { coding_harness: "unsupported" },
    metadata: {
      harness_id: input.harnessId,
      skipped: true,
      skip_reason: input.reason
    }
  };
  const result: HarnessRunResultV1 = {
    ...metadata("harness-run-result.v1", createdAt),
    result_id: `ensemble_result_${input.descriptorId}`,
    request_id: request.request_id,
    harness_kind: input.harnessKind,
    status: "skipped",
    candidate_ids: [],
    output_summary: input.reason,
    capabilities: { coding_harness: "unsupported" },
    started_at: createdAt,
    finished_at: createdAt,
    errors: [{ kind: "capability_missing", message: input.reason, retryable: false }],
    metadata: {
      descriptor_id: input.descriptorId,
      harness_id: input.harnessId,
      skipped: true
    }
  };
  const records: ModelFusionRecordV1[] = [input.task, request, result];
  for (const record of records) assertModelFusionRecord(record);
  return records;
}

export function selectHandoffHarness(
  harnessId: string,
  command: string | undefined,
  repo: string,
  timeoutMs: number
): HandoffHarnessSelection {
  const integration = toolRegistry.get(harnessId);
  const dashboard = integration?.dashboard ?? toolRegistry.dashboardTools().find((tool) => tool.id === harnessId);
  switch (harnessId) {
    case "mock":
      return { harness: createMockHarness(), harnessKind: "generic" };
    case "command":
      if (!command) fail("--command is required when --harness command");
      return {
        harness: createCommandHarness({ command, cwd: repo, timeoutMs }),
        harnessKind: "generic"
      };
    default:
      if (dashboard !== undefined) {
        const reason = dashboard.credentialSkipReason(process.env);
        if (reason !== undefined) {
          return { skipReason: reason, harnessKind: dashboard.harnessKind, harnessId };
        }
        return {
          harness: dashboard.makeMatrixHarness({ env: process.env, repo, timeoutMs }),
          harnessKind: dashboard.harnessKind
        };
      }
      fail(
        `--harness must be "mock", "command", or one of: ${toolRegistry
          .dashboardTools()
          .map((tool) => `"${tool.id}"`)
          .join(", ")}`
      );
  }
}

export function handoffSideEffects(
  harness: string | undefined,
  task: BenchmarkTaskRecordV1
): ModelFusionSideEffects {
  if (harness === "command") return "tool_execution";
  const writeTools = new Set(["apply_patch", "write_file", "run_tests", "shell_command"]);
  return task.allowed_tools.some((tool) => writeTools.has(tool)) ? "writes_workspace" : "read_only";
}

/** A status-colored glyph: green tick for success, red cross otherwise. */
function statusMark(status: string): string {
  return status === "succeeded" ? green(glyph.tick()) : red(glyph.cross());
}

export function renderEnsembleSummary(outDir: string, result: EnsembleRunResult): string {
  const lines = [
    `${statusMark(result.harnessRunResult.status)} ${bold(`ensemble ${result.descriptorId} [${result.harnessRunResult.status}]`)}`,
    `${dim("candidates:")} ${result.candidates.length}`,
    ...result.candidates.map(
      (candidate) => `  ${statusMark(candidate.status)} ${candidate.candidate_id}: ${candidate.status}`
    ),
    `${dim("verification:")} ${result.verification.id}`,
    result.judgeSynthesisRecord
      ? `${dim("judge:")} ${result.judgeSynthesisRecord.status}/${result.judgeSynthesisRecord.decision}`
      : `${dim("judge:")} none`,
    dim(`output: ${outDir}`),
    dim(`summary: ${join(outDir, "summary.json")}`)
  ];
  return lines.join("\n");
}

export function renderHarnessSmokeDashboardSummary(dashboard: HarnessSmokeDashboard): string {
  const counts = new Map<string, number>();
  for (const record of dashboard.records) {
    counts.set(record.result.status, (counts.get(record.result.status) ?? 0) + 1);
  }
  const countText = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
  const allPassed = dashboard.records.every((record) => record.result.status === "succeeded");
  return [
    `${allPassed ? green(glyph.tick()) : red(glyph.cross())} ${bold(`harness dashboard [${countText}]`)}`,
    `${dim("records:")} ${dashboard.records.length}`,
    dim(`dashboard: ${dashboard.dashboardPath}`),
    dim(`output: ${dashboard.outputRoot}`)
  ].join("\n");
}
