import type { JsonValue } from "./jcs.js";

export const MODEL_FUSION_SCHEMA_NAMES = [
  "model-call-record.v1",
  "harness-run-request.v1",
  "harness-run-result.v1",
  "harness-candidate-record.v1",
  "judge-synthesis-record.v1",
  "benchmark-task-record.v1",
  "artifact-ref.v1",
  "tool-call-plan.v1",
  "tool-execution-record.v1",
  "ensemble-receipt.v1"
] as const;

export type ModelFusionSchemaName = (typeof MODEL_FUSION_SCHEMA_NAMES)[number];
export type ModelFusionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "requires_action"
  | "skipped"
  | "unsupported";
export type ModelFusionSideEffects =
  | "none"
  | "read_only"
  | "writes_workspace"
  | "network"
  | "tool_execution"
  | "unknown";
export type ModelFusionHarnessKind =
  | "generic"
  | "cursor"
  | "claude_code"
  | "codex"
  | "openai_responses";
export type ModelFusionCapabilityStatus =
  | "supported"
  | "unsupported"
  | "degraded"
  | "unknown";
export type ModelFusionArtifactKind =
  | "patch"
  | "log"
  | "transcript"
  | "metrics"
  | "benchmark_task"
  | "worktree"
  | "receipt"
  | "other";
export type ModelFusionRedactionStatus = "synthetic" | "redacted" | "raw";
export type ModelFusionErrorKind =
  | "none"
  | "provider_error"
  | "validation_error"
  | "timeout"
  | "rate_limited"
  | "tool_denied"
  | "secret_denied"
  | "capability_missing"
  | "internal_error";
export type ModelFusionChatRole = "system" | "user" | "assistant" | "tool";
export type BenchmarkTaskKind = "model_fusion" | "harness_coding";
export type BenchmarkSourceRepo = "fusionkit" | "handoffkit" | "cursorkit" | "mlx-lm";
export type BenchmarkScorerKind = "exact" | "contains" | "record_join" | "custom";
export type JudgeSynthesisDecision =
  | "synthesize"
  | "select_candidate"
  | "repair_required"
  | "failed";

export type ContractMetadataV1<S extends ModelFusionSchemaName> = {
  schema: S;
  schema_version: "v1";
  schema_bundle_hash: string;
  producer: string;
  producer_version: string;
  producer_git_sha: string;
  created_at: string;
};

export type ModelFusionChatMessage = {
  role: ModelFusionChatRole;
  content: string;
};

export type ModelFusionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type ModelFusionError = {
  kind: ModelFusionErrorKind;
  message?: string;
  retryable?: boolean;
};

export type ArtifactRef = {
  artifact_id: string;
  kind: ModelFusionArtifactKind;
  uri?: string;
  hash: string;
  redaction_status?: ModelFusionRedactionStatus;
};

export type ArtifactRefV1 = ContractMetadataV1<"artifact-ref.v1"> & ArtifactRef;

export type ModelCallRecordV1 = ContractMetadataV1<"model-call-record.v1"> & {
  call_id: string;
  endpoint_id: string;
  provider_request_id?: string;
  model: string;
  request_hash: string;
  response_hash?: string;
  messages: ModelFusionChatMessage[];
  status: ModelFusionStatus;
  side_effects: ModelFusionSideEffects;
  started_at: string;
  finished_at?: string;
  latency_ms?: number;
  usage?: ModelFusionUsage;
  output_text?: string;
  error?: ModelFusionError;
  metadata?: Record<string, JsonValue>;
};

export type HarnessRunRequestV1 = ContractMetadataV1<"harness-run-request.v1"> & {
  request_id: string;
  harness_kind: ModelFusionHarnessKind;
  source_repo: string;
  base_git_sha: string;
  prompt: string;
  prompt_hash: string;
  allowed_tools?: string[];
  side_effects: ModelFusionSideEffects;
  requested_capabilities: Record<string, ModelFusionCapabilityStatus>;
  metadata?: Record<string, JsonValue>;
};

export type HarnessRunResultV1 = ContractMetadataV1<"harness-run-result.v1"> & {
  result_id: string;
  request_id: string;
  harness_kind: ModelFusionHarnessKind;
  status: ModelFusionStatus;
  candidate_ids: string[];
  output_summary?: string;
  artifacts?: ArtifactRef[];
  capabilities: Record<string, ModelFusionCapabilityStatus>;
  started_at: string;
  finished_at?: string;
  errors?: ModelFusionError[];
  metadata?: Record<string, JsonValue>;
};

