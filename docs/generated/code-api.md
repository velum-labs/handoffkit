# Generated code API reference

This file is generated from source comments by `pnpm docs:generate-code`. Do not edit it by hand. Update JSDoc or Python docstrings in the source files, then regenerate this file.

The generated reference intentionally covers package entry points and Python public package modules. It is the bridge between code annotations and maintained prose documentation.

## TypeScript package entry points

### `packages/adapter-ai-sdk/src/index.ts`

@fusionkit/adapter-ai-sdk is the AI SDK side of FusionKit local-model flows.

This product package contains managed MLX local-model helpers and worktree
agent utilities. Governed remote tools, swarm tools, and handoff-aware model
routing live in the legacy `@fusionkit/handoff` package.

- `export { runWorktreeAgent, worktreeDiff } from "./worktree-agent.js";`
- `export type { TrajectoryStep, TrajectoryStepType, WorktreeAgentInput, WorktreeAgentResult } from "./worktree-agent.js";`
- `export { defaultMlxDir, MlxCapabilityError, MlxEnv } from "./mlx-env.js";`
- `export type { DownloadProgress, LocalModelInfo, ProvisionEvent } from "./mlx-env.js";`
- `export { managedModelServer, mlxServer } from "./managed-server.js";`
- `export type { ManagedModelServerOptions, ManagedServerEvent, MlxServerOptions } from "./managed-server.js";`

### `packages/cli/src/index.ts`

Entry point for the FusionKit command line package. The executable itself lives in src/index.ts, while cli.ts builds the Commander command tree.

No exports found.

### `packages/ensemble/src/index.ts`

FusionKit ensemble runtime entry point. It exposes harness execution, panel workflows, judge synthesis, runtime-kernel workflows, operators, schedulers, worktrees, isolation helpers, and tool execution.

