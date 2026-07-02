# Generated code API reference

This file is generated from source comments by `pnpm docs:generate-code`. Do not edit it by hand. Update JSDoc or Python docstrings in the source files, then regenerate this file.

The generated reference intentionally covers package entry points and Python public package modules. It is the bridge between code annotations and maintained prose documentation.

## TypeScript package entry points

### `packages/adapter-ai-sdk/src/index.ts`

@fusionkit/adapter-ai-sdk is the AI SDK side of FusionKit for app-owned loops.

The application keeps its own generateText or streamText loop and its own
model; FusionKit governs the execution boundary. remoteTools returns AI
SDK-compatible tools whose calls run as signed contracts in governed runner
sessions and return with offline-verifiable receipts. The model surfaces
withModel, routedModel, and mlxServer route the caller's own loop across
local and cloud models with every decision recorded.

- `export { remoteTools } from "./remote-tools.js";`
- `export type { RemoteToolCallRecord, RemoteTools, RemoteToolsConfig, RemoteToolsContextConfig } from "./remote-tools.js";`
- `export { swarmTools } from "./swarm-tools.js";`
- `export type { DispatchInput, DispatchOutput, EscalateInput, EscalateOutput, PullInput, PullOutput, StatusInput, StatusOutput, SwarmPlane, SwarmRunRecord, SwarmTools, SwarmToolsConfig, SwarmToolsContextConfig, SwarmToolSet, WorkerTaskInput } from "./swarm-tools.js";`
- `export { handoffModel, withModel } from "./model.js";`
- `export type { EscalationReason, HandoffModelConfig } from "./model.js";`
- `export { loadRouterCard, routedModel, withRoutedModel } from "./routed-model.js";`
- `export type { RouteDecision, RoutedModelConfig, RouterCard } from "./routed-model.js";`
- `export { runWorktreeAgent, worktreeDiff } from "./worktree-agent.js";`
- `export type { TrajectoryStep, TrajectoryStepType, WorktreeAgentInput, WorktreeAgentResult } from "./worktree-agent.js";`
- `export { defaultMlxDir, MlxCapabilityError, MlxEnv } from "./mlx-env.js";`
- `export type { DownloadProgress, LocalModelInfo, ProvisionEvent } from "./mlx-env.js";`
- `export { managedModelServer, mlxServer } from "./managed-server.js";`
- `export type { ManagedModelServerOptions, ManagedServerEvent, MlxServerOptions } from "./managed-server.js";`

### `packages/adapter-compute/src/index.ts`

@fusionkit/adapter-compute is a ComputeSDK-shaped compute surface over
governed runner sessions.

The shape matches what ComputeSDK users already write: compute.sandbox.create,
sandbox.runCommand, and sandbox.filesystem.writeFile. The substrate is
FusionKit governance: every command is a signed run contract executed in a
governed session with an offline-verifiable receipt.

Each command runs in a fresh session materialized from the current workspace
state. Continuity flows through the workspace's git history, not through a
long-lived remote process. The adapter stages inputs as commits and pulls
outputs back after each command, so sequential commands compose. A
filesystem.writeFile call stages input files locally for the next command; it
is not a remote mutation because nothing exists remotely between commands.

- `export { governedCompute, GovernedSandbox, withCompute } from "./sandbox.js";`
- `export type { CommandResult, GovernedCompute, GovernedComputeConfig, SandboxRunRecord } from "./sandbox.js";`

### `packages/cli/src/index.ts`

Entry point for the FusionKit command line package. The executable itself lives in src/index.ts, while cli.ts builds the Commander command tree.

No exports found.

### `packages/ensemble/src/index.ts`

FusionKit ensemble runtime entry point. It exposes harness execution, panel workflows, judge synthesis, runtime-kernel workflows, operators, schedulers, worktrees, isolation helpers, and tool execution.