export type HarnessCandidateRecordV1 = ContractMetadataV1<"harness-candidate-record.v1"> & {
  candidate_id: string;
  request_id: string;
  harness_kind: ModelFusionHarnessKind;
  model_call_id?: string;
  status: ModelFusionStatus;
  side_effects: ModelFusionSideEffects;
  branch_name?: string;
  worktree_path?: string;
  artifacts?: ArtifactRef[];
  score?: number;
  error?: ModelFusionError;
  metadata?: Record<string, JsonValue>;
};

export type JudgeSynthesisRecordV1 = ContractMetadataV1<"judge-synthesis-record.v1"> & {
  synthesis_id: string;
  judge_model_call_id?: string;
  input_candidate_ids: string[];
  status: ModelFusionStatus;
  decision: JudgeSynthesisDecision;
  selected_candidate_id?: string;
  rationale?: string;
  final_output: string;
  score?: number;
  metrics?: Record<string, JsonValue>;
};

export type BenchmarkScorer = {
  kind: BenchmarkScorerKind;
  params?: Record<string, JsonValue>;
};

export type BenchmarkTaskRecordV1 = ContractMetadataV1<"benchmark-task-record.v1"> & {
  task_id: string;
  task_kind: BenchmarkTaskKind;
  source_repo: BenchmarkSourceRepo;
  source_sha: string;
  prompt?: string;
  prompt_hash: string;
  setup_hash: string;
  expected_evidence: string[];
  scorer: BenchmarkScorer;
  holdout: boolean;
  contamination_notes: string;
  allowed_tools: string[];
};

export type ToolCallPlanV1 = ContractMetadataV1<"tool-call-plan.v1"> & {
  plan_id: string;
  tool_name: string;
  arguments_hash: string;
  side_effects: ModelFusionSideEffects;
  status: ModelFusionStatus;
};

export type ToolExecutionRecordV1 = ContractMetadataV1<"tool-execution-record.v1"> & {
  execution_id: string;
  plan_id: string;
  status: ModelFusionStatus;
  output_hash?: string;
  error?: ModelFusionError;
};

export type EnsembleReceiptV1 = ContractMetadataV1<"ensemble-receipt.v1"> & {
  receipt_id: string;
  run_id: string;
  status: ModelFusionStatus;
  artifact_hashes: string[];
};

export type ModelFusionRecordV1 =
  | ModelCallRecordV1
  | HarnessRunRequestV1
  | HarnessRunResultV1
  | HarnessCandidateRecordV1
  | JudgeSynthesisRecordV1
  | BenchmarkTaskRecordV1
  | ArtifactRefV1
  | ToolCallPlanV1
  | ToolExecutionRecordV1
  | EnsembleReceiptV1;

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "requires_action",
  "skipped",
  "unsupported"
] as const satisfies readonly ModelFusionStatus[];
const SIDE_EFFECTS = [
  "none",
  "read_only",
  "writes_workspace",
  "network",
  "tool_execution",
  "unknown"
] as const satisfies readonly ModelFusionSideEffects[];
const HARNESS_KINDS = [
  "generic",
  "cursor",
  "claude_code",
  "codex",
  "openai_responses"
] as const satisfies readonly ModelFusionHarnessKind[];
const CAPABILITY_STATUSES = [
  "supported",
  "unsupported",
  "degraded",
  "unknown"
] as const satisfies readonly ModelFusionCapabilityStatus[];
const ARTIFACT_KINDS = [
  "patch",
  "log",
  "transcript",
  "metrics",
  "benchmark_task",
  "worktree",
  "receipt",
  "other"
] as const satisfies readonly ModelFusionArtifactKind[];
const REDACTION_STATUSES = [
  "synthetic",
  "redacted",
  "raw"
] as const satisfies readonly ModelFusionRedactionStatus[];
const ERROR_KINDS = [
  "none",
  "provider_error",
  "validation_error",
  "timeout",
  "rate_limited",
  "tool_denied",
  "secret_denied",
  "capability_missing",
  "internal_error"
] as const satisfies readonly ModelFusionErrorKind[];
const CHAT_ROLES = ["system", "user", "assistant", "tool"] as const;
const BENCHMARK_TASK_KINDS = ["model_fusion", "harness_coding"] as const;
const BENCHMARK_SOURCE_REPOS = ["fusionkit", "handoffkit", "cursorkit", "mlx-lm"] as const;
const BENCHMARK_SCORER_KINDS = ["exact", "contains", "record_join", "custom"] as const;
const JUDGE_DECISIONS = [
  "synthesize",
  "select_candidate",
  "repair_required",
  "failed"
] as const;