- `export { COMMAND_DASHBOARD_CAPABILITIES, createCommandHarness } from "./command.js";`
- `export type { CommandHarnessOptions } from "./command.js";`
- `export { resolveCursorkitCli } from "./cursorkit-path.js";`
- `export type { CursorkitCli } from "./cursorkit-path.js";`
- `export { createArtifactStore } from "./artifacts.js";`
- `export type { ArtifactStore } from "./artifacts.js";`
- `export { createMockJudgeSynthesizer } from "./judge.js";`
- `export type { JudgeCandidateEvidence, JudgeInput, JudgePatch, JudgeSynthesizer, JudgeSynthesisOutput, MockJudgeSynthesizerOptions, SynthesisFailureSummary } from "./judge.js";`
- `export { ensemble, runEnsemble } from "./run.js";`
- `export { buildPanelPrompt, createFusionKitJudgeSynthesizer, harnessSupportsFiniteK, panelCandidateContract, runFusionPanelWorkflow, runFusionPanels, runUnifiedHarnessE2E, setToolDriverRegistry } from "./unified.js";`
- `export { runPanelRound } from "./panel-round.js";`
- `export type { PanelRoundOptions } from "./panel-round.js";`
- `export { runProposalPanels } from "./panel-propose.js";`
- `export type { ProposalPanelOptions } from "./panel-propose.js";`
- `export type { CursorHarnessRunnerInput, CursorHarnessRunnerResult, FusedSubagentAccess, FusedSubagentEnsemble, FusionPanelOptions, PanelTrust, ToolDriverRegistry, ToolHarnessResolveOptions, UnifiedHarnessE2EOptions, UnifiedHarnessE2EResult, UnifiedHarnessKind, UnifiedHarnessMatrixResult } from "./unified.js";`
- `export type { FusionTraceCarrier } from "@fusionkit/tracing";`
- `export { runJudgeSynthesis } from "./synthesis.js";`
- `export type { RunSynthesisInput, SynthesisResult } from "./synthesis.js";`
- `export { ArtifactTypes, OperatorKinds } from "./artifact-types.js";`
- `export type { ArtifactType, OperatorKind } from "./artifact-types.js";`
- `export { artifactRef, countOperatorKind, dependenciesFor, inputNodeIds, nodeOutputRefs, nodeRef, nodesById, terminalNodeIds, topoLayers } from "./graph-utils.js";`
- `export { assertValidOperatorGraph, explainGraph, validateOperatorGraph, validateSchedulerGraph } from "./graph-validation.js";`
- `export type { GraphExplanation, GraphValidationIssue } from "./graph-validation.js";`
- `export { GraphBuilder, getWorkflow, graph, listWorkflows, refs, registerWorkflow, runWorkflow } from "./kernel.js";`
- `export { KernelBackend } from "./kernel-backend.js";`
- `export { captureWireResponse, WireArtifactTypes } from "./wire-artifacts.js";`
- `export type { WireResponseValue } from "./wire-artifacts.js";`
- `export { createKernelFuseStepRunner, KERNEL_FUSE_STEP_WORKFLOW } from "./kernel-gateway.js";`
- `export type { FuseStepTransport } from "./kernel-gateway.js";`
- `export type { GraphNodeInput, KernelWorkflow, WorkflowFactory } from "./kernel.js";`
- `export { resolveTopology, topology, topologyHash } from "./topology-spec.js";`
- `export type { ResolvedTopology, TopologySpec } from "./topology-spec.js";`
- `export { artifactValue, candidatesFromInputs, consumeUsageFromOutput, createTaskArtifact, defineOperator, firstArtifactByType, operatorSpec, taskFromInputs } from "./kernel-helpers.js";`
- `export type { CreateTaskArtifactInput } from "./kernel-helpers.js";`
- `export { directModelWorkflow, executionSelectWorkflow, executionSelectRepairWorkflow, panelCaptureWorkflow, panelJudgeSynthWorkflow, rankFuseWorkflow, registerBuiltInWorkflows } from "./workflows.js";`
- `export { LegacyRunEnsembleOperator, PythonTrajectoryFuseOperator, ensembleRunWorkflow, pythonTrajectoryFuseWorkflow } from "./legacy-workflows.js";`
- `export type { EnsembleRunWorkflowInput, PythonTrajectoryFuseWorkflowInput, TrajectoryFuseRequest } from "./legacy-workflows.js";`
- `export type { DirectModelWorkflowInput, ExecutionSelectWorkflowInput, ExecutionSelectRepairWorkflowInput, PanelCaptureWorkflowInput, PanelJudgeSynthWorkflowInput, RankFuseWorkflowInput } from "./workflows.js";`
- `export { ArchitectureEvaluateOperator, CalibrateSignalOperator, DelegateOperator, EvidenceSourceOperator, GenFuserOperator, OfflineModelMergeOperator, PairRankOperator, RepairOperator, ReviewOperator, RouteOperator, SchemaValidationOperator, SelectOperator, TreeExpandOperator, TreeScoreOperator } from "./advanced-operators.js";`
- `export type { ArchitectureEvaluation, CandidateRepairer, CandidateSelector, DelegationResult, EvidenceBundle, EvidenceSource, MergeRecipe, RankMatrix, RepairPredicate, RepairOutput, ReviewResult, RouteDecision, SelectedCandidate, SignalCalibrator, TreeNodeValue } from "./advanced-operators.js";`
- `export { JudgeCompareOperator, ModelGenerateOperator, PanelGenerateOperator, SynthesizeOperator } from "./fusion-operators.js";`
- `export type { CandidateArtifactValue, ChatMessage, JudgeComparator, JudgeComparison, ModelClient, ModelGenerateOutput, ModelGenerateRequest, PanelCandidate, PanelRunInput, PanelRunner, Synthesizer, SynthesisOutput } from "./fusion-operators.js";`
- `export { BudgetExceededError, DirectFastPathScheduler, FusionRuntime, InMemoryKernelStateStore, OperatorGraphError, RuntimeCancelledError, RuntimeExecutionError, StaticDAGScheduler, createRuntimeReplayRecord, runtimeReplayRecordJson, createArtifact } from "./runtime.js";`
- `export { AdaptiveRouterScheduler, AgenticDelegationScheduler, BestOfNScheduler, ExecutionSelectRepairScheduler, FixedLayerMoAScheduler, LearnedWorkflowScheduler, OfflineArchitectureSearchScheduler, RankFuseScheduler, TreeSearchScheduler } from "./schedulers.js";`
- `export type { LearnedWorkflowPolicy } from "./schedulers.js";`
- `export type { Artifact, ArtifactInputRef, ArtifactLeakage, ArtifactVisibility, BudgetLedger, BudgetPolicy, BudgetUsage, CostEstimate, CreateArtifactInput, Observation, Operator, OperatorGraph, OperatorGraphNode, OperatorRunContext, OperatorSideEffects, OperatorSpec, OutcomeRecord, Provenance, RecordObservationInput, RecordSignalInput, RetryPolicy, KernelSessionState, KernelStateStore, KernelTurnState, RuntimeEvent, RuntimeExecutionResult, RuntimeReplayRecord, RuntimeState, RuntimeStatus, Scheduler, SchedulerExecutionContext, SchedulerRunResult, Signal, SignalCalibration, SignalDimension, StreamingOperator, TaskSpec, TraceEvent, TraceEventInput, TraceEventType } from "./runtime.js";`
- `export { createMockHarness, MOCK_DASHBOARD_CAPABILITIES, MOCK_DASHBOARD_IDENTITY } from "./mock.js";`
- `export type { MockCandidateFixture, MockHarnessOptions } from "./mock.js";`
- `export { createDriverHarness } from "./driver-adapter.js";`
- `export type { DriverHarnessOptions, DriverModelRoute, PanelDriver } from "./driver-adapter.js";`
- `export { traceCandidate } from "./candidate-trace.js";`
- `export type { CandidateOutcome, CandidateTraceContext, CandidateTraceInput, CandidateTracer } from "./candidate-trace.js";`
- `export { createToolExecutor, registerDemoTools, sideEffectsForTool } from "./tool-executor.js";`
- `export type { ToolExecutor, ToolImplementation } from "./tool-executor.js";`
- `export { executeFusionKitToolBatch, FusionKitToolExecutorClient, FusionKitToolExecutorClientError, FusionKitToolExecutorError, startFusionKitToolExecutorServer } from "./external-executor.js";`
- `export { createCliContainerDriver, runCandidateCommandWithIsolation, secretAbsenceMetadata, secretValueHash } from "./isolation.js";`
- `export type { FusionKitToolExecutionBatch, FusionKitToolExecutionRequest, FusionKitToolExecutionResponse, FusionKitToolExecutionResult, FusionKitToolExecutorServer, FusionKitToolExecutorServerOptions } from "./external-executor.js";`
- `export type { CandidateCommandIsolationInput, CandidateCommandIsolationResult } from "./isolation.js";`
- `export { cleanupCandidateWorktree, cleanupWorktreePlan, createWorktreePlan, defaultOutputRoot, diffCandidateWorktree, diffWorkspace, sealCandidateWorktree } from "./worktree.js";`
- `export type { CandidateWorktree, WorktreePlan } from "./worktree.js";`
- `export { deriveSourceRepo } from "./source-repo.js";`
- `export { hardeningToJson, panelMemberPreamble } from "./harness.js";`
- `export type { EnsembleCandidateSummary, EnsembleDescriptor, EnsembleJudge, EnsembleModel, EnsemblePolicy, EnsembleRunResult, EnsembleRuntime, CandidateContainerDriver, CandidateContainerDriverInput, CandidateContainerDriverResult, CandidateHardeningMetadata, CandidateIsolationConfig, CandidateIsolationKind, CandidateIsolationMountPolicy, CandidateIsolationNetworkPolicy, CandidateIsolationSecretPolicy, HarnessAdapter, HarnessArtifact, HarnessCapabilities, HarnessCandidateOutput, HarnessCollectInput, HarnessPrepareInput, HarnessRunInput, HarnessEndReason, HarnessToolRecord, HarnessTrajectory, TrajectoryStep, TrajectoryStepType, ReviewEvidence, EnsembleRunSummary, VerificationProfile } from "./harness.js";`

