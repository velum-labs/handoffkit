import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  assertHarnessRunResultV1
} from "@warrant/protocol";
import type {
  ArtifactRef,
  HarnessRunResultV1,
  JsonValue,
  ModelFusionCapabilityStatus,
  ModelFusionHarnessKind,
  ModelFusionSideEffects
} from "@warrant/protocol";
import { gitText } from "@warrant/workspace";

import {
  claudeCodeHarness,
  claudeCodeHarnessCredentialSkipReason
} from "./claude-code.js";
import { createCommandHarness } from "./command.js";
import { codexHarness, codexHarnessCredentialSkipReason } from "./codex.js";
import { createMockHarness } from "./mock.js";
import { runEnsemble } from "./run.js";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessAdapter,
  HarnessCapabilities
} from "./harness.js";

const SCHEMA_BUNDLE_HASH =
  "sha256:75792f89c091b6ab4fd317a15fb03fd73438563dceff5ccf9f5d7c752dbf35f3";
const PRODUCER_GIT_SHA = "0".repeat(40);
const PRODUCER = "handoffkit-ensemble";
const PRODUCER_VERSION = "0.1.0";
const ZERO_GIT_SHA = "0".repeat(40);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PROMPT = "Run the CI-safe harness smoke task and report concise evidence.";
const DEFAULT_COMMAND_SUCCESS = "printf command-ok";
const DEFAULT_COMMAND_FAILURE = "exit 7";
const DEFAULT_OUTPUT_DIR = ".warrant/ensemble-dashboard";
const CLAUDE_LIVE_SMOKE_ENV = "WARRANT_CLAUDE_SMOKE";
const CODEX_LIVE_SMOKE_ENV = "WARRANT_CODEX_SMOKE";
const ALL_LIVE_SMOKE_ENV = "WARRANT_ENSEMBLE_LIVE_SMOKE";
const LIVE_SMOKE_TARGETS = ["claude-code", "codex"] as const;
const CLAUDE_LIVE_SMOKE_PROMPT =
  "Read README.md if present, then reply exactly CLAUDE_LIVE_SMOKE_OK. Do not modify files.";
const CODEX_LIVE_SMOKE_PROMPT =
  "Read README.md if present, then reply exactly CODEX_LIVE_SMOKE_OK. Do not modify files.";

export type HarnessCapabilityTarget =
  | "cursor"
  | "claude-code"
  | "codex"
  | "command"
  | "mock";

export type HarnessAvailability = "available" | "credential_gated" | "missing";
export type HarnessLiveSmokeTarget = (typeof LIVE_SMOKE_TARGETS)[number];
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
};

type SmokeRunInput = {
  taskId: string;
  harnessId: HarnessCapabilityTarget;
  purpose: HarnessSmokePurpose;
  outcome: HarnessSmokeOutcome;
  harness: HarnessAdapter;
  model: EnsembleModel;
  sideEffects: ModelFusionSideEffects;
  allowedTools: string[];
  prompt?: string;
  preflightFailureReason?: string;
};