- `export { createCommandHarness } from "./command.js";`
- `export type { CommandHarnessOptions } from "./command.js";`
- `export { resolveCursorkitCli } from "./cursorkit-path.js";`
- `export type { CursorkitCli } from "./cursorkit-path.js";`
- `export { createArtifactStore } from "./artifacts.js";`
- `export type { ArtifactStore } from "./artifacts.js";`
- `export { createMockJudgeSynthesizer } from "./judge.js";`
- `export type { JudgeCandidateEvidence, JudgeInput, JudgePatch, JudgeSynthesizer, JudgeSynthesisOutput, MockJudgeSynthesizerOptions, SynthesisFailureSummary } from "./judge.js";`
- `export { ensemble, runEnsemble } from "./run.js";`
- `export { buildPanelPrompt, createFusionKitJudgeSynthesizer, runFusionPanelWorkflow, runFusionPanels, runUnifiedHarnessE2E, setToolHarnessProvider } from "./unified.js";`
- `export type { CursorHarnessRunnerInput, CursorHarnessRunnerResult, FusionPanelOptions, ToolHarnessProvider, ToolHarnessResolveOptions, UnifiedHarnessE2EOptions, UnifiedHarnessE2EResult, UnifiedHarnessKind, UnifiedHarnessMatrixResult } from "./unified.js";`
- `export { ambientTraceId, emitTrace, getTraceEmitter, newSpanId, newTraceId, TRACE_CANDIDATE_HEADER, TRACE_ID_HEADER, TRACE_PARENT_SPAN_HEADER, TRACE_SPAN_HEADER, TraceEmitter } from "./trace.js";`
- `export type { EmitInput, FusionTraceComponent, FusionTraceEvent, FusionTraceEventType } from "./trace.js";`
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
- `export { createMockHarness } from "./mock.js";`
- `export type { MockCandidateFixture, MockHarnessOptions } from "./mock.js";`
- `export { traceCandidate } from "./candidate-trace.js";`
- `export type { CandidateOutcome, CandidateTraceContext, CandidateTraceInput, CandidateTracer } from "./candidate-trace.js";`
- `export { createToolExecutor, registerDemoTools, sideEffectsForTool } from "./tool-executor.js";`
- `export type { ToolExecutor, ToolImplementation } from "./tool-executor.js";`
- `export { executeFusionKitToolBatch, FusionKitToolExecutorClient, FusionKitToolExecutorClientError, FusionKitToolExecutorError, startFusionKitToolExecutorServer } from "./external-executor.js";`
- `export { createCliContainerDriver, runCandidateCommandWithIsolation, secretAbsenceMetadata, secretValueHash } from "./isolation.js";`
- `export type { FusionKitToolExecutionBatch, FusionKitToolExecutionRequest, FusionKitToolExecutionResponse, FusionKitToolExecutionResult, FusionKitToolExecutorServer, FusionKitToolExecutorServerOptions } from "./external-executor.js";`
- `export type { CandidateCommandIsolationInput, CandidateCommandIsolationResult } from "./isolation.js";`
- `export { cleanupCandidateWorktree, cleanupWorktreePlan, createWorktreePlan, defaultOutputRoot, diffCandidateWorktree, sealCandidateWorktree } from "./worktree.js";`
- `export type { CandidateWorktree, WorktreePlan } from "./worktree.js";`
- `export { hardeningToJson, panelMemberPreamble } from "./harness.js";`
- `export type { EnsembleCandidateSummary, EnsembleDescriptor, EnsembleJudge, EnsembleModel, EnsemblePolicy, EnsembleRunResult, EnsembleRuntime, CandidateContainerDriver, CandidateContainerDriverInput, CandidateContainerDriverResult, CandidateHardeningMetadata, CandidateIsolationConfig, CandidateIsolationKind, CandidateIsolationMountPolicy, CandidateIsolationNetworkPolicy, CandidateIsolationSecretPolicy, HarnessAdapter, HarnessArtifact, HarnessCapabilities, HarnessCandidateOutput, HarnessCollectInput, HarnessPrepareInput, HarnessRunInput, HarnessEndReason, HarnessToolRecord, HarnessTrajectory, TrajectoryStep, TrajectoryStepType, ReviewEvidence, EnsembleRunSummary, VerificationProfile } from "./harness.js";`

### `packages/example-utils/src/index.ts`

Example utilities entry point. It exposes demo manifest parsing, mock model helpers, live model helpers, and narration utilities.

No exports found.

### `packages/handoff/src/index.ts`

@fusionkit/handoff is the continuation-first SDK.

Start work wherever it naturally begins, continue it on a governed runner
when conditions change, preserve state across the boundary, and prove what
moved, why it moved, who approved it, and how to resume.

Everything here composes FusionKit governance primitives. A continuation is a
signed run contract, the moved state is a content-addressed envelope pinned
by that contract, and the result is an offline-verifiable receipt.