### `packages/example-utils/src/index.ts`

Example utilities entry point. It exposes demo manifest parsing, mock model helpers, live model helpers, and narration utilities.

No exports found.

### `packages/fusion-config/src/index.ts`

No module JSDoc was found.

- `export const FUSION_CONFIG_DIRNAME ...`
- `export const FUSION_CONFIG_BASENAME ...`
- `export const FUSION_PROMPTS_DIRNAME ...`
- `export const FUSION_CONFIG_VERSION ...`
- `export const DEFAULT_ENSEMBLE_NAME ...`
- `export const FUSION_TOOLS ...`
- `export type FusionTool ...`
- `export const PROMPT_IDS ...`
- `export type PromptId ...`
- `export const PROMPT_CONFIG_KEY: Record<PromptId, string> ...`
- `export type PromptOverrides ...`
- `export type OnRateLimitPolicy ...`
- `export type PanelTrust ...`
- `export type EmbeddedRouterConfig ...`
- `export type ExternalRouterConfig ...`
- `export type FusionRouterConfig ...`
- `export type EnsembleConfig ...`
- `export type FusionConfig ...`
- `export class FusionConfigError extends Error ...`
- `export function fusionConfigDir(repoRoot: string): string ...`
- `export function fusionConfigPath(repoRoot: string): string ...`
- `export function fusionPromptsDir(repoRoot: string, ensemble?: string): string ...`
- `export function fusionPromptPath(repoRoot: string, id: PromptId, ensemble?: string): string ...`
- `export function validateEnsembleName(name: string, source: string): void ...`
- `export function parseFusionConfig(raw: unknown, source: string): FusionConfig ...`
- `export function readFusionPrompts(repoRoot: string, ensemble?: string): PromptOverrides ...`
- `export function loadFusionConfig(repoRoot: string): FusionConfig | undefined ...`
- `export function persistedFusionConfig(config: FusionConfig): Record<string, unknown> ...`
- `export function writeFusionConfig(`
- `export function writeFusionPrompts(`

### `packages/fusion-gateway/src/index.ts`

No module JSDoc was found.

