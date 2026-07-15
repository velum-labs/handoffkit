import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  assertHarnessRunResultV1,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH
} from "@fusionkit/protocol";
import type {
  ArtifactRef,
  HarnessRunResultV1,
  ModelFusionHarnessKind,
  ModelFusionSideEffects
} from "@fusionkit/protocol";
import { gitText } from "@fusionkit/workspace";
import type { CapabilityStatus, JsonValue } from "@routekit/contracts";

import {
  COMMAND_DASHBOARD_CAPABILITIES,
  createCommandHarness,
  createMockHarness,
  MOCK_DASHBOARD_CAPABILITIES,
  MOCK_DASHBOARD_IDENTITY,
  runEnsemble
} from "@fusionkit/ensemble";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessAdapter,
  HarnessCapabilities
} from "@fusionkit/ensemble";
import { ensureRunOutputDir } from "@fusionkit/runtime-utils";
import { envFlagEnabled, markdownTable, readEnv } from "@fusionkit/tools";
import type { ToolDashboardMetadata } from "@fusionkit/tools";

import { toolRegistry } from "./tools.js";

const PRODUCER_GIT_SHA = "0".repeat(40);
const PRODUCER = "handoffkit-ensemble";
const PRODUCER_VERSION = "0.1.0";
const ZERO_GIT_SHA = "0".repeat(40);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT = "Run the CI-safe harness smoke task and report concise evidence.";
const DEFAULT_COMMAND_SUCCESS = "printf command-ok";
const DEFAULT_COMMAND_FAILURE = "exit 7";
const DEFAULT_OUTPUT_DIR = ".fusionkit/ensemble-dashboard";
const ALL_LIVE_SMOKE_ENV = "FUSIONKIT_ENSEMBLE_LIVE_SMOKE";

// The generic (non-tool) harness capability profiles are owned by their
// implementations in @fusionkit/ensemble (command.ts / mock.ts), where each
// unsupported/degraded status is documented next to the code that causes it.

/** Dashboard target id (a tool id like "claude-code", or "command"/"mock"). */
export type HarnessCapabilityTarget = string;
export type HarnessAvailability = "available" | "credential_gated" | "missing";
/** A tool id that exposes a live smoke (e.g. "claude-code", "codex", "cursor"). */
export type HarnessLiveSmokeTarget = string;
export type HarnessSmokePurpose = "contract" | "credential-skip" | "live" | "missing";

export type HarnessAdapterReadiness = {
  harnessId: HarnessCapabilityTarget;
  displayName: string;
  contractReadiness: string;
  credentialState: string;
  liveSmoke: string;
  evidence: string[];
  artifactRefs: string[];
};

export type HarnessCapabilityMatrixRow = {
  harnessId: HarnessCapabilityTarget;
  harnessKind: ModelFusionHarnessKind;
  displayName: string;
  availability: HarnessAvailability;
  capabilities: HarnessCapabilities;
  notes: string[];
};

export type HarnessCapabilityMatrix = {
  capabilities: string[];
  rows: HarnessCapabilityMatrixRow[];
};

export type HarnessSmokeOutcome = "success" | "failure" | "missing" | "skipped";

export type HarnessSmokeRecord = {
  taskId: string;
  harnessId: HarnessCapabilityTarget;
  purpose: HarnessSmokePurpose;
  outcome: HarnessSmokeOutcome;
  result: HarnessRunResultV1;
  resultPath: string;
};

export type HarnessSmokeDashboard = {
  outputRoot: string;
  dashboardPath: string;
  matrix: HarnessCapabilityMatrix;
  records: HarnessSmokeRecord[];
  readiness: HarnessAdapterReadiness[];
};

export type HarnessSmokeDashboardOptions = {
  repo?: string;
  outputRoot?: string;
  timeoutMs?: number;
  createdAt?: string;
  env?: Record<string, string | undefined>;
  commandSuccess?: string;
  commandFailure?: string;
  liveSmoke?: readonly HarnessLiveSmokeTarget[];
  liveSmokeHarnesses?: Partial<Record<HarnessLiveSmokeTarget, HarnessAdapter>>;
  /** Per-tool dashboard metadata; defaults to the registered tool registry. */
  tools?: readonly ToolDashboardMetadata[];
};