- `export { defineHandoffConfig, Handoff, handoff } from "./handoff.js";`
- `export type { ContinueOptions, HandoffConfig, HandoffInit, HandoffStreamEvent, HandoffSummary, HandoffTraceEvent, ModelDecision, ParallelOptions } from "./handoff.js";`
- `export { HandoffRun } from "./run.js";`
- `export type { WaitOptions, WaitOutcome } from "./run.js";`
- `export { createCommandContext, executeGovernedCommand, toGovernedRunRecord } from "./run-executor.js";`
- `export type { CommandHarnessConfig, GovernedCommandOptions, GovernedCommandResult, GovernedRunRecord } from "./run-executor.js";`
- `export { targets } from "./targets.js";`
- `export type { RuntimeTarget } from "./targets.js";`
- `export { agents } from "./agents.js";`
- `export { localFirst } from "./policy.js";`
- `export type { ContinuationPolicy, LocalFirstOptions } from "./policy.js";`
- `export { triggers } from "./triggers.js";`
- `export type { FiredTrigger, Trigger } from "./triggers.js";`
- `export { branch } from "./isolation.js";`
- `export type { IsolationStrategy } from "./isolation.js";`
- `export { reviewStrategies, scorecardFor } from "./review.js";`
- `export type { ReviewedRun, ReviewResult, ReviewStrategy, Scorecard } from "./review.js";`
- `export type { ToolCallObservation, ToolLike } from "./tools.js";`

### `packages/kernel/src/index.ts`

Dependency-free runtime kernel entry point. It re-exports artifacts, operator graph utilities, validation helpers, runtime primitives, and wire artifact helpers.

No exports found.

### `packages/model-gateway/src/index.ts`

@fusionkit/model-gateway is the Fusion Harness Gateway entry point.

It fronts OpenAI-compatible Chat Completions backends, local MLX servers, and
fused panel routes, then exposes the wire dialects each agent harness needs.
A local or fused model can back opencode, Claude Code, Codex, Cursor, and raw
HTTP callers without changing their workflow.

Public exports include server startup, backend implementations, frontdoor
workflows, session stores, cost metering, rate-limit failover, dialect
adapters, ACP helpers, provenance records, and trajectory capture.

- `export { startGateway } from "./server.js";`
- `export type { Gateway, GatewayOptions } from "./server.js";`
- `export { joinPath, OpenAiBackend } from "./backend.js";`
- `export type { Backend, BackendRequestOptions, OpenAiBackendOptions } from "./backend.js";`
- `export { FusionBackend } from "./fusion-backend.js";`
- `export { InMemoryFusionBackendKernelStateStore } from "./fusion-backend.js";`
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
- `export type { ChatMessageLike, FuseStepRunInput, FuseStepRunner, FusionBackendKernelSessionState, FusionBackendKernelStateStore, FusionBackendOptions, OnRateLimitPolicy, PanelRunInput, PanelRunner, PassthroughModel, SessionMetaInput } from "./fusion-backend.js";`
- `export type { WireTrajectory } from "@fusionkit/protocol";`
- `export { defaultSessionsDir, FileSystemSessionStore, InMemorySessionStore } from "./session-store.js";`
- `export type { PersistedSession, SessionMeta, SessionStore, SessionSummary, SessionTurnRecord } from "./session-store.js";`
- `export { addTurnCost, DEFAULT_MODEL_PRICING, emptySessionCost, estimateCost, formatUsd, lookupPricing, meterTurn, parseUsage, parseUsageFromSse, turnCostLine } from "./cost.js";`
- `export type { ModelPricing, SessionCost, TokenUsage, TurnCost } from "./cost.js";`
- `export { MlxBackend } from "./mlx-backend.js";`
- `export type { MlxBackendOptions } from "./mlx-backend.js";`
- `export { createBackend, DEFAULT_MLX_MODEL, resolveBackendConfig } from "./config.js";`
- `export type { BackendConfig } from "./config.js";`
- `export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";`
- `export { anthropicModelsResponse, anthropicToChat, chatToAnthropicMessage, claudeModelAlias, countTokensEstimate, handleAnthropicMessages, handleCountTokens, mapStopReason, openAiSseToAnthropic } from "./adapters/anthropic.js";`
- `export type { AnthropicRequest } from "./adapters/anthropic.js";`
- `export { chatToResponses, handleResponses, openAiSseToResponses, responsesToChat } from "./adapters/responses.js";`
- `export type { ResponsesRequest } from "./adapters/responses.js";`
- `export { FUSION_EVIDENCE_HEADER, FUSION_REPORT_HEADER, FUSION_RUN_ID_HEADER, FUSION_STATUS_HEADER, formatAnthropic, formatChat, formatResponses, promptFromAnthropic, promptFromChat, promptFromResponses, startFusionGateway } from "./fusion-gateway.js";`
- `export type { ChatRequest, FrontDoorDialect, FrontDoorRunner, FrontDoorRunnerInput, FrontDoorRunnerResult, FusionGateway, FusionGatewayOptions } from "./fusion-gateway.js";`
- `export { ACP_PROTOCOL_VERSION, runAcpAgent } from "./acp-agent.js";`
- `export type { AcpAgentOptions, AcpRunner, AcpRunnerInput, AcpRunnerResult } from "./acp-agent.js";`
- `export { runFrontDoorAcceptance } from "./front-door-acceptance.js";`
- `export type { FrontDoorAcceptanceOptions, FrontDoorAcceptanceReport, FrontDoorOutcome, FrontDoorOutcomeProducer, FrontDoorStatus } from "./front-door-acceptance.js";`
- `export { ACP_REGISTRY_URL, fetchAcpRegistry, installAcpAdapters } from "./acp-registry.js";`
- `export type { AcpRegistry, AcpRegistryAgent, AcpRegistryFetcher, InstallAcpAdaptersOptions, InstalledAcpAdapter } from "./acp-registry.js";`
- `export { buildModelCallRecord, MODEL_CALL_ID_HEADER, modelCallId, readProducerVersion, resolveProducerGitSha, responseBodyHash, UNKNOWN_GIT_SHA } from "./provenance.js";`
- `export type { GatewayDialect, ModelCallRecord, ModelGatewayCallContext, ModelGatewayCallResult, ProvenanceSink } from "./provenance.js";`
- `export { createTrajectoryCapture, reconstructTrajectory } from "./trajectory-capture.js";`
- `export type { CapturedStep, CapturedTrajectory, TrajectoryCapture } from "./trajectory-capture.js";`