- `export { FusionBackend, InMemoryFusionBackendKernelStateStore, PendingSessionWrites } from "./fusion-backend.js";`
- `export type { ChatMessageLike, FusedModelRoute, FuseStepRunInput, FuseStepRunner, FusionBackendKernelSessionState, FusionBackendKernelStateStore, FusionBackendOptions, OnRateLimitPolicy, PanelRunInput, PanelRunner, PassthroughModel, SessionMetaInput, WireTrajectory } from "./fusion-backend.js";`
- `export { FrontdoorArtifactTypes, FrontdoorFuseError, FrontdoorOperatorKinds, FrontdoorPanelError, frontdoorBudgetGateOperator, frontdoorBudgetStopOperator, frontdoorFinalizeOperator, frontdoorFuseOperator, frontdoorPanelOperator, frontdoorResolveModelOperator, frontdoorStreamingFuseOperator, frontdoorVendorProxyOperator } from "./frontdoor/operators.js";`
- `export type { BudgetValue, CandidateSetValue, FailoverValue, RouteValue } from "./frontdoor/operators.js";`
- `export { FUSION_FRONTDOOR_TURN_WORKFLOW, frontdoorRequestArtifact, runFusionFrontdoorTurn, streamFusionFrontdoorTurn } from "./frontdoor/workflow.js";`
- `export type { FrontdoorTurnOutcome } from "./frontdoor/workflow.js";`
- `export { FUSION_FRONTDOOR_REQUEST_WORKFLOW, FrontdoorRequestScheduler, runFrontdoorRequest } from "./frontdoor/request.js";`
- `export { eventsToSseResponse } from "./frontdoor/sse.js";`
- `export type { EventsToSseOptions } from "./frontdoor/sse.js";`
- `export { createTurnNarrator, mergeEventsWithNarration } from "./frontdoor/narration.js";`
- `export type { NarrationWriter, ReasoningDeltaEvent, TurnNarration, TurnNarratorInput } from "./frontdoor/narration.js";`
- `export { createChatNarrationWriter } from "./frontdoor/narration-writer.js";`
- `export type { ChatFn, ChatNarrationWriterOptions } from "./frontdoor/narration-writer.js";`
- `export { FRONTDOOR_SIGNAL } from "./frontdoor/types.js";`
- `export type { FrontdoorChatBody, FrontdoorRequestValue, FrontdoorRoute, FrontdoorServices, VendorProxyOutcome } from "./frontdoor/types.js";`
- `export { defaultSessionsDir, FileSystemSessionStore, InMemorySessionStore } from "./session-store.js";`
- `export type { PersistedSession, SessionMeta, SessionStore, SessionSummary, SessionTurnRecord } from "./session-store.js";`
- `export { addLedgerEntry, addTurnCost, emptySessionCost, estimateCost, formatUsd, lookupPricing, meterCall, meterTurn, parseUsage, parseUsageFromSse, turnCostLine } from "./cost.js";`
- `export type { CostLedgerEntry, CostStage, LocalComputePricing, LocalComputeUsage, ModelPricing, ProviderCostMetadata, SessionCost, TokenUsage, TurnCost } from "./cost.js";`
- `export { defaultFusionGatewayLogger } from "./logger.js";`
- `export type { FusionGatewayLogger } from "./logger.js";`
- `export { MlxBackend } from "./mlx-backend.js";`
- `export type { MlxBackendOptions } from "./mlx-backend.js";`
- `export { createBackend, DEFAULT_MLX_MODEL, resolveBackendConfig } from "./config.js";`
- `export type { BackendConfig } from "./config.js";`
- `export { createTrajectoryCapture, reconstructTrajectory } from "./trajectory-capture.js";`
- `export type { CapturedStep, CapturedTrajectory, TrajectoryCapture } from "./trajectory-capture.js";`
- `export { PANEL_DEPTH_HEADER, panelDepthFromRequest, parsePanelDepth } from "./request-context.js";`
- `export { toFusionModelCallRecord } from "./provenance.js";`

### `packages/kernel/src/index.ts`

Dependency-free runtime kernel entry point. It re-exports artifacts, operator graph utilities, validation helpers, runtime primitives, and wire artifact helpers.

No exports found.

### `packages/protocol/src/index.ts`

@fusionkit/protocol is the open, versioned data contract layer.

It exports FusionKit wire/panel/model-fusion schemas and generated clients.
The signed-run governance contracts below are unrelated legacy Warrant
surface retained here for compatibility during this phase; they are
intentionally guarded as FusionKit protocol, not RouteKit contracts.
Generic hashing/JCS and model-call primitives come from @velum-labs/routekit-contracts.

Everything here is stable protocol surface. Packages should consume these
interfaces instead of recreating local string lists or proof logic.