type SmokeRunInput = {
  taskId: string;
  harnessId: HarnessCapabilityTarget;
  harnessKind: ModelFusionHarnessKind;
  purpose: HarnessSmokePurpose;
  outcome: HarnessSmokeOutcome;
  harness: HarnessAdapter;
  model: EnsembleModel;
  sideEffects: ModelFusionSideEffects;
  allowedTools: string[];
  /** Dashboard capability overlay used for the live preflight-failure record. */
  capabilities: HarnessCapabilities;
  prompt?: string;
  preflightFailureReason?: string;
};

function metadata<S extends "harness-run-result.v1">(schema: S, createdAt: string) {
  return {
    schema,
    schema_version: "v1" as const,
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
    created_at: createdAt
  };
}

function dashboardTools(options: HarnessSmokeDashboardOptions): readonly ToolDashboardMetadata[] {
  return options.tools ?? toolRegistry.dashboardTools();
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function liveSmokeEnvEnabled(
  env: Record<string, string | undefined>,
  tool: ToolDashboardMetadata
): boolean {
  return (
    tool.liveSmoke !== undefined &&
    (envFlagEnabled(env, ALL_LIVE_SMOKE_ENV) || envFlagEnabled(env, tool.liveSmoke.envName))
  );
}

function requestedLiveSmokeTools(options: {
  env: Record<string, string | undefined>;
  tools: readonly ToolDashboardMetadata[];
  liveSmoke?: readonly HarnessLiveSmokeTarget[];
}): ToolDashboardMetadata[] {
  const liveCapable = options.tools.filter((tool) => tool.liveSmoke !== undefined);
  const selected =
    options.liveSmoke?.length
      ? liveCapable.filter((tool) => options.liveSmoke?.includes(tool.id))
      : liveCapable;
  return selected.filter((tool) => liveSmokeEnvEnabled(options.env, tool));
}

function descriptorForCapabilities(harness: HarnessAdapter): EnsembleDescriptor {
  return {
    id: "capability_matrix",
    harness,
    models: [{ id: "capability", model: "capability-model" }],
    runtime: { id: "local" },
    judge: { id: "none" },
    policy: {
      id: "capability-policy",
      allowedTools: ["read_file"],
      sideEffects: "read_only",
      timeoutMs: DEFAULT_TIMEOUT_MS
    },
    prompt: DEFAULT_PROMPT,
    sourceRepo: "handoffkit",
    baseGitSha: ZERO_GIT_SHA
  };
}

function adapterCapabilities(harness: HarnessAdapter): HarnessCapabilities {
  return harness.capabilities(descriptorForCapabilities(harness));
}

function mergeCapabilities(
  adapter: HarnessCapabilities,
  overlay: HarnessCapabilities
): HarnessCapabilities {
  return { ...adapter, ...overlay };
}

function matrixRow(input: {
  harnessId: HarnessCapabilityTarget;
  harnessKind: ModelFusionHarnessKind;
  displayName: string;
  availability: HarnessAvailability;
  capabilities: HarnessCapabilities;
  notes: string[];
}): HarnessCapabilityMatrixRow {
  return input;
}

export function createHarnessCapabilityMatrix(
  options: HarnessSmokeDashboardOptions = {}
): HarnessCapabilityMatrix {
  const env = options.env ?? {};
  const toolRows = dashboardTools(options).map((tool) =>
    matrixRow({
      harnessId: tool.id,
      harnessKind: tool.harnessKind,
      displayName: tool.displayName,
      availability: tool.availability,
      capabilities: mergeCapabilities(
        adapterCapabilities(tool.makeMatrixHarness({ env })),
        tool.capabilities
      ),
      notes: tool.notes
    })
  );
  const rows = [
    ...toolRows,
    matrixRow({
      harnessId: "command",
      harnessKind: "generic",
      displayName: "Command",
      availability: "available",
      capabilities: mergeCapabilities(
        adapterCapabilities(
          createCommandHarness({
            command: options.commandSuccess ?? DEFAULT_COMMAND_SUCCESS,
            cwd: options.repo
          })
        ),
        COMMAND_DASHBOARD_CAPABILITIES
      ),
      notes: ["Runs local shell commands through the command harness."]
    }),
    matrixRow({
      harnessId: MOCK_DASHBOARD_IDENTITY.id,
      harnessKind: MOCK_DASHBOARD_IDENTITY.harnessKind,
      displayName: MOCK_DASHBOARD_IDENTITY.displayName,
      availability: "available",
      capabilities: mergeCapabilities(
        adapterCapabilities(createMockHarness()),
        MOCK_DASHBOARD_CAPABILITIES
      ),
      notes: [...MOCK_DASHBOARD_IDENTITY.notes]
    })
  ];

  const capabilities = [...new Set(rows.flatMap((row) => Object.keys(row.capabilities)))].sort();
  return { capabilities, rows };
}

function currentGitSha(repo: string): string {
  try {
    const sha = gitText(repo, ["rev-parse", "HEAD"]).trim();
    return sha.length > 0 ? sha : ZERO_GIT_SHA;
  } catch {
    return ZERO_GIT_SHA;
  }
}

function smokeDescriptor(input: {
  id: string;
  harness: HarnessAdapter;
  model: EnsembleModel;
  repo: string;
  baseGitSha: string;
  outputRoot: string;
  sideEffects: ModelFusionSideEffects;
  allowedTools: string[];
  timeoutMs: number;
  prompt: string;
}): EnsembleDescriptor {
  return {
    id: input.id,
    harness: input.harness,
    models: [input.model],
    runtime: { id: "local" },
    judge: { id: "none" },
    policy: {
      id: `${input.id}_policy`,
      allowedTools: input.allowedTools,
      sideEffects: input.sideEffects,
      timeoutMs: input.timeoutMs
    },
    prompt: input.prompt,
    sourceRepo: input.repo,
    baseGitSha: input.baseGitSha,
    outputRoot: join(input.outputRoot, "runs", input.id)
  };
}

function liveSmokePreflightFailureResult(input: {
  createdAt: string;
  taskId: string;
  harnessKind: ModelFusionHarnessKind;
  capabilities: HarnessCapabilities;
  reason: string;
}): HarnessRunResultV1 {
  const result: HarnessRunResultV1 = {
    ...metadata("harness-run-result.v1", input.createdAt),
    result_id: `ensemble_result_${input.taskId}`,
    request_id: `ensemble_req_${input.taskId}`,
    harness_kind: input.harnessKind,
    status: "failed",
    candidate_ids: [],
    output_summary: `Explicit live smoke failed before launch: ${input.reason}`,
    capabilities: input.capabilities,
    started_at: input.createdAt,
    finished_at: input.createdAt,
    errors: [
      {
        kind: "capability_missing",
        message: input.reason,
        retryable: false
      }
    ],
    metadata: {
      dashboard_outcome: "failure",
      harness_id: input.taskId,
      live_smoke: true,
      preflight: "credentials"
    }
  };
  assertHarnessRunResultV1(result);
  return result;
}

function failSkippedLiveSmokeResult(
  result: HarnessRunResultV1,
  taskId: string
): HarnessRunResultV1 {
  if (result.status !== "skipped") return result;
  const metadata: Record<string, JsonValue> = {
    ...(result.metadata ?? {}),
    dashboard_outcome: "failure",
    explicit_live_smoke: true,
    original_status: "skipped"
  };
  const promoted: HarnessRunResultV1 = {
    ...result,
    status: "failed",
    output_summary:
      `Explicit live smoke ${taskId} failed because the adapter returned skipped. ` +
      (result.output_summary ?? ""),
    errors: [
      ...(result.errors ?? []),
      {
        kind: "capability_missing",
        message: "Explicit live smoke was requested but the adapter returned skipped.",
        retryable: false
      }
    ],
    metadata
  };
  assertHarnessRunResultV1(promoted);
  return promoted;
}

function writeRunResult(outputRoot: string, taskId: string, result: HarnessRunResultV1): string {
  const dir = join(outputRoot, "harness-run-results");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeFileName(taskId)}.json`);
  assertHarnessRunResultV1(result);
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  return path;
}

async function runSmokeTask(input: {
  run: SmokeRunInput;
  repo: string;
  baseGitSha: string;
  outputRoot: string;
  timeoutMs: number;
  createdAt: string;
}): Promise<HarnessSmokeRecord> {
  if (input.run.preflightFailureReason !== undefined) {
    const result = liveSmokePreflightFailureResult({
      createdAt: input.createdAt,
      taskId: input.run.taskId,
      harnessKind: input.run.harnessKind,
      capabilities: mergeCapabilities(adapterCapabilities(input.run.harness), input.run.capabilities),
      reason: input.run.preflightFailureReason
    });
    const resultPath = writeRunResult(input.outputRoot, input.run.taskId, result);
    return {
      taskId: input.run.taskId,
      harnessId: input.run.harnessId,
      purpose: input.run.purpose,
      outcome: input.run.outcome,
      result,
      resultPath
    };
  }

  const descriptor = smokeDescriptor({
    id: input.run.taskId,
    harness: input.run.harness,
    model: input.run.model,
    repo: input.repo,
    baseGitSha: input.baseGitSha,
    outputRoot: input.outputRoot,
    sideEffects: input.run.sideEffects,
    allowedTools: input.run.allowedTools,
    timeoutMs: input.timeoutMs,
    prompt: input.run.prompt ?? DEFAULT_PROMPT
  });
  const result = await runEnsemble(descriptor);
  const harnessRunResult =
    input.run.purpose === "live"
      ? failSkippedLiveSmokeResult(result.harnessRunResult, input.run.taskId)
      : result.harnessRunResult;
  const resultPath = writeRunResult(input.outputRoot, input.run.taskId, harnessRunResult);
  return {
    taskId: input.run.taskId,
    harnessId: input.run.harnessId,
    purpose: input.run.purpose,
    outcome: input.run.outcome,
    result: harnessRunResult,
    resultPath
  };
}

function genericSmokeRuns(options: Required<Pick<
  HarnessSmokeDashboardOptions,
  "commandSuccess" | "commandFailure"
>>): SmokeRunInput[] {
  return [
    {
      taskId: "mock-success",
      harnessId: "mock",
      harnessKind: "generic",
      purpose: "contract",
      outcome: "success",
      harness: createMockHarness(),
      model: { id: "mock", model: "synthetic-mock" },
      sideEffects: "read_only",
      allowedTools: ["read_file"],
      capabilities: MOCK_DASHBOARD_CAPABILITIES
    },
    {
      taskId: "command-success",
      harnessId: "command",
      harnessKind: "generic",
      purpose: "contract",
      outcome: "success",
      harness: createCommandHarness({ command: options.commandSuccess }),
      model: { id: "command", model: "local-shell" },
      sideEffects: "tool_execution",
      allowedTools: ["shell_command"],
      capabilities: COMMAND_DASHBOARD_CAPABILITIES
    },
    {
      taskId: "command-failure",
      harnessId: "command",
      harnessKind: "generic",
      purpose: "contract",
      outcome: "failure",
      harness: createCommandHarness({ command: options.commandFailure }),
      model: { id: "command", model: "local-shell" },
      sideEffects: "tool_execution",
      allowedTools: ["shell_command"],
      capabilities: COMMAND_DASHBOARD_CAPABILITIES
    }
  ];
}

function credentialSkipSmokeRuns(tools: readonly ToolDashboardMetadata[]): SmokeRunInput[] {
  return tools.map((tool) => ({
    taskId: tool.smoke.taskId,
    harnessId: tool.id,
    harnessKind: tool.harnessKind,
    purpose: "credential-skip",
    outcome: "skipped",
    harness: tool.smoke.makeHarness(),
    model: tool.smoke.model,
    sideEffects: tool.smoke.sideEffects,
    allowedTools: tool.smoke.allowedTools,
    capabilities: tool.capabilities
  }));
}

function liveSmokeRuns(options: {
  env: Record<string, string | undefined>;
  tools: readonly ToolDashboardMetadata[];
  harnesses?: Partial<Record<HarnessLiveSmokeTarget, HarnessAdapter>>;
}): SmokeRunInput[] {
  const runs: SmokeRunInput[] = [];
  for (const tool of options.tools) {
    const live = tool.liveSmoke;
    if (live === undefined) continue;
    const injectedHarness = options.harnesses?.[tool.id];
    const harness = injectedHarness ?? live.makeHarness(options.env);
    runs.push({
      taskId: live.taskId,
      harnessId: tool.id,
      harnessKind: tool.harnessKind,
      purpose: "live",
      outcome: "success",
      harness,
      model: { id: tool.smoke.model.id, model: readEnv(options.env, live.modelEnvName) ?? live.defaultModel },
      sideEffects: "read_only",
      allowedTools: ["read_file"],
      capabilities: tool.capabilities,
      prompt: live.prompt,
      preflightFailureReason: injectedHarness === undefined ? tool.credentialSkipReason(options.env) : undefined
    });
  }
  return runs;
}

function capabilityCell(
  capabilities: HarnessCapabilities,
  capability: string
): CapabilityStatus {
  return capabilities[capability] ?? "unknown";
}

function renderCapabilityMatrix(matrix: HarnessCapabilityMatrix): string[] {
  const header = [
    "Harness",
    "Kind",
    "Availability",
    ...matrix.capabilities,
    "Notes"
  ];
  const rows = matrix.rows.map((row) => [
      row.displayName,
      row.harnessKind,
      row.availability,
      ...matrix.capabilities.map((capability) => capabilityCell(row.capabilities, capability)),
      row.notes.join(" ")
    ]);
  return ["## Capability Matrix", "", ...markdownTable(header, rows)];
}

function relativePath(path: string, from: string): string {
  return path.startsWith(from) ? path.slice(from.length + 1) : path;
}

function safeArtifactRefs(artifacts: readonly ArtifactRef[] | undefined): string[] {
  if (artifacts === undefined || artifacts.length === 0) return [];
  const refs: string[] = [];
  let rawWithheld = 0;
  for (const artifact of artifacts) {
    if (artifact.redaction_status === "raw") {
      rawWithheld++;
      continue;
    }
    refs.push(`${artifact.kind}:${artifact.artifact_id}:${artifact.hash}`);
    if (refs.length >= 5) break;
  }
  if (rawWithheld > 0) refs.push(`${rawWithheld} raw artifact ref(s) withheld`);
  return refs;
}

function liveSmokeState(record: HarnessSmokeRecord | undefined): string {
  if (record === undefined) return "live smoke not requested";
  switch (record.result.status) {
    case "succeeded":
      return "live smoke passed";
    case "failed":
    case "canceled":
    case "requires_action":
    case "unsupported":
    case "pending":
    case "running":
      return "live smoke failed";
    case "skipped":
      return "live smoke skipped";
    default: {
      const exhausted: never = record.result.status;
      throw new Error(`unsupported live smoke status: ${String(exhausted)}`);
    }
  }
}

function createAdapterReadiness(input: {
  matrix: HarnessCapabilityMatrix;
  records: readonly HarnessSmokeRecord[];
  credentialStateFor: (harnessId: HarnessCapabilityTarget) => string;
  outputRoot: string;
}): HarnessAdapterReadiness[] {
  return input.matrix.rows.map((row) => {
    const liveRecord = input.records.find(
      (record) => record.harnessId === row.harnessId && record.purpose === "live"
    );
    const credentialRecord = input.records.find(
      (record) => record.harnessId === row.harnessId && record.purpose === "credential-skip"
    );
    const credentialState = input.credentialStateFor(row.harnessId);
    const evidence = [
      ...(credentialRecord !== undefined && credentialState.includes("missing")
        ? [`credential skip: ${relativePath(credentialRecord.resultPath, input.outputRoot)}`]
        : []),
      ...(liveRecord !== undefined
        ? [
            `live result: ${relativePath(liveRecord.resultPath, input.outputRoot)}`,
            `status=${liveRecord.result.status}`
          ]
        : [])
    ];
    return {
      harnessId: row.harnessId,
      displayName: row.displayName,
      contractReadiness: "contract/mock ready",
      credentialState,
      liveSmoke: liveSmokeState(liveRecord),
      evidence,
      artifactRefs: liveRecord !== undefined ? safeArtifactRefs(liveRecord.result.artifacts) : []
    };
  });
}

function renderAdapterReadiness(readiness: readonly HarnessAdapterReadiness[]): string[] {
  const rows = readiness.map((row) => [
    row.displayName,
    row.contractReadiness,
    row.credentialState,
    row.liveSmoke,
    row.evidence.length > 0 ? row.evidence.join("; ") : "-",
    row.artifactRefs.length > 0 ? row.artifactRefs.join("; ") : "-"
  ]);
  return [
    "## Adapter Readiness",
    "",
    ...markdownTable(
      [
        "Adapter",
        "Contract/Mock Readiness",
        "Credentials",
        "Live Smoke",
        "Last Evidence",
        "Safe Artifact Refs"
      ],
      rows
    )
  ];
}

function renderSmokeRecords(
  records: readonly HarnessSmokeRecord[],
  outputRoot: string,
  displayNameFor: (harnessId: HarnessCapabilityTarget) => string
): string[] {
  const rows = records.map((record) => [
    record.taskId,
    displayNameFor(record.harnessId),
    record.purpose,
    record.outcome,
    record.result.status,
    record.result.harness_kind,
    relativePath(record.resultPath, outputRoot),
    record.result.output_summary ?? ""
  ]);
  return [
    "## Smoke Records",
    "",
    ...markdownTable(
      [
        "Task",
        "Harness",
        "Purpose",
        "Expected",
        "Result Status",
        "Harness Kind",
        "Result Record",
        "Summary"
      ],
      rows
    )
  ];
}

function renderDashboard(input: {
  matrix: HarnessCapabilityMatrix;
  readiness: HarnessAdapterReadiness[];
  records: readonly HarnessSmokeRecord[];
  createdAt: string;
  outputRoot: string;
  displayNameFor: (harnessId: HarnessCapabilityTarget) => string;
}): string {
  const counts = new Map<string, number>();
  for (const record of input.records) {
    counts.set(record.result.status, (counts.get(record.result.status) ?? 0) + 1);
  }
  const countText = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(", ");
  return [
    "# HandoffKit Harness Smoke Dashboard",
    "",
    `Generated: ${input.createdAt}`,
    `Output root: ${input.outputRoot}`,
    `Run-result status counts: ${countText}`,
    "",
    ...renderCapabilityMatrix(input.matrix),
    "",
    ...renderAdapterReadiness(input.readiness),
    "",
    ...renderSmokeRecords(input.records, input.outputRoot, input.displayNameFor),
    ""
  ].join("\n");
}

export async function runHarnessSmokeDashboard(
  options: HarnessSmokeDashboardOptions = {}
): Promise<HarnessSmokeDashboard> {
  const repo = resolve(options.repo ?? process.cwd());
  const outputRoot = resolve(options.outputRoot ?? join(repo, DEFAULT_OUTPUT_DIR));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const commandSuccess = options.commandSuccess ?? DEFAULT_COMMAND_SUCCESS;
  const commandFailure = options.commandFailure ?? DEFAULT_COMMAND_FAILURE;
  const env = options.env ?? process.env;
  const tools = dashboardTools(options);
  ensureRunOutputDir(outputRoot);

  const matrix = createHarnessCapabilityMatrix({
    ...options,
    repo,
    commandSuccess,
    commandFailure,
    env
  });

  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const displayNameFor = (harnessId: HarnessCapabilityTarget): string =>
    toolsById.get(harnessId)?.displayName ??
    matrix.rows.find((row) => row.harnessId === harnessId)?.displayName ??
    harnessId;
  const credentialStateFor = (harnessId: HarnessCapabilityTarget): string => {
    const tool = toolsById.get(harnessId);
    if (tool === undefined) return "not required";
    return tool.credentialSkipReason(env) === undefined
      ? "credentials available"
      : "credentials missing/skipped";
  };

  const baseGitSha = currentGitSha(repo);
  const records: HarnessSmokeRecord[] = [];
  const runs = [
    ...genericSmokeRuns({ commandSuccess, commandFailure }),
    ...credentialSkipSmokeRuns(tools),
    ...liveSmokeRuns({
      env,
      tools: requestedLiveSmokeTools({ env, tools, liveSmoke: options.liveSmoke }),
      harnesses: options.liveSmokeHarnesses
    })
  ];
  for (const run of runs) {
    records.push(
      await runSmokeTask({
        run,
        repo,
        baseGitSha,
        outputRoot,
        timeoutMs,
        createdAt
      })
    );
  }
  const readiness = createAdapterReadiness({
    matrix,
    records,
    credentialStateFor,
    outputRoot
  });

  const dashboardPath = join(outputRoot, "dashboard.md");
  writeFileSync(
    dashboardPath,
    renderDashboard({
      matrix,
      readiness,
      records,
      createdAt,
      outputRoot,
      displayNameFor
    })
  );
  return {
    outputRoot,
    dashboardPath,
    matrix,
    records,
    readiness
  };
}

export const harnessDashboard = {
  capabilities: createHarnessCapabilityMatrix,
  run: runHarnessSmokeDashboard
} as const;