### `packages/plane/src/index.ts`

@fusionkit/plane is the governance control plane.

It owns contracts, policy evaluation, approvals, receipt countersignature,
secret brokering, audit export, durable SQLite storage, identity, auth, rate
limiting, retention, metrics, and the control panel UI. Product-facing fusion
flows do not need to import every primitive here, but retained governance and
VM packages rely on this stable surface.

- `export { Plane } from "./plane.js";`
- `export type { PlaneConfig, IssuedPrincipal } from "./plane.js";`
- `export { startPlaneServer } from "./server.js";`
- `export type { PlaneServerOptions } from "./server.js";`
- `export { defaultPolicy, evaluatePolicy } from "./policy.js";`
- `export type { PolicyDecision, PolicyRequest } from "./policy.js";`
- `export { badRequest, capabilityMismatch, conflict, forbidden, isPlaneDomainError, notFound, PlaneDomainError, unauthorized } from "./domain-errors.js";`
- `export type { PlaneErrorCode } from "./domain-errors.js";`
- `export { ClaimTokenService } from "./claim-token-service.js";`
- `export type { ClaimTokenPayload, ClaimTokenServiceOptions, VerifiedClaimToken } from "./claim-token-service.js";`
- `export { ContractService } from "./contract-service.js";`
- `export type { ContractServiceOptions } from "./contract-service.js";`
- `export { ReceiptService } from "./receipt-service.js";`
- `export type { ReceiptServiceConfig } from "./receipt-service.js";`
- `export { SqliteStore } from "./sqlite-store.js";`
- `export type { EnrollTokenRecord, PlaneStore, PrincipalRecord, PrincipalRole, RunRecord, RunRequest, RunnerRecord } from "./store.js";`
- `export { SecretStore } from "./secrets.js";`
- `export { FileKeyProvider, generateMasterKeyHex, masterKeyFromMaterial, open, openFromFile, resolveMasterKey, seal, sealToFile } from "./keys.js";`
- `export type { KeyProvider, MasterKey, OrgKeyPair, SealedBlob } from "./keys.js";`
- `export { hashToken, principalCan, toPrincipal } from "./auth.js";`
- `export type { Capability, Principal } from "./auth.js";`
- `export { IdpVerifier } from "./idp.js";`
- `export type { IdpConfig, VerifiedApproval } from "./idp.js";`
- `export { DEFAULT_RATE_LIMIT, RateLimiter } from "./ratelimit.js";`
- `export type { RateLimitConfig } from "./ratelimit.js";`
- `export { createLogger, Metrics } from "./logging.js";`
- `export type { Logger } from "./logging.js";`
- `export { collectReferencedBlobs, RetentionSweeper } from "./retention.js";`
- `export type { RetentionResult } from "./retention.js";`
- `export { approveBodySchema, cancelBodySchema, claimBodySchema, completeBodySchema, createRunBodySchema, enrollBodySchema, eventsBodySchema, issuePrincipalBodySchema, parseBody, runRequestSchema, ValidationError } from "./validation.js";`

### `packages/protocol/src/index.ts`

@fusionkit/protocol is the open, versioned data contract layer.

It exports signed run contracts, receipts, hash-chained event logs, workspace
manifests, policy snapshots, checkpoints, handoff envelopes, model-fusion
schemas, generated OpenAPI clients, hashing, signing, verification, trace
events, validators, and normalization helpers.