- `export { ACTOR_KINDS, AGENT_KINDS, CHECKPOINT_TIERS, DISCLOSURE_MODES, HEX_HASH_PATTERN, isAgentKind, isTerminalStatus, MODEL_FUSION_SCHEMA_NAMES, PROTOCOL_VERSIONS, RUN_EVENT_TYPES, RUN_STATUSES, SESSION_ISOLATIONS, TERMINAL_RUN_STATUSES } from "./constants.js";`
- `export { parseHostAllowlistEntry, parsePoolName, parseSecretName, parseWorkspaceManifestPath } from "./validators.js";`
- `export { defaultExecutionSpec, executionFromRunRequest } from "./execution.js";`
- `export type { ExecutionEnv, ExecutionLogPolicy, ExecutionSpec } from "./execution.js";`
- `export { evaluateToolPolicy, modelFusionSideEffects, toolArgumentsHash, toolCallKey, toolSideEffectClassFromModelFusion } from "./tool-executor.js";`
- `export type { ToolDefinition, ToolExecutionRequest, ToolExecutionResult, ToolExecutorBudget, ToolExecutorContract, ToolExecutorLimits, ToolExecutorMode, ToolPolicyDecision, ToolSideEffectClass } from "./tool-executor.js";`
- `export { canonicalize } from "@velum-labs/routekit-contracts";`
- `export type { JsonValue } from "@velum-labs/routekit-contracts";`
- `export { assertWireTrajectory, isWireTrajectory, normalizeWireTrajectories } from "./fusion-wire.js";`
- `export type { WireTrajectory } from "./fusion-wire.js";`
- `export { isFiniteK, isLookaheadK, isProposalK, panelModeForK } from "./panel-k.js";`
- `export type { PanelMode } from "./panel-k.js";`
- `export { artifactHash, hashCanonical, hashCanonicalSha256, requestHash, responseHash, schemaBundleHash, SHA256_PREFIX, sha256Hex, sha256PrefixedHex } from "@velum-labs/routekit-contracts";`
- `export { MODEL_FUSION_SCHEMA_BUNDLE_HASH, assertArtifactRefV1, assertBenchmarkTaskRecordV1, assertEnsembleReceiptV1, assertHarnessCandidateRecordV1, assertHarnessRunRequestV1, assertHarnessRunResultV1, assertJudgeSynthesisRecordV1, assertModelCallRecordV1, assertModelFusionRecord, assertToolCallPlanV1, assertToolExecutionRecordV1 } from "./model-fusion.js";`
- `export { executeHarnessTask, MODEL_FUSION_HARNESS_EXECUTOR_PATH, MODEL_FUSION_OPENAPI_SOURCE_HASH } from "./generated/model-fusion-openapi.js";`
- `export type { ExecuteHarnessTaskClientOptions, ModelFusionOpenApiArtifactRef, ModelFusionOpenApiErrorResponse, ModelFusionOpenApiHarnessExecutionRequest, ModelFusionOpenApiHarnessExecutionResult, ModelFusionOpenApiPersistedJsonRecord } from "./generated/model-fusion-openapi.js";`
- `export type { ArtifactRefV1, ArtifactRef, BenchmarkScorer, BenchmarkScorerKind, BenchmarkSourceRepo, BenchmarkTaskKind, BenchmarkTaskRecordV1, ContractMetadataV1, EnsembleReceiptV1, HarnessCandidateRecordV1, HarnessRunRequestV1, HarnessRunResultV1, JudgeSynthesisDecision, JudgeSynthesisRecordV1, ModelCallRecordV1, ModelFusionArtifactKind, ModelFusionCapabilityStatus, ModelFusionChatMessage, ModelFusionChatRole, ModelFusionError, ModelFusionErrorKind, ModelFusionHarnessKind, ModelFusionRecordV1, ModelFusionRedactionStatus, ModelFusionSchemaName, ModelFusionSideEffects, ModelFusionStatus, ModelFusionUsage, ToolCallPlanV1, ToolExecutionRecordV1 } from "./model-fusion.js";`
- `export { generateEd25519KeyPair, keyIdFromPublicPem, signData, verifyData } from "./keys.js";`
- `export type { KeyPairPem } from "./keys.js";`
- `export { contractHash, signContract } from "./contract.js";`
- `export { appendEvent, verifyChain } from "./chain.js";`
- `export type { ChainVerification } from "./chain.js";`
- `export { signReceipt, verifyReceiptBundle, verifyRunnerReceipt } from "./receipt.js";`
- `export type { BundleVerification } from "./receipt.js";`
- `export { buildReceiptStory, summarizeRunEvent } from "./receipt-story.js";`
- `export type { EventSummary, ReceiptStory } from "./receipt-story.js";`
- `export { ATTR, EXPORTABLE_ATTRIBUTES, FUSION_CONVENTIONS_VERSION, FUSION_EVENT_NAMES, FUSION_SCOPES, FUSION_SPAN_NAMES } from "./generated/trace-conventions.js";`
- `export type { FusionAttributeKey, FusionEventName, FusionSpanName } from "./generated/trace-conventions.js";`
- `export { PolicyDeniedError } from "./types.js";`
- `export type { ActorRef, AgentKind, AgentSpec, ArtifactKind, AttestationTier, BudgetSpec, ChainedEvent, Checkpoint, CheckpointTier, ConsentRule, ContinuationRef, DataClassRule, DisclosureMode, DisclosureRecord, FailureClass, HandoffEnvelope, HandoffSource, HandoffTargetRef, KeyRef, ManifestFile, ModelUsageRecord, NetworkAccessRecord, NetworkPolicy, Policy, Receipt, ReceiptBundle, RetentionPolicy, RunContract, RunEvent, RunnerIdentity, RunnerSelector, RunStatus, SecretClaim, SecretReleaseRecord, SecretScopeRule, SemanticState, SessionIsolation, Signature, TaskSpec, ToolCallRecord, ToolJournal, WorkspaceManifest } from "./types.js";`
- `export type { ClaimResult, DisclosureReport, PolicyDecision, RunnerSummary, RunRequest, RunRequestInput, RunSummary, RunView } from "./api.js";`

### `packages/registry/src/index.ts`

Fusion-only identities and panel presets generated from
spec/registry/fusion.json.

Product-neutral provider, subscription, catalog, capability, pricing, and
local model metadata lives in @velum-labs/routekit-registry.

- `export const FUSION_PANEL_MODEL: string ...`
- `export const DEFAULT_ENSEMBLE_NAME ...`
- `export const FUSION_MODEL_ID_PREFIX ...`
- `export function fusionModelId(ensemble: string): string ...`
- `export const CURSOR_BRIDGE_MODEL_NAME: string ...`
- `export const LOCAL_MODEL_LABEL: string ...`
- `export const FUSION_MODEL_ALIASES: readonly string[] ...`
- `export const FUSION_DEFAULT_ALIAS: string ...`
- `export const FUSION_PANEL_ALIAS: string ...`
- `export const FUSION_GATEWAY_DEFAULT_BASE_URL: string ...`
- `export const FUSION_GATEWAY_API_KEY_ENV: string ...`
- `export type CatalogPanelMember ...`
- `export type BenchmarkPanelPreset ...`
- `export const DEFAULT_CLOUD_PANEL_MEMBERS: readonly CatalogPanelMember[] ...`
- `export const BENCHMARK_PANEL_PRESETS: Readonly<Record<string, BenchmarkPanelPreset>> ...`