function hasString<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function assertObject(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${context} contains unsupported field(s): ${unexpected.join(", ")}`);
  }
}

function assertString(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
}

function assertOptionalString(value: unknown, context: string): asserts value is string | undefined {
  if (value !== undefined) assertString(value, context);
}

function assertNumber(value: unknown, context: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number`);
  }
}

function assertOptionalNumber(value: unknown, context: string): asserts value is number | undefined {
  if (value !== undefined) assertNumber(value, context);
}

function assertBoolean(value: unknown, context: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be a boolean`);
}

function assertHash(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${context} must be a sha256:<64 hex> hash`);
  }
}

function assertGitSha(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !GIT_SHA_PATTERN.test(value)) {
    throw new Error(`${context} must be a 40-character git SHA`);
  }
}

function assertDateTime(value: unknown, context: string): asserts value is string {
  assertString(value, context);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${context} must be an RFC 3339 date-time string`);
  }
}

function assertStringArray(value: unknown, context: string, minItems = 0): asserts value is string[] {
  if (!Array.isArray(value) || value.length < minItems) {
    throw new Error(`${context} must be an array with at least ${minItems} item(s)`);
  }
  value.forEach((item, index) => assertString(item, `${context}[${index}]`));
}

function assertEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  context: string
): asserts value is T {
  if (!hasString(values, value)) {
    throw new Error(`${context} is not a supported value`);
  }
}

function assertStatus(value: unknown, context: string): asserts value is ModelFusionStatus {
  assertEnum(value, STATUSES, context);
}

function assertSideEffects(value: unknown, context: string): asserts value is ModelFusionSideEffects {
  assertEnum(value, SIDE_EFFECTS, context);
}

function assertHarnessKind(value: unknown, context: string): asserts value is ModelFusionHarnessKind {
  assertEnum(value, HARNESS_KINDS, context);
}

function assertCapabilityMap(
  value: unknown,
  context: string
): asserts value is Record<string, ModelFusionCapabilityStatus> {
  assertObject(value, context);
  for (const [key, status] of Object.entries(value)) {
    assertEnum(status, CAPABILITY_STATUSES, `${context}.${key}`);
  }
}

function assertError(value: unknown, context: string): asserts value is ModelFusionError {
  assertObject(value, context);
  assertAllowedKeys(value, ["kind", "message", "retryable"], context);
  assertEnum(value.kind, ERROR_KINDS, `${context}.kind`);
  assertOptionalString(value.message, `${context}.message`);
  if (value.retryable !== undefined && typeof value.retryable !== "boolean") {
    throw new Error(`${context}.retryable must be a boolean`);
  }
}

function assertArtifact(
  value: unknown,
  context: string,
  includeMetadata = false
): asserts value is ArtifactRef {
  assertObject(value, context);
  assertAllowedKeys(
    value,
    [
      ...(includeMetadata
        ? [
            "schema",
            "schema_version",
            "schema_bundle_hash",
            "producer",
            "producer_version",
            "producer_git_sha",
            "created_at"
          ]
        : []),
      "artifact_id",
      "kind",
      "uri",
      "hash",
      "redaction_status"
    ],
    context
  );
  assertString(value.artifact_id, `${context}.artifact_id`);
  assertEnum(value.kind, ARTIFACT_KINDS, `${context}.kind`);
  assertOptionalString(value.uri, `${context}.uri`);
  assertHash(value.hash, `${context}.hash`);
  if (value.redaction_status !== undefined) {
    assertEnum(value.redaction_status, REDACTION_STATUSES, `${context}.redaction_status`);
  }
}

function assertArtifacts(value: unknown, context: string): asserts value is ArtifactRef[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  value.forEach((item, index) => assertArtifact(item, `${context}[${index}]`));
}

function assertMetadata<S extends ModelFusionSchemaName>(
  value: Record<string, unknown>,
  schema: S
): asserts value is ContractMetadataV1<S> & Record<string, unknown> {
  if (value.schema !== schema) throw new Error(`schema must be ${schema}`);
  if (value.schema_version !== "v1") throw new Error("schema_version must be v1");
  assertHash(value.schema_bundle_hash, "schema_bundle_hash");
  assertString(value.producer, "producer");
  assertString(value.producer_version, "producer_version");
  assertGitSha(value.producer_git_sha, "producer_git_sha");
  assertDateTime(value.created_at, "created_at");
}

function assertChatMessages(value: unknown, context: string): asserts value is ModelFusionChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must include at least one chat message`);
  }
  value.forEach((item, index) => {
    assertObject(item, `${context}[${index}]`);
    assertAllowedKeys(item, ["role", "content"], `${context}[${index}]`);
    assertEnum(item.role, CHAT_ROLES, `${context}[${index}].role`);
    assertString(item.content, `${context}[${index}].content`);
  });
}