Everything here is stable protocol surface. Packages should consume these
interfaces instead of recreating local string lists or proof logic.

- `export { ACTOR_KINDS, AGENT_KINDS, CHECKPOINT_TIERS, DISCLOSURE_MODES, HEX_HASH_PATTERN, isAgentKind, isTerminalStatus, MODEL_FUSION_SCHEMA_NAMES, PROTOCOL_VERSIONS, RUN_EVENT_TYPES, RUN_STATUSES, SESSION_ISOLATIONS, TERMINAL_RUN_STATUSES } from "./constants.js";`
- `export { parseHostAllowlistEntry, parsePoolName, parseSecretName, parseWorkspaceManifestPath } from "./validators.js";`
- `export { defaultExecutionSpec, executionFromRunRequest } from "./execution.js";`
- `export type { ExecutionEnv, ExecutionLogPolicy, ExecutionSpec } from "./execution.js";`
- `export { evaluateToolPolicy, modelFusionSideEffects, toolArgumentsHash, toolCallKey, toolSideEffectClassFromModelFusion } from "./tool-executor.js";`
- `export type { ToolDefinition, ToolExecutionRequest, ToolExecutionResult, ToolExecutorBudget, ToolExecutorContract, ToolExecutorLimits, ToolExecutorMode, ToolPolicyDecision, ToolSideEffectClass } from "./tool-executor.js";`
- `export { canonicalize } from "./jcs.js";`
- `export type { JsonValue } from "./jcs.js";`
- `export { assertWireTrajectory, isWireTrajectory, normalizeWireTrajectories } from "./fusion-wire.js";`
- `export type { WireTrajectory } from "./fusion-wire.js";`
- `export { artifactHash, hashCanonical, hashCanonicalSha256, requestHash, responseHash, schemaBundleHash, SHA256_PREFIX, sha256Hex, sha256PrefixedHex } from "./hash.js";`
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
- `export { addTraceListener, ambientTraceId, assertFusionTraceEvent, emitTrace, FUSION_TRACE_COMPONENTS, FUSION_TRACE_EVENT_SCHEMA, FUSION_TRACE_EVENT_TYPES, FUSION_TRACE_EVENT_VERSION, getTraceEmitter, isFusionTraceEvent, judgeFinalPayload, judgeRequestPayload, judgeThinkingPayload, modelCallFinishedPayload, modelCallStartedPayload, newSpanId, newTraceId, removeTraceListener, TRACE_CANDIDATE_HEADER, TRACE_ID_HEADER, TRACE_PARENT_SPAN_HEADER, TRACE_SPAN_HEADER, TraceEmitter } from "./trace.js";`
- `export type { EmitInput, FusionTraceComponent, FusionTraceEvent, FusionTraceEventType, TraceListener } from "./trace.js";`
- `export { PolicyDeniedError } from "./types.js";`
- `export type { ActorRef, AgentKind, AgentSpec, ArtifactKind, AttestationTier, BudgetSpec, ChainedEvent, Checkpoint, CheckpointTier, ConsentRule, ContinuationRef, DataClassRule, DisclosureMode, DisclosureRecord, FailureClass, HandoffEnvelope, HandoffSource, HandoffTargetRef, KeyRef, ManifestFile, ModelUsageRecord, NetworkAccessRecord, NetworkPolicy, Policy, Receipt, ReceiptBundle, RetentionPolicy, RunContract, RunEvent, RunnerIdentity, RunnerSelector, RunStatus, SecretClaim, SecretReleaseRecord, SecretScopeRule, SemanticState, SessionIsolation, Signature, TaskSpec, ToolCallRecord, ToolJournal, WorkspaceManifest } from "./types.js";`
- `export type { ClaimResult, DisclosureReport, PolicyDecision, RunnerSummary, RunRequest, RunRequestInput, RunSummary, RunView } from "./api.js";`

### `packages/runner/src/index.ts`

@fusionkit/runner is the outbound-only governed runner entry point.

The runner claims signed contracts, materializes workspaces, runs vendor agent
harnesses inside governed sessions, and signs receipts. The public surface is
deliberately small: Runner, the SessionBackend seam implemented by isolation
tiers, session capability errors, and the execution helpers those backends
share. Everything else is runner-internal.

- `export { Runner } from "./runner.js";`
- `export { CapabilityMismatchError } from "./session.js";`
- `export type { SessionBackend, SessionBackendResult, SessionExecution } from "./backend.js";`
- `export { executionHash, executionSpecFor, prepareExecution, requireShellExecution, resolveSessionEnv } from "./execution.js";`
- `export type { BackendExecutionKind } from "./execution.js";`