function metadata<S extends "harness-run-result.v1">(schema: S, createdAt: string) {
  return {
    schema,
    schema_version: "v1" as const,
    schema_bundle_hash: SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
    created_at: createdAt
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled harness capability target: ${String(value)}`);
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function isEnvEnabled(env: Record<string, string | undefined>, name: string): boolean {
  return env[name] === "1" || env[name]?.toLowerCase() === "true";
}

function liveSmokeEnvName(target: HarnessLiveSmokeTarget): string {
  switch (target) {
    case "claude-code":
      return CLAUDE_LIVE_SMOKE_ENV;
    case "codex":
      return CODEX_LIVE_SMOKE_ENV;
    default: {
      const exhausted: never = target;
      throw new Error(`unsupported live smoke target: ${String(exhausted)}`);
    }
  }
}

function liveSmokeEnvEnabled(
  env: Record<string, string | undefined>,
  target: HarnessLiveSmokeTarget
): boolean {
  return isEnvEnabled(env, ALL_LIVE_SMOKE_ENV) || isEnvEnabled(env, liveSmokeEnvName(target));
}

function requestedLiveSmokeTargets(options: {
  env: Record<string, string | undefined>;
  liveSmoke?: readonly HarnessLiveSmokeTarget[];
}): HarnessLiveSmokeTarget[] {
  const selected = options.liveSmoke?.length ? options.liveSmoke : LIVE_SMOKE_TARGETS;
  return selected.filter((target) => liveSmokeEnvEnabled(options.env, target));
}

function harnessKindFor(target: HarnessCapabilityTarget): ModelFusionHarnessKind {
  switch (target) {
    case "cursor":
      return "cursor";
    case "claude-code":
      return "claude_code";
    case "codex":
      return "codex";
    case "command":
    case "mock":
      return "generic";
    default:
      return assertNever(target);
  }
}

function displayNameFor(target: HarnessCapabilityTarget): string {
  switch (target) {
    case "cursor":
      return "Cursor";
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "command":
      return "Command";
    case "mock":
      return "Mock";
    default:
      return assertNever(target);
  }
}

function cursorCapabilities(): HarnessCapabilities {
  return {
    workspace_read: "degraded",
    workspace_write: "degraded",
    apply_patch: "degraded",
    tool_records: "degraded",
    verification: "degraded",
    proprietary_harness: "unsupported",
    adapter_available: "unsupported"
  };
}

function dashboardCapabilitiesFor(target: HarnessCapabilityTarget): HarnessCapabilities {
  switch (target) {
    case "cursor":
      return {
        model_override: "degraded",
        transcript_capture: "degraded",
        diff_capture: "degraded",
        tool_loop_capture: "degraded",
        patch_apply_visibility: "degraded",
        route_model_observation: "degraded",
        verification_hint: "degraded",
        replay_support: "unsupported"
      };
    case "claude-code":
      return {
        model_override: "supported",
        transcript_capture: "supported",
        diff_capture: "supported",
        tool_loop_capture: "supported",
        patch_apply_visibility: "supported",
        route_model_observation: "degraded",
        verification_hint: "supported",
        replay_support: "degraded"
      };
    case "codex":
      return {
        model_override: "supported",
        transcript_capture: "supported",
        diff_capture: "supported",
        tool_loop_capture: "degraded",
        patch_apply_visibility: "supported",
        route_model_observation: "supported",
        verification_hint: "supported",
        replay_support: "degraded"
      };
    case "command":
      return {
        model_override: "supported",
        transcript_capture: "supported",
        diff_capture: "unsupported",
        tool_loop_capture: "supported",
        patch_apply_visibility: "unsupported",
        route_model_observation: "unsupported",
        verification_hint: "supported",
        replay_support: "supported"
      };
    case "mock":
      return {
        model_override: "supported",
        transcript_capture: "supported",
        diff_capture: "supported",
        tool_loop_capture: "supported",
        patch_apply_visibility: "supported",
        route_model_observation: "degraded",
        verification_hint: "supported",
        replay_support: "supported"
      };
    default:
      return assertNever(target);
  }
}

function matrixCapabilities(
  target: HarnessCapabilityTarget,
  capabilities: HarnessCapabilities
): HarnessCapabilities {
  return {
    ...capabilities,
    ...dashboardCapabilitiesFor(target)
  };
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

function matrixRow(input: {
  harnessId: HarnessCapabilityTarget;
  availability: HarnessAvailability;
  capabilities: HarnessCapabilities;
  notes: string[];
}): HarnessCapabilityMatrixRow {
  return {
    harnessId: input.harnessId,
    harnessKind: harnessKindFor(input.harnessId),
    displayName: displayNameFor(input.harnessId),
    availability: input.availability,
    capabilities: input.capabilities,
    notes: input.notes
  };
}

export function createHarnessCapabilityMatrix(
  options: HarnessSmokeDashboardOptions = {}
): HarnessCapabilityMatrix {
  const env = options.env ?? {};
  const rows = [
    matrixRow({
      harnessId: "cursor",
      availability: "missing",
      capabilities: matrixCapabilities("cursor", cursorCapabilities()),
      notes: ["No CI-safe package adapter; represented as an unsupported result record."]
    }),
    matrixRow({
      harnessId: "claude-code",
      availability: "credential_gated",
      capabilities: matrixCapabilities(
        "claude-code",
        adapterCapabilities(claudeCodeHarness({ env }))
      ),
      notes: ["Credential-gated; dashboard smoke uses an empty env skip path."]
    }),
    matrixRow({
      harnessId: "codex",
      availability: "credential_gated",
      capabilities: matrixCapabilities(
        "codex",
        adapterCapabilities(codexHarness({ env, provider: { kind: "ambient" } }))
      ),
      notes: ["Credential-gated; dashboard smoke uses an empty env skip path."]
    }),
    matrixRow({
      harnessId: "command",
      availability: "available",
      capabilities: matrixCapabilities(
        "command",
        adapterCapabilities(
          createCommandHarness({
            command: options.commandSuccess ?? DEFAULT_COMMAND_SUCCESS,
            cwd: options.repo
          })
        )
      ),
      notes: ["Runs local shell commands through the command harness."]
    }),
    matrixRow({
      harnessId: "mock",
      availability: "available",
      capabilities: matrixCapabilities("mock", adapterCapabilities(createMockHarness())),
      notes: ["Pure synthetic fixture harness for CI."]
    })
  ] satisfies HarnessCapabilityMatrixRow[];

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

function unsupportedCursorResult(input: {
  createdAt: string;
  taskId: string;
}): HarnessRunResultV1 {
  const result: HarnessRunResultV1 = {
    ...metadata("harness-run-result.v1", input.createdAt),
    result_id: `ensemble_result_${input.taskId}`,
    request_id: `ensemble_req_${input.taskId}`,
    harness_kind: "cursor",
    status: "unsupported",
    candidate_ids: [],
    output_summary: "Cursor harness unavailable in CI-safe package context.",
    capabilities: cursorCapabilities(),
    started_at: input.createdAt,
    finished_at: input.createdAt,
    errors: [
      {
        kind: "capability_missing",
        message: "Cursor proprietary harness is not available from @warrant/ensemble.",
        retryable: false
      }
    ],
    metadata: {
      dashboard_outcome: "missing",
      harness_id: "cursor"
    }
  };
  assertHarnessRunResultV1(result);
  return result;
}

function liveSmokePreflightFailureResult(input: {
  createdAt: string;
  taskId: string;
  harnessId: HarnessLiveSmokeTarget;
  harness: HarnessAdapter;
  reason: string;
}): HarnessRunResultV1 {
  const result: HarnessRunResultV1 = {
    ...metadata("harness-run-result.v1", input.createdAt),
    result_id: `ensemble_result_${input.taskId}`,
    request_id: `ensemble_req_${input.taskId}`,
    harness_kind: harnessKindFor(input.harnessId),
    status: "failed",
    candidate_ids: [],
    output_summary: `Explicit live smoke failed before launch: ${input.reason}`,
    capabilities: matrixCapabilities(input.harnessId, adapterCapabilities(input.harness)),
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
      harness_id: input.harnessId,
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
      harnessId: input.run.harnessId as HarnessLiveSmokeTarget,
      harness: input.run.harness,
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

  if (input.run.harnessId === "cursor") {
    const result = unsupportedCursorResult({
      createdAt: input.createdAt,
      taskId: input.run.taskId
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

function smokeRuns(options: Required<Pick<
  HarnessSmokeDashboardOptions,
  "commandSuccess" | "commandFailure"
>>): SmokeRunInput[] {
  return [
    {
      taskId: "mock-success",
      harnessId: "mock",
      purpose: "contract",
      outcome: "success",
      harness: createMockHarness(),
      model: { id: "mock", model: "synthetic-mock" },
      sideEffects: "read_only",
      allowedTools: ["read_file"]
    },
    {
      taskId: "command-success",
      harnessId: "command",
      purpose: "contract",
      outcome: "success",
      harness: createCommandHarness({ command: options.commandSuccess }),
      model: { id: "command", model: "local-shell" },
      sideEffects: "tool_execution",
      allowedTools: ["shell_command"]
    },
    {
      taskId: "command-failure",
      harnessId: "command",
      purpose: "contract",
      outcome: "failure",
      harness: createCommandHarness({ command: options.commandFailure }),
      model: { id: "command", model: "local-shell" },
      sideEffects: "tool_execution",
      allowedTools: ["shell_command"]
    },
    {
      taskId: "claude-code-skipped",
      harnessId: "claude-code",
      purpose: "credential-skip",
      outcome: "skipped",
      harness: claudeCodeHarness({ env: {} }),
      model: { id: "claude", model: "claude-sonnet-4-6" },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "write_file", "apply_patch"]
    },
    {
      taskId: "codex-skipped",
      harnessId: "codex",
      purpose: "credential-skip",
      outcome: "skipped",
      harness: codexHarness({ env: {}, provider: { kind: "ambient" } }),
      model: { id: "codex", model: "gpt-5.5-codex" },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "apply_patch"]
    },
    {
      taskId: "cursor-missing",
      harnessId: "cursor",
      purpose: "missing",
      outcome: "missing",
      harness: createMockHarness({ id: "cursor-missing-placeholder" }),
      model: { id: "cursor", model: "cursor-proprietary" },
      sideEffects: "writes_workspace",
      allowedTools: ["read_file", "write_file", "apply_patch"]
    }
  ];
}

function liveSmokeRuns(options: {
  env: Record<string, string | undefined>;
  targets: readonly HarnessLiveSmokeTarget[];
  harnesses?: Partial<Record<HarnessLiveSmokeTarget, HarnessAdapter>>;
}): SmokeRunInput[] {
  const runs: SmokeRunInput[] = [];
  if (options.targets.includes("claude-code")) {
    const harness =
      options.harnesses?.["claude-code"] ??
      claudeCodeHarness({ env: options.env, skipWhenUnavailable: false });
    runs.push({
      taskId: "claude-code-live",
      harnessId: "claude-code",
      purpose: "live",
      outcome: "success",
      harness,
      model: {
        id: "claude",
        model: options.env.WARRANT_CLAUDE_SMOKE_MODEL ?? "claude-sonnet-4-6"
      },
      sideEffects: "read_only",
      allowedTools: ["read_file"],
      prompt: CLAUDE_LIVE_SMOKE_PROMPT,
      preflightFailureReason: claudeCodeHarnessCredentialSkipReason(options.env)
    });
  }
  if (options.targets.includes("codex")) {
    const harness = options.harnesses?.codex ?? codexHarness({ env: options.env });
    runs.push({
      taskId: "codex-live",
      harnessId: "codex",
      purpose: "live",
      outcome: "success",
      harness,
      model: {
        id: "codex",
        model: options.env.WARRANT_CODEX_SMOKE_MODEL ?? "gpt-5.5-codex"
      },
      sideEffects: "read_only",
      allowedTools: ["read_file"],
      prompt: CODEX_LIVE_SMOKE_PROMPT,
      preflightFailureReason: codexHarnessCredentialSkipReason(options.env)
    });
  }
  return runs;
}

function capabilityCell(
  capabilities: HarnessCapabilities,
  capability: string
): ModelFusionCapabilityStatus {
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
  const lines = [
    "## Capability Matrix",
    "",
    `| ${header.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`
  ];
  for (const row of matrix.rows) {
    const cells = [
      row.displayName,
      row.harnessKind,
      row.availability,
      ...matrix.capabilities.map((capability) => capabilityCell(row.capabilities, capability)),
      row.notes.join(" ")
    ];
    lines.push(`| ${cells.map(escapeMarkdownCell).join(" | ")} |`);
  }
  return lines;
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

function credentialStateFor(
  harnessId: HarnessCapabilityTarget,
  env: Record<string, string | undefined>
): string {
  switch (harnessId) {
    case "claude-code":
      return claudeCodeHarnessCredentialSkipReason(env) === undefined
        ? "credentials available"
        : "credentials missing/skipped";
    case "codex":
      return codexHarnessCredentialSkipReason(env) === undefined
        ? "credentials available"
        : "credentials missing/skipped";
    case "command":
    case "mock":
      return "not required";
    case "cursor":
      return "not applicable";
    default:
      return assertNever(harnessId);
  }
}

function contractReadinessFor(harnessId: HarnessCapabilityTarget): string {
  switch (harnessId) {
    case "mock":
    case "command":
      return "contract/mock ready";
    case "claude-code":
    case "codex":
      return "contract/mock ready";
    case "cursor":
      return "adapter missing";
    default:
      return assertNever(harnessId);
  }
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
  env: Record<string, string | undefined>;
  outputRoot: string;
}): HarnessAdapterReadiness[] {
  return input.matrix.rows.map((row) => {
    const liveRecord = input.records.find(
      (record) => record.harnessId === row.harnessId && record.purpose === "live"
    );
    const credentialRecord = input.records.find(
      (record) => record.harnessId === row.harnessId && record.purpose === "credential-skip"
    );
    const evidence = [
      ...(credentialRecord !== undefined && credentialStateFor(row.harnessId, input.env).includes("missing")
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
      contractReadiness: contractReadinessFor(row.harnessId),
      credentialState: credentialStateFor(row.harnessId, input.env),
      liveSmoke: liveSmokeState(liveRecord),
      evidence,
      artifactRefs: liveRecord !== undefined ? safeArtifactRefs(liveRecord.result.artifacts) : []
    };
  });
}

function renderAdapterReadiness(readiness: readonly HarnessAdapterReadiness[]): string[] {
  const lines = [
    "## Adapter Readiness",
    "",
    "| Adapter | Contract/Mock Readiness | Credentials | Live Smoke | Last Evidence | Safe Artifact Refs |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const row of readiness) {
    const cells = [
      row.displayName,
      row.contractReadiness,
      row.credentialState,
      row.liveSmoke,
      row.evidence.length > 0 ? row.evidence.join("; ") : "-",
      row.artifactRefs.length > 0 ? row.artifactRefs.join("; ") : "-"
    ];
    lines.push(`| ${cells.map(escapeMarkdownCell).join(" | ")} |`);
  }
  return lines;
}

function renderSmokeRecords(records: readonly HarnessSmokeRecord[], outputRoot: string): string[] {
  const lines = [
    "## Smoke Records",
    "",
    "| Task | Harness | Purpose | Expected | Result Status | Harness Kind | Result Record | Summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  ];
  for (const record of records) {
    const cells = [
      record.taskId,
      displayNameFor(record.harnessId),
      record.purpose,
      record.outcome,
      record.result.status,
      record.result.harness_kind,
      relativePath(record.resultPath, outputRoot),
      record.result.output_summary ?? ""
    ];
    lines.push(`| ${cells.map(escapeMarkdownCell).join(" | ")} |`);
  }
  return lines;
}

function renderDashboard(input: {
  matrix: HarnessCapabilityMatrix;
  readiness: HarnessAdapterReadiness[];
  records: readonly HarnessSmokeRecord[];
  createdAt: string;
  outputRoot: string;
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
    ...renderSmokeRecords(input.records, input.outputRoot),
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
  mkdirSync(outputRoot, { recursive: true });

  const matrix = createHarnessCapabilityMatrix({
    ...options,
    repo,
    commandSuccess,
    commandFailure,
    env
  });
  const baseGitSha = currentGitSha(repo);
  const records: HarnessSmokeRecord[] = [];
  const runs = [
    ...smokeRuns({ commandSuccess, commandFailure }),
    ...liveSmokeRuns({
      env,
      targets: requestedLiveSmokeTargets({ env, liveSmoke: options.liveSmoke }),
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
    env,
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
      outputRoot
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