function assertUsage(value: unknown, context: string): asserts value is ModelFusionUsage {
  assertObject(value, context);
  assertAllowedKeys(value, ["prompt_tokens", "completion_tokens", "total_tokens"], context);
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const candidate = value[key];
    if (
      candidate !== undefined &&
      (!Number.isInteger(candidate) || (candidate as number) < 0)
    ) {
      throw new Error(`${context}.${key} must be a non-negative integer`);
    }
  }
}

export function assertArtifactRefV1(value: unknown): asserts value is ArtifactRefV1 {
  assertObject(value, "artifact-ref.v1");
  assertMetadata(value, "artifact-ref.v1");
  assertArtifact(value, "artifact-ref.v1", true);
}

export function assertModelCallRecordV1(value: unknown): asserts value is ModelCallRecordV1 {
  assertObject(value, "model-call-record.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "call_id",
      "endpoint_id",
      "provider_request_id",
      "model",
      "request_hash",
      "response_hash",
      "messages",
      "status",
      "side_effects",
      "started_at",
      "finished_at",
      "latency_ms",
      "usage",
      "output_text",
      "error",
      "metadata"
    ],
    "model-call-record.v1"
  );
  assertMetadata(value, "model-call-record.v1");
  assertString(value.call_id, "call_id");
  assertString(value.endpoint_id, "endpoint_id");
  assertOptionalString(value.provider_request_id, "provider_request_id");
  assertString(value.model, "model");
  assertHash(value.request_hash, "request_hash");
  if (value.response_hash !== undefined) assertHash(value.response_hash, "response_hash");
  assertChatMessages(value.messages, "messages");
  assertStatus(value.status, "status");
  assertSideEffects(value.side_effects, "side_effects");
  assertDateTime(value.started_at, "started_at");
  if (value.finished_at !== undefined) assertDateTime(value.finished_at, "finished_at");
  assertOptionalNumber(value.latency_ms, "latency_ms");
  if (value.usage !== undefined) assertUsage(value.usage, "usage");
  assertOptionalString(value.output_text, "output_text");
  if (value.error !== undefined) assertError(value.error, "error");
  if (value.metadata !== undefined) assertObject(value.metadata, "metadata");
}

export function assertHarnessRunRequestV1(
  value: unknown
): asserts value is HarnessRunRequestV1 {
  assertObject(value, "harness-run-request.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "request_id",
      "harness_kind",
      "source_repo",
      "base_git_sha",
      "prompt",
      "prompt_hash",
      "allowed_tools",
      "side_effects",
      "requested_capabilities",
      "metadata"
    ],
    "harness-run-request.v1"
  );
  assertMetadata(value, "harness-run-request.v1");
  assertString(value.request_id, "request_id");
  assertHarnessKind(value.harness_kind, "harness_kind");
  assertString(value.source_repo, "source_repo");
  assertGitSha(value.base_git_sha, "base_git_sha");
  assertString(value.prompt, "prompt");
  assertHash(value.prompt_hash, "prompt_hash");
  if (value.allowed_tools !== undefined) assertStringArray(value.allowed_tools, "allowed_tools");
  assertSideEffects(value.side_effects, "side_effects");
  assertCapabilityMap(value.requested_capabilities, "requested_capabilities");
  if (value.metadata !== undefined) assertObject(value.metadata, "metadata");
}