### `packages/testkit/src/index.ts`

@fusionkit/testkit — cross-stack test tooling (never published).

Composable layers for realistic end-to-end tests (see docs/testing.md):

- {@link startProviderSim}: the scriptable provider simulator
  (python/fusionkit-testkit) as a child process, driven over its HTTP
  control plane and observed through its wire journal.
- {@link simSidecarConfigYaml}: production-shaped sidecar config over stable
  namespaced RouteKit model IDs.
- {@link startEngine}: the internal Python synthesis sidecar as a child
  process — the same entrypoint the production CLI spawns.
- {@link parseSse} / {@link sseText}: structured SSE observation.
- {@link detectStackTooling}: honest skip-gating for environments without
  the Python toolchain.

- `export { cliAvailable, cliSkip, runClaudeCode, runCodexExec, runOpenCode } from "./clis.js";`
- `export type { CliRunResult } from "./clis.js";`
- `export { DOOR_PROFILES, callDoor, doorFrames } from "./doors.js";`
- `export type { DoorProfile, DoorRequestInput, DoorToolCall, DoorToolExchange } from "./doors.js";`
- `export type { SimBehavior, SimBehaviorInput, SimDialect, SimError, SimJournalEntry, SimToolCall } from "./behaviors.js";`
- `export { asBehavior, simErrors } from "./behaviors.js";`
- `export { startEngine } from "./engine.js";`
- `export type { EngineHandle } from "./engine.js";`
- `export { freePort, reservePort, spawnCaptured, waitForHttpReady } from "./proc.js";`
- `export type { ReservedPort, SpawnedProcess } from "./proc.js";`
- `export { startProviderSim } from "./provider-sim.js";`
- `export type { ProviderSimHandle, SimCallFilter } from "./provider-sim.js";`
- `export { detectStackTooling, repoRoot, stackToolingSkip, uvRunArgv } from "./python.js";`
- `export type { StackTooling } from "./python.js";`
- `export { CODEX_TEST_TOKEN_ENV, simSidecarConfigYaml } from "./router-config.js";`
- `export type { SimModelSpec } from "./router-config.js";`
- `export { judgeAnalysis, scriptFusedTurn } from "./scenarios.js";`
- `export type { FusedTurnScript } from "./scenarios.js";`
- `export { parseSse, sseDone, sseReasoning, sseText } from "./sse.js";`
- `export type { SseFrame } from "./sse.js";`

### `packages/tracing/src/index.ts`

@fusionkit/tracing — OpenTelemetry-based tracing for the fusion stack.

The engine is the OTel SDK (ids, W3C propagation, batching, flush, OTLP
export); this package owns the thin domain layer: typed span and event
helpers over the fusion semantic conventions
(spec/fusion-trace/registry.json), the serializable trace carrier that
threads context through values, HTTP headers, and child environments, and
the in-process span/event listeners the narrator and product telemetry
subscribe to.

- `export { flushFusionTracing, fusionTracingServiceName, initFusionTracing, isEventExportConfigured, isFusionTracingActive, isTraceExportConfigured, resetFusionTracingForTest, shutdownFusionTracing } from "./provider.js";`
- `export type { InitFusionTracingOptions } from "./provider.js";`
- `export { addFusionEventListener, addSpanListener, hasFusionEventListeners, hasSpanListeners, listenerLogRecordProcessor, listenerSpanProcessor, removeFusionEventListener, removeSpanListener } from "./listener.js";`
- `export type { FusionEventListener, SpanListener } from "./listener.js";`
- `export { appendSpanListAttribute, carrierFromEnv, carrierFromHeaders, carrierOf, contextOf, emitFusionEvent, envOf, fusionBaggageOf, headersOf, jsonAttr, newSessionCarrier, newSpanId, newTraceId, sessionCarrier, startFusionSpan, traceIdOf, withFusionBaggage } from "./spans.js";`
- `export type { FusionAttributes, FusionBaggage, FusionScope, FusionSpan, FusionTraceCarrier } from "./spans.js";`
- `export { AllowlistLogExporter, AllowlistSpanExporter, isLoopbackOtlpEndpoint, toExportable, toExportableEvent, TRACE_REDACTED_ATTRIBUTE } from "./exportable.js";`
- `export type { AllowlistLogExporterOptions, AllowlistSpanExporterOptions } from "./exportable.js";`
- `export { attrBool, attrJson, attrNum, attrStr, eventNameOf, eventSpanId, eventTimeMs, eventTraceId, spanEndMs, spanId, spanTraceId } from "./readable.js";`
- `export type { AttributeSource, ReadableFusionEvent, ReadableSpan } from "./readable.js";`
- `export { InMemoryLogRecordExporter, InMemorySpanExporter, SimpleLogRecordProcessor, SimpleSpanProcessor } from "@velum-labs/routekit-tracing";`
- `export type { LogRecordProcessor, SpanProcessor } from "@velum-labs/routekit-tracing";`
- `export { ATTR, EXPORTABLE_ATTRIBUTES, FUSION_CONVENTIONS_VERSION, FUSION_EVENT_NAMES, FUSION_SCOPES, FUSION_SPAN_NAMES } from "@fusionkit/protocol";`
- `export type { FusionAttributeKey, FusionEventName, FusionSpanName } from "@fusionkit/protocol";`