### `packages/sdk/src/index.ts`

@fusionkit/sdk is a thin client over the governance plane API.

Protocol primitives such as verification, hashing, and wire types live in
@fusionkit/protocol. Consumers import them from the protocol package rather
than through this SDK.

- `export { PlaneClient, PlaneClientError } from "./client.js";`

### `packages/session-harness/src/index.ts`

@fusionkit/session-harness drives vendor agent harnesses through the AI SDK
harness abstraction inside a sandbox.

It runs under the same governed-session contract as every other backend:
workspace staged in, structured evidence in the receipt, and secrets supplied
through the broker. The generic backend is binding-driven. Shipped bindings
cover Claude Code in a Vercel Sandbox microVM and Pi on a local just-bash
sandbox for a cheap local swarm worker.

- `export { AiSdkHarnessBackend, harnessBackend, isAgentRunFor } from "./backend.js";`
- `export type { CreateHarnessInput, CreateSandboxProviderInput, HarnessAdapter, HarnessBinding, HarnessSandboxProvider } from "./backend.js";`
- `export { aiSdkHarnessBackend, claudeCodeBinding, isClaudeCodeAgentRun } from "./claude-code.js";`
- `export type { AiSdkHarnessBackendOptions, ClaudeCodeBindingOptions } from "./claude-code.js";`
- `export { isPiAgentRun, piBinding, piHarnessBackend } from "./pi.js";`
- `export type { PiBindingOptions, PiHarnessBackendOptions } from "./pi.js";`
- `export { claudeCodeAuthFromEnv, piAuthFromEnv } from "./auth.js";`
- `export { TranscriptRecorder } from "./transcript.js";`
- `export type { TranscriptLine } from "./transcript.js";`

### `packages/session-hermetic/src/index.ts`

@fusionkit/session-hermetic is a hermetic session backend built on just-bash.

just-bash provides a simulated bash interpreter with a virtual filesystem and
interpreter-enforced network allowlists. There are no real processes or
sockets inside the session, so there is nothing to escape with. Egress is
enforced by the interpreter rather than by environment variables a binary
could ignore. The trade-off is explicit: only command harnesses run here
because there is no real OS for vendor CLIs or the node-based mock.

- `export function toJustBashNetwork(policy: NetworkPolicy): NetworkConfig ...`
  Map a Warrant network policy to just-bash's allowlist model.
- `export class HermeticSessionBackend implements SessionBackend ...`
- `export function hermeticBackend(): HermeticSessionBackend ...`
  Create a hermetic session backend for a Warrant runner.

### `packages/session-vercel-sandbox/src/index.ts`

@fusionkit/session-vercel-sandbox runs governed sessions inside Vercel
Sandbox Firecracker microVMs.

This is the strongest isolation tier in the repository: VM-level separation
with domain-based egress policy applied at the VM boundary. It compiles
against the real @vercel/sandbox types, but live execution requires Vercel
credentials. Without credentials, vercelSandboxBackend still constructs and
execute throws a clear capability error.

This module also owns sandbox-shaped helpers for file listing, shell quoting,
mirror-back writes, credential resolution, and network policy mapping.

- `export type VercelSandboxSource ...`
- `export type VercelSandboxResources ...`
- `export type VercelSandboxCreateInput ...`
- `export type VercelSandboxInstance ...`
- `export type VercelSandboxFactory ...`
- `export type VercelSandboxOptions ...`
- `export const SANDBOX_IGNORED_DIRS: ReadonlySet<string> ...`
  Directory names never staged into a sandbox and never mirrored back: VCS metadata stays local (output is collected as a git diff on the runner side) and dependency trees are reinstalled inside the VM when the task needs them. Backends with runtime-specific state directories extend this set at the call site.
- `export function shellQuote(value: string): string ...`
  Quote a value for POSIX sh: single quotes, with embedded single quotes rendered as '\''. Unlike double quotes, nothing inside single quotes is expanded, so secret values containing $, backticks, or quotes are inert.
- `export function listWorkspaceFiles(`
  List a workspace's files as relative paths, skipping the shared ignored directories plus any backend-specific extras. The one walker used to stage workspaces into sandboxes.
- `export function writeMirroredFile(`
  Write one mirrored-back sandbox file into the local checkout, with the path validated against escape before anything touches the filesystem. Shared by every sandbox-shaped backend so mirror-back path safety lives in exactly one place.
- `export function vercelCredentialsFromEnv(`
  Resolve Vercel credentials from explicit options or the ambient environment, failing closed (capability error) when no token exists.
- `export function toVercelNetwork(`
  Map a Warrant network policy to a Vercel Sandbox network policy.