export function assertHarnessRunResultV1(value: unknown): asserts value is HarnessRunResultV1 {
  assertObject(value, "harness-run-result.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "result_id",
      "request_id",
      "harness_kind",
      "status",
      "candidate_ids",
      "output_summary",
      "artifacts",
      "capabilities",
      "started_at",
      "finished_at",
      "errors",
      "metadata"
    ],
    "harness-run-result.v1"
  );
  assertMetadata(value, "harness-run-result.v1");
  assertString(value.result_id, "result_id");
  assertString(value.request_id, "request_id");
  assertHarnessKind(value.harness_kind, "harness_kind");
  assertStatus(value.status, "status");
  assertStringArray(value.candidate_ids, "candidate_ids");
  assertOptionalString(value.output_summary, "output_summary");
  if (value.artifacts !== undefined) assertArtifacts(value.artifacts, "artifacts");
  assertCapabilityMap(value.capabilities, "capabilities");
  assertDateTime(value.started_at, "started_at");
  if (value.finished_at !== undefined) assertDateTime(value.finished_at, "finished_at");
  if (value.errors !== undefined) {
    if (!Array.isArray(value.errors)) throw new Error("errors must be an array");
    value.errors.forEach((error, index) => assertError(error, `errors[${index}]`));
  }
  if (value.metadata !== undefined) assertObject(value.metadata, "metadata");
}

export function assertHarnessCandidateRecordV1(
  value: unknown
): asserts value is HarnessCandidateRecordV1 {
  assertObject(value, "harness-candidate-record.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "candidate_id",
      "request_id",
      "harness_kind",
      "model_call_id",
      "status",
      "side_effects",
      "branch_name",
      "worktree_path",
      "artifacts",
      "score",
      "error",
      "metadata"
    ],
    "harness-candidate-record.v1"
  );
  assertMetadata(value, "harness-candidate-record.v1");
  assertString(value.candidate_id, "candidate_id");
  assertString(value.request_id, "request_id");
  assertHarnessKind(value.harness_kind, "harness_kind");
  assertOptionalString(value.model_call_id, "model_call_id");
  assertStatus(value.status, "status");
  assertSideEffects(value.side_effects, "side_effects");
  assertOptionalString(value.branch_name, "branch_name");
  assertOptionalString(value.worktree_path, "worktree_path");
  if (value.artifacts !== undefined) assertArtifacts(value.artifacts, "artifacts");
  assertOptionalNumber(value.score, "score");
  if (value.error !== undefined) assertError(value.error, "error");
  if (value.metadata !== undefined) assertObject(value.metadata, "metadata");
}

export function assertJudgeSynthesisRecordV1(
  value: unknown
): asserts value is JudgeSynthesisRecordV1 {
  assertObject(value, "judge-synthesis-record.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "synthesis_id",
      "judge_model_call_id",
      "input_candidate_ids",
      "status",
      "decision",
      "selected_candidate_id",
      "rationale",
      "final_output",
      "score",
      "metrics"
    ],
    "judge-synthesis-record.v1"
  );
  assertMetadata(value, "judge-synthesis-record.v1");
  assertString(value.synthesis_id, "synthesis_id");
  assertOptionalString(value.judge_model_call_id, "judge_model_call_id");
  assertStringArray(value.input_candidate_ids, "input_candidate_ids", 1);
  assertStatus(value.status, "status");
  assertEnum(value.decision, JUDGE_DECISIONS, "decision");
  assertOptionalString(value.selected_candidate_id, "selected_candidate_id");
  assertOptionalString(value.rationale, "rationale");
  assertString(value.final_output, "final_output");
  assertOptionalNumber(value.score, "score");
  if (value.metrics !== undefined) assertObject(value.metrics, "metrics");
}