### `packages/workspace/src/index.ts`

@fusionkit/workspace owns git workspace capture, materialization, output
collection, safe path resolution, and divergence-safe pull.

The CLI uses it to capture state before a run, the runner uses it to
materialize state inside a session and collect output, and the handoff SDK
uses it to checkpoint the workspace before continuation.

- `export { captureWorkspace, collectOutput, materializeWorkspace, pullRun } from "./workspace.js";`
- `export { gitText } from "./git.js";`
- `export { parseWorkspaceRelativePath, resolveInsideWorkspace } from "./paths.js";`
- `export type { CapturedWorkspace, PullResult, WorkspaceOutput } from "./workspace.js";`

## Python public package modules

### `python/fusionkit-core/src/fusionkit_core/__init__.py`

Public API for FusionKit's provider-neutral synthesis engine.

Public exports:

- `ChatClient`
- `ChatMessage`
- `ContextPolicy`
- `FakeModelClient`
- `FuseResult`
- `FusionConfig`
- `FusionEngine`
- `FusionKernel`
- `FusionMode`
- `FusionModeRouter`
- `JudgeSynthesizer`
- `ModelResponse`
- `PanelMode`
- `PromptOverrides`
- `RouteKitClient`
- `RunBudget`
- `SamplingConfig`
- `StreamChunk`
- `ToolCall`
- `Trajectory`
- `Usage`
- `build_clients`
- `judge_synthesizer_for`
- `load_config`

### `python/fusionkit-server/src/fusionkit_server/__init__.py`

Public API for the FusionKit HTTP server package.

The package exposes `create_app`, the FastAPI application factory used by the
Python CLI, local development servers, and tests. Generated code documentation
uses this docstring to describe the server package surface.

Public exports:

- `create_app`

### `python/fusionkit-cli/src/fusionkit_cli/__init__.py`

Public API for the FusionKit Python CLI package.

The package exposes the Typer application object that backs the PyPI `fusionkit`
console script. Generated code documentation uses this docstring to explain the
CLI package surface.

Public exports:

- `app`

### `python/fusionkit-evals/src/fusionkit_evals/__init__.py`

Public API for FusionKit evaluation and optimization tools.

The package re-exports benchmark runners, public benchmark registries, prompt
tuning helpers, hill-climb utilities, candidate banks, scorers, reports, and
sandbox helpers. Generated code documentation reads this docstring and the
`__all__` list as the supported evaluation surface.

Public exports:

- `BENCHMARK_PANELS`
- `LCB_PROMPT_SUFFIX`
- `BankCandidate`
- `BankTask`
- `BenchDrift`
- `BenchRunRecord`
- `BenchmarkComparison`
- `BenchmarkPanel`
- `BenchmarkPanelMember`
- `BenchmarkRunner`
- `CandidateBank`
- `DockerSandbox`
- `ExtractedCode`
- `LLMProposer`
- `LocalSandbox`
- `PreparedTask`
- `PromptEval`
- `PromptVariant`
- `Sandbox`
- `SandboxConfig`
- `SandboxResult`
- `SolutionRun`
- `StubProposer`
- `TaskOutcome`
- `TaskSplit`
- `TunerRuntime`
- `TuningResult`
- `append_run`
- `bank_signature`
- `build_candidate_bank`
- `build_provenance`
- `build_sandbox`
- `check_output`
- `classify_exception`
- `decode_tests`
- `drift_vs_previous`
- `evaluate_variant`
- `extract_code`
- `is_transient`
- `load_bank`
- `load_problems`
- `load_runs`
- `mcnemar`
- `normalize_lines`
- `optimize`
- `prepare_tasks`
- `regression_guard_tasks`
- `retry_async`
- `save_bank`
- `select_decision_tasks`
- `split_dev_val`
- `verify_solution`
- `CommandExternalBenchmarkExecutor`
- `CommandHandoffKitExecutor`
- `ComparisonBaselineRow`
- `CompoundComparison`
- `ModelRate`
- `compare_compound_vs_individual`
- `format_compound_comparison_markdown`
- `CandidateSample`
- `select_index`
- `selected_private_pass`
- `BestSingle`
- `ClimbDiagnosis`
- `ClimbResult`
- `TargetCheck`
- `best_single_baseline`
- `check_target`
- `diagnose_bank`
- `run_climb`
- `DECORRELATED_PEER_PANEL`
- `DIRTY_DOZEN_REPOS`
- `DIRTY_DOZEN_ROOT`
- `DIRTY_DOZEN_TASK_COUNT`
- `DirtyDozenRepo`
- `EvalResult`
- `EvalSample`
- `ExternalBenchmarkError`
- `ExternalBenchmarkExecutor`
- `ExternalBenchmarkRequest`
- `ExternalBenchmarkRun`
- `ExternalBenchmarkTaskRow`
- `ExternalBenchmarkUnavailable`
- `FUSION_BENCH_DISCLAIMER`
- `FUSION_MODEL_ALIASES`
- `FailureCorrelationRow`
- `FusionMountMode`
- `GatewayDialect`
- `GatewayTarget`
- `LOPSIDED_DEFAULT_PANEL`
- `PUBLIC_BENCH_DISCLAIMER`
- `PUBLIC_BENCHMARK_BASELINES`
- `PUBLIC_BENCHMARK_INFO`
- `PUBLIC_BENCHMARK_SUITES`
- `PanelHeadroom`
- `PublicBenchmarkInfo`
- `PublicBenchmarkSuite`
- `PublishedBaseline`
- `assert_public_benchmark_registry`
- `baselines_for`
- `best_baseline`
- `build_benchmark_comparison`
- `default_dialect_for_runner`
- `estimate_panel_headroom`
- `format_benchmark_comparison_markdown`
- `format_comparisons_markdown`
- `get_benchmark_panel`
- `panel_headroom_for_suite`
- `panel_member_published_scores`
- `parse_external_run`
- `run_public_benchmark`
- `write_benchmark_comparison_markdown`
- `write_external_runs_jsonl`
- `FusionBenchAggregateMetrics`
- `FusionBenchAttemptRow`
- `FusionBenchFailure`
- `FusionBenchFailureCorrelation`
- `FusionBenchParetoPoint`
- `FusionBenchReport`
- `FusionBenchReproducibilityMetadata`
- `FusionBenchRunner`
- `FusionBenchTask`
- `FusionBenchTaskMetrics`
- `HandoffKitExecutor`
- `HandoffKitExecutorError`
- `HandoffKitExecutorUnavailable`
- `PUBLIC_SMOKE_DISCLAIMER`
- `PUBLIC_SMOKE_FIXTURE_ROOT`
- `PUBLIC_SMOKE_SUITES`
- `PUBLIC_SMOKE_SUITE_INFO`
- `ParetoPoint`
- `LANGUAGES`
- `LanguageSpec`
- `PolyglotExercise`
- `PolyglotRun`
- `build_prompt`
- `load_polyglot_exercises`
- `run_polyglot`
- `PublicSmokeSuite`
- `PublicSmokeSuiteInfo`
- `TinyBenchmarkResult`
- `TinyBenchmarkTask`
- `assert_dirty_dozen_manifest`
- `assert_public_smoke_matrix`
- `build_fusion_bench_report`
- `contains_expected`
- `exact_match`
- `find_pareto_front`
- `format_fusion_bench_html_report`
- `format_fusion_bench_markdown_report`
- `format_pareto_markdown`
- `format_tiny_benchmark_report`
- `join_handoffkit_records`
- `load_benchmark_tasks`
- `load_dirty_dozen_tasks`
- `load_fusion_bench_jsonl`
- `load_public_smoke_tasks`
- `load_tiny_tasks`
- `parse_handoffkit_records`
- `run_tiny_benchmark`
- `score_fusion_bench_row`
- `write_tiny_benchmark_report`
- `write_fusion_bench_html_report`
- `write_fusion_bench_jsonl`
- `write_fusion_bench_markdown_report`
- `write_fusion_bench_report_jsonl`
- `write_tiny_jsonl`

### `python/fusionkit-mlx/src/fusionkit_mlx/__init__.py`

Public API for optional FusionKit MLX helpers.

The package exposes utilities for constructing the `mlx_lm.server` command used
by local Apple Silicon model serving. Generated code documentation uses this
docstring to describe the optional MLX integration surface.

Public exports:

- `MlxServerCommand`
- `build_mlx_lm_server_command`

### `python/uniroute/src/uniroute/__init__.py`

UniRoute: universal model routing for efficient LLM inference.

A NumPy implementation of arXiv:2502.08773v2 (Jitkrittum et al., 2025):
routing prompts over a *dynamic* pool of LLMs by representing each LLM as a
feature vector of prediction errors on a small validation set, so new LLMs
can be routed to without retraining the router.

Public exports:

- `DeferralCurve`
- `KNNRouter`
- `UniRouteKMeans`
- `UniRouteLearnedMap`
- `ZeroRouter`
- `area_under_curve`
- `assign`
- `cluster_error_embedding`
- `default_lambda_grid`
- `deferral_curve`
- `kmeans`
- `make_benchmark`
- `pareto_clean`
- `quality_neutral_cost`
- `route`
- `select_n_clusters`
- `zero_router_curve`

### `python/uniroute-mlx/src/uniroute_mlx/__init__.py`

UniRoute for locally served models (mlx-lm and any OpenAI-compatible API).

The `uniroute` package owns all the routing math; this package is the bridge
to running models: evaluate candidates over a validation set through their
OpenAI-compatible endpoints, fit a router, and freeze it into a portable
``uniroute.router.v1`` card that any runtime (including the repository's
TypeScript ``routedModel``) can route with.

Public exports:

- `ChatResult`
- `EndpointError`
- `Evaluation`
- `Example`
- `OpenAICompatibleClient`
- `RouterCard`
- `build_card`
- `evaluate_model`
- `load_card`
- `load_evaluations`
- `load_examples`
- `save_card`
- `save_evaluation`
- `score`