- `export class VercelSandboxBackend implements SessionBackend ...`
- `export function vercelSandboxBackend(`
  Create a Vercel Sandbox session backend for a Warrant runner.

### `packages/testkit/src/index.ts`

@fusionkit/testkit provides in-process plane and runner stacks plus git
fixtures shared by integration tests and demos.

Everything runs locally with the built-in mock agent. It does not require
vendor CLIs or API keys, which makes it the preferred harness for deterministic
tests and examples.

- `export function git(cwd: string, args: string[]): string ...`
  Re-exported shared git helper so fixtures and tests share one implementation.
- `export type RepoFixtureOptions ...`
- `export function makeRepo(options: RepoFixtureOptions ...`
  A throwaway git repository with an initial commit.
- `export type StackOptions ...`
- `export type Stack ...`
- `export function mockRunRequest(`
  The standard mock-agent run request the demos and tests share: human requester, deny-by-default network, empty budget, minimal-context disclosure. Pass overrides for whatever the scenario actually varies.

### `packages/tool-claude/src/index.ts`

Claude Code tool integration entry point. It exposes launcher environment helpers and the Claude Code ensemble harness adapter.

- `export const claudeTool: ToolIntegration ...`
- `export { claudeCodeHarness, claudeCodeHarnessCredentialSkipReason, createClaudeCodeHarness } from "./harness.js";`
- `export type { ClaudeCodeHarnessEnv, ClaudeCodeHarnessOptions } from "./harness.js";`
- `export { claudeEnv, launchClaude } from "./launch.js";`

### `packages/tool-codex/src/index.ts`

Codex tool integration entry point. It exposes the Codex launcher and ensemble harness adapter used by the FusionKit CLI.

- `export const codexTool: ToolIntegration ...`
- `export { codexConfigToml, codexEndReason, codexHarness, codexHarnessCredentialSkipReason, createCodexHarness, defaultCodexRunner } from "./harness.js";`
- `export type { CodexAmbientProvider, CodexApprovalPolicy, CodexConfigTomlInput, CodexExecInput, CodexExecResult, CodexExecRunner, CodexHarnessEnv, CodexHarnessOptions, CodexOpenAiCompatibleProvider, CodexProvider, CodexResponsesProvider, CodexSandboxMode } from "./harness.js";`
- `export { codexLaunchConfigToml, codexModelCatalogJson, launchCodex, readCodexCatalogTemplate } from "./launch.js";`

### `packages/tool-cursor/src/index.ts`

Cursor tool integration entry point. It exposes Cursor launcher helpers, the Cursorkit bridge, and the Cursor ensemble harness adapter.

- `export const cursorTool: ToolIntegration ...`
- `export { createCursorHarness, cursorHarness, cursorHarnessUnavailableReason, defaultCursorRunner } from "./harness.js";`
- `export type { CursorExecInput, CursorExecResult, CursorExecRunner, CursorHarnessOptions, CursorRunMode } from "./harness.js";`
- `export { startCursorBridge } from "./bridge.js";`
- `export { cursorIdeInstructions, cursorInstructions, launchCursor } from "./launch.js";`

### `packages/tool-opencode/src/index.ts`

opencode tool integration entry point. It exposes launcher configuration helpers for local-model and gateway-backed opencode sessions.

- `export const opencodeTool: ToolIntegration ...`
- `export { launchOpencode, opencodeConfig, opencodeModelArg } from "./launch.js";`

### `packages/tools/src/index.ts`

Tool integration entry point. It exposes the launcher and harness integration contract, registry helpers, process helpers, constants, environment compatibility helpers, and skipped-candidate utilities.

- `export { distillLog, freePort, sleep, spawnLogged, spawnTool, terminate, waitForHttp, waitForOutput } from "./proc.js";`
- `export type { LoggedChild, LoggedSpawnOptions } from "./proc.js";`
- `export type { ToolDashboardLiveSmoke, ToolDashboardMetadata, ToolDashboardSmoke, ToolHarnessMetadata, ToolIntegration, ToolLaunchContext, ToolLaunchMode } from "./types.js";`
- `export { createToolRegistry } from "./registry.js";`
- `export type { ToolRegistry } from "./registry.js";`
- `export { CURSOR_BRIDGE_MODEL_NAME, FUSION_PANEL_MODEL, LOCAL_MODEL_LABEL } from "./constants.js";`
- `export { envFlagEnabled, legacyEnvName, readEnv } from "./env-compat.js";`
- `export { DEFAULT_BRIDGE_SCRUB_PREFIXES, definedEnv, normalizeApiBaseUrl, scrubBridgeEnv } from "./env.js";`
- `export { buildSkippedCandidate } from "./candidate.js";`

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