export function assertBenchmarkTaskRecordV1(
  value: unknown
): asserts value is BenchmarkTaskRecordV1 {
  assertObject(value, "benchmark-task-record.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "task_id",
      "task_kind",
      "source_repo",
      "source_sha",
      "prompt",
      "prompt_hash",
      "setup_hash",
      "expected_evidence",
      "scorer",
      "holdout",
      "contamination_notes",
      "allowed_tools"
    ],
    "benchmark-task-record.v1"
  );
  assertMetadata(value, "benchmark-task-record.v1");
  assertString(value.task_id, "task_id");
  assertEnum(value.task_kind, BENCHMARK_TASK_KINDS, "task_kind");
  assertEnum(value.source_repo, BENCHMARK_SOURCE_REPOS, "source_repo");
  assertGitSha(value.source_sha, "source_sha");
  assertOptionalString(value.prompt, "prompt");
  assertHash(value.prompt_hash, "prompt_hash");
  assertHash(value.setup_hash, "setup_hash");
  assertStringArray(value.expected_evidence, "expected_evidence", 1);
  assertObject(value.scorer, "scorer");
  assertAllowedKeys(value.scorer, ["kind", "params"], "scorer");
  assertEnum(value.scorer.kind, BENCHMARK_SCORER_KINDS, "scorer.kind");
  if (value.scorer.params !== undefined) assertObject(value.scorer.params, "scorer.params");
  assertBoolean(value.holdout, "holdout");
  assertString(value.contamination_notes, "contamination_notes");
  assertStringArray(value.allowed_tools, "allowed_tools");
}

export function assertToolCallPlanV1(value: unknown): asserts value is ToolCallPlanV1 {
  assertObject(value, "tool-call-plan.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "plan_id",
      "tool_name",
      "arguments_hash",
      "side_effects",
      "status"
    ],
    "tool-call-plan.v1"
  );
  assertMetadata(value, "tool-call-plan.v1");
  assertString(value.plan_id, "plan_id");
  assertString(value.tool_name, "tool_name");
  assertHash(value.arguments_hash, "arguments_hash");
  assertSideEffects(value.side_effects, "side_effects");
  assertStatus(value.status, "status");
}

export function assertToolExecutionRecordV1(
  value: unknown
): asserts value is ToolExecutionRecordV1 {
  assertObject(value, "tool-execution-record.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "execution_id",
      "plan_id",
      "status",
      "output_hash",
      "error"
    ],
    "tool-execution-record.v1"
  );
  assertMetadata(value, "tool-execution-record.v1");
  assertString(value.execution_id, "execution_id");
  assertString(value.plan_id, "plan_id");
  assertStatus(value.status, "status");
  if (value.output_hash !== undefined) assertHash(value.output_hash, "output_hash");
  if (value.error !== undefined) assertError(value.error, "error");
}

export function assertEnsembleReceiptV1(value: unknown): asserts value is EnsembleReceiptV1 {
  assertObject(value, "ensemble-receipt.v1");
  assertAllowedKeys(
    value,
    [
      "schema",
      "schema_version",
      "schema_bundle_hash",
      "producer",
      "producer_version",
      "producer_git_sha",
      "created_at",
      "receipt_id",
      "run_id",
      "status",
      "artifact_hashes"
    ],
    "ensemble-receipt.v1"
  );
  assertMetadata(value, "ensemble-receipt.v1");
  assertString(value.receipt_id, "receipt_id");
  assertString(value.run_id, "run_id");
  assertStatus(value.status, "status");
  if (!Array.isArray(value.artifact_hashes)) {
    throw new Error("artifact_hashes must be an array");
  }
  value.artifact_hashes.forEach((hash, index) => {
    assertHash(hash, `artifact_hashes[${index}]`);
  });
}

export function assertModelFusionRecord(value: unknown): asserts value is ModelFusionRecordV1 {
  assertObject(value, "model-fusion record");
  switch (value.schema) {
    case "model-call-record.v1":
      assertModelCallRecordV1(value);
      return;
    case "harness-run-request.v1":
      assertHarnessRunRequestV1(value);
      return;
    case "harness-run-result.v1":
      assertHarnessRunResultV1(value);
      return;
    case "harness-candidate-record.v1":
      assertHarnessCandidateRecordV1(value);
      return;
    case "judge-synthesis-record.v1":
      assertJudgeSynthesisRecordV1(value);
      return;
    case "benchmark-task-record.v1":
      assertBenchmarkTaskRecordV1(value);
      return;
    case "artifact-ref.v1":
      assertArtifactRefV1(value);
      return;
    case "tool-call-plan.v1":
      assertToolCallPlanV1(value);
      return;
    case "tool-execution-record.v1":
      assertToolExecutionRecordV1(value);
      return;
    case "ensemble-receipt.v1":
      assertEnsembleReceiptV1(value);
      return;
    default:
      throw new Error(`unsupported model-fusion schema: ${String(value.schema)}`);
  }
}