Public API for the FusionKit Python engine.

The package re-exports the configuration models, provider clients, fusion engine,
judge synthesizer, run manager, contract models, artifact helpers, trace helpers,
and trajectory producers used by the Python server, CLI, benchmarks, and tests.
Keep this module documented because generated API docs read this docstring and
the `__all__` list as the supported Python surface.

Re-exports are resolved lazily (PEP 562): importing any single submodule (for
example ``fusionkit_core.config``) must not pay for the provider SDK stack that
``fusionkit_core.clients`` drags in. This keeps CLI startup (``fusionkit
--version``, ``fusionkit prompts dump``) fast while ``from fusionkit_core
import X`` keeps working unchanged for every name in ``__all__``.

Public exports:

- `TRACE_ID_HEADER`
- `TRACE_PARENT_SPAN_HEADER`
- `TRACE_SPAN_HEADER`
- `TRACE_TRAJECTORY_HEADER`
- `AgentTrajectoryProducer`
- `AnthropicModelClient`
- `ArtifactRefV1`
- `BenchmarkTaskRecordV1`
- `ChatMessage`
- `ChatTrajectoryProducer`
- `CodexResponsesClient`
- `ContractMetadata`
- `ContractRecord`
- `CostMetadata`
- `CreateRunResult`
- `EndpointAuth`
- `EndpointCapabilities`
- `EnsembleReceiptV1`
- `ExternalTrajectoryProducer`
- `FakeModelClient`
- `FileSystemRunStore`
- `FuseResult`
- `FusionConfig`
- `FusionEngine`
- `FusionKernel`
- `FusionMode`
- `FusionRecordV1`
- `FusionRunEvent`
- `FusionRunManager`
- `FusionRunRequestV1`
- `FusionRunState`
- `GoogleModelClient`
- `HarnessCandidateRecordV1`
- `HarnessRunResultV1`
- `HeuristicRouter`
- `IdempotencyRecord`
- `JudgeSynthesizer`
- `LocalArtifactStore`
- `LocalModelClient`
- `ModelCallRecordV1`
- `ModelEndpoint`
- `ModelEndpointV1`
- `ModelResponse`
- `NativeRunError`
- `OpenAICompatibleClient`
- `ProviderCallError`
- `ProviderErrorCategory`
- `ProviderKind`
- `RunBudget`
- `RunEventPage`
- `RunInspection`
- `RunStateSummary`
- `SamplingConfig`
- `StreamChunk`
- `SubscriptionAuthError`
- `SubscriptionAuthMode`
- `SubscriptionStatus`
- `SubscriptionToken`
- `ToolCall`
- `ToolCallPlanV1`
- `ToolExecutionMode`
- `ToolExecutionPolicy`
- `ToolExecutionRecordV1`
- `ToolExecutor`
- `ToolPausePlaceholder`
- `ToolResultSubmission`
- `Trajectory`
- `TrajectoryInspection`
- `TrajectoryProducer`
- `TrajectoryV1`
- `TraceEmitter`
- `Usage`
- `ambient_trace_id`
- `build_client`
- `build_clients`
- `canonical_json`
- `classify_provider_error`
- `contract_metadata`
- `contract_model_for_schema`
- `emit`
- `endpoint_to_contract`
- `estimate_cost`
- `get_emitter`
- `hash_bytes`
- `hash_json`
- `hash_text`
- `load_claude_code_credentials`
- `load_codex_credentials`
- `make_id`
- `new_span_id`
- `new_trace_id`
- `normalize_usage`
- `producer`
- `producer_git_sha`
- `producer_version`
- `provider_metadata`
- `resolve_api_key`
- `resolve_credential`
- `schema_bundle_hash`
- `status_for_run_state`
- `subscription_status`
- `trajectory_from_contract`
- `trajectory_from_response`
- `trajectory_to_contract`

Documented local symbols:

- `__getattr__` (function): Resolve a re-exported name (or submodule) on first access.
- `__dir__` (function)

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
- `ProportionCI`
- `Sandbox`
- `SandboxConfig`
- `SandboxResult`
- `SeedAggregate`
- `SolutionRun`
- `StubProposer`
- `TaskOutcome`
- `TaskSplit`
- `TunerRuntime`
- `TuningResult`
- `aggregate_seeds`
- `append_run`
- `bank_signature`
- `bootstrap_ci`
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
- `pass_at_k`
- `prepare_tasks`
- `regression_guard_tasks`
- `retry_async`
- `save_bank`
- `select_decision_tasks`
- `split_dev_val`
- `verify_solution`
- `wilson_interval`
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

