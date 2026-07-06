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

### `packages/cli-ui/src/index.ts`

@fusionkit/cli-ui — the fusionkit terminal UX layer.

One presenter contract, two implementations: rich Ink (React) rendering on
interactive TTYs, ordered plain-text lines everywhere else (CI, pipes,
`FUSIONKIT_NO_TUI=1`). All UI goes to stderr; stdout stays reserved for
machine payloads and the launched tool's output.

- `export { PlainPresenter, renderErrorPanelLines, renderKeyValueLines, renderTableLines } from "./plain.js";`
- `export { InkPresenter, mountInk, settleInk } from "./ink/presenter.js";`
- `export { select, multiselect, confirm, text, fuzzySelect, autocompleteText, BACK, done, note } from "./prompt.js";`
- `export type { SelectOption, Back } from "./prompt.js";`
- `export { fuzzyFilter, fuzzyMatch } from "./fuzzy.js";`
- `export type { FuzzyMatch, FuzzyResult } from "./fuzzy.js";`
- `export { runWizard } from "./wizard.js";`
- `export type { WizardStep } from "./wizard.js";`
- `export function createPresenter(options: ...`
  The presenter for this invocation: Ink when attached to an interactive TTY, plain line logs otherwise. `forceNonInteractive()` (the `--json` / `--no-input` flags) flips this to plain for the rest of the process.

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
- `export { buildPanelPrompt, createFusionKitJudgeSynthesizer, harnessSupportsFiniteK, panelCandidateContract, runFusionPanelWorkflow, runFusionPanels, runUnifiedHarnessE2E, setToolHarnessProvider } from "./unified.js";`
- `export { runPanelRound } from "./panel-round.js";`
- `export type { PanelRoundOptions } from "./panel-round.js";`
- `export { runProposalPanels } from "./panel-propose.js";`
- `export type { ProposalPanelOptions } from "./panel-propose.js";`
- `export type { CursorHarnessRunnerInput, CursorHarnessRunnerResult, FusedSubagentAccess, FusedSubagentEnsemble, FusionPanelOptions, PanelTrust, ToolHarnessProvider, ToolHarnessResolveOptions, UnifiedHarnessE2EOptions, UnifiedHarnessE2EResult, UnifiedHarnessKind, UnifiedHarnessMatrixResult } from "./unified.js";`
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
- `export { cleanupCandidateWorktree, cleanupWorktreePlan, createWorktreePlan, defaultOutputRoot, diffCandidateWorktree, sealCandidateWorktree } from "./worktree.js";`
- `export type { CandidateWorktree, WorktreePlan } from "./worktree.js";`
- `export { deriveSourceRepo } from "./source-repo.js";`
- `export { hardeningToJson, panelMemberPreamble } from "./harness.js";`
- `export type { EnsembleCandidateSummary, EnsembleDescriptor, EnsembleJudge, EnsembleModel, EnsemblePolicy, EnsembleRunResult, EnsembleRuntime, CandidateContainerDriver, CandidateContainerDriverInput, CandidateContainerDriverResult, CandidateHardeningMetadata, CandidateIsolationConfig, CandidateIsolationKind, CandidateIsolationMountPolicy, CandidateIsolationNetworkPolicy, CandidateIsolationSecretPolicy, HarnessAdapter, HarnessArtifact, HarnessCapabilities, HarnessCandidateOutput, HarnessCollectInput, HarnessPrepareInput, HarnessRunInput, HarnessEndReason, HarnessToolRecord, HarnessTrajectory, TrajectoryStep, TrajectoryStepType, ReviewEvidence, EnsembleRunSummary, VerificationProfile } from "./harness.js";`

### `packages/example-utils/src/index.ts`

Example utilities entry point. It exposes demo manifest parsing, mock model helpers, live model helpers, and narration utilities.

No exports found.

### `packages/harness-core/src/index.ts`

@fusionkit/harness-core is the single coding-agent harness contract:
driver -> instance -> session interfaces, the canonical harness event
union (with raw provider envelopes), one tagged error taxonomy with
derived retryability, deferred-based approvals with explicit policies,
status probes with an identity-checked disk cache, and an explicit driver
registry. Drivers (tool-codex, tool-claude, tool-cursor, tool-opencode)
implement this contract; the panel fanout and launchers consume it.

- `export { HARNESS_KINDS, isHarnessKind, toModelFusionHarnessKind } from "./kinds.js";`
- `export type { HarnessKind } from "./kinds.js";`
- `export { HARNESS_ERROR_CODES, HarnessError, asHarnessError, isRetryable, toModelFusionErrorKind } from "./errors.js";`
- `export type { HarnessErrorCategory, HarnessErrorCode } from "./errors.js";`
- `export type { HarnessContentStream, HarnessEvent, HarnessEventRaw, HarnessEventType, HarnessItemType, HarnessRequestType, HarnessTokenUsage, HarnessTurnEndReason } from "./events.js";`
- `export { PANEL_APPROVAL_POLICY, PendingRequests, createDeferred, decideApproval } from "./approvals.js";`
- `export type { ApprovalDecision, ApprovalPolicy, Deferred, PendingRequest } from "./approvals.js";`
- `export { DEFAULT_STATUS_CACHE_DIR, readCachedStatus, statusSkipReason, writeCachedStatus } from "./status.js";`
- `export type { HarnessAuthStatus, HarnessModelDescriptor, HarnessStatus } from "./status.js";`
- `export type { AnyHarnessDriver, DriverContext, HarnessDriver, HarnessInstance, ResumeCursor, SessionHandle, SessionTurnInput, StartSessionOptions } from "./contract.js";`
- `export { DriverRegistry } from "./registry.js";`
- `export { AsyncChannel } from "./channel.js";`
- `export { EventLog } from "./logging.js";`
- `export type { EventLogOptions } from "./logging.js";`
- `export { asArray, asObject, asString, createStreamJsonStepEmitter, parseStreamJsonLine, parseStreamJsonTrajectory, streamJsonResultContentText, stringifyStreamJsonValue, STREAM_JSON_MAX_TEXT, STREAM_JSON_MAX_TOOL_INPUT, truncateStreamJsonText } from "./stream-json.js";`
- `export type { ParsedStreamJson, ParseStreamJsonOptions, StreamJsonEmitterOptions, StreamJsonStepText } from "./stream-json.js";`
- `export { DEFAULT_TMP_MANIFEST, createTrackedTmpDir, releaseTrackedTmpDir, sweepTrackedTmpDirs } from "./tmp-sweep.js";`
- `export { buildChildEnv, freePort, runCliCapture, spawnLogged, terminate, waitForHttp, waitForOutput, withDeadline, withTimeout } from "./process.js";`
- `export type { BuildChildEnvInput, CliCaptureOptions, CliCaptureResult, LoggedChild, LoggedSpawnOptions } from "./process.js";`

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
- `export { joinPath, ModelRoutedBackend, OpenAiBackend, PANEL_DEPTH_HEADER, parsePanelDepth } from "./backend.js";`
- `export type { Backend, BackendRequestOptions, ModelRoutedBackendOptions, OpenAiBackendOptions } from "./backend.js";`
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
- `export type { ChatMessageLike, FusedModelRoute, FuseStepRunInput, FuseStepRunner, FusionBackendKernelSessionState, FusionBackendKernelStateStore, FusionBackendOptions, OnRateLimitPolicy, PanelRunInput, PanelRunner, PassthroughModel, SessionMetaInput } from "./fusion-backend.js";`
- `export type { WireTrajectory } from "@fusionkit/protocol";`
- `export { defaultSessionsDir, FileSystemSessionStore, InMemorySessionStore } from "./session-store.js";`
- `export type { PersistedSession, SessionMeta, SessionStore, SessionSummary, SessionTurnRecord } from "./session-store.js";`
- `export { addTurnCost, DEFAULT_MODEL_PRICING, emptySessionCost, estimateCost, formatUsd, lookupPricing, meterTurn, parseUsage, parseUsageFromSse, turnCostLine } from "./cost.js";`
- `export type { CostLedgerEntry, CostStage, LocalComputePricing, LocalComputeUsage, ModelPricing, ProviderCostMetadata, SessionCost, TokenUsage, TurnCost } from "./cost.js";`
- `export { MlxBackend } from "./mlx-backend.js";`
- `export type { MlxBackendOptions } from "./mlx-backend.js";`
- `export { createBackend, DEFAULT_MLX_MODEL, resolveBackendConfig } from "./config.js";`
- `export type { BackendConfig } from "./config.js";`
- `export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";`
- `export { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";`
- `export { anthropicModelsResponse, anthropicToChat, chatToAnthropicMessage, claudeModelAlias, countTokensEstimate, handleAnthropicMessages, handleCountTokens, mapStopReason, openAiSseToAnthropic } from "./adapters/anthropic.js";`
- `export type { AnthropicRequest } from "./adapters/anthropic.js";`
- `export { chatToResponses, customToolNames, handleResponses, openAiSseToResponses, responsesToChat, responsesToolRegistry } from "./adapters/responses.js";`
- `export type { ResponsesRequest, ResponsesToolKind, ResponsesToolRegistry } from "./adapters/responses.js";`
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
- `export { isFiniteK, isLookaheadK, isProposalK, panelModeForK } from "./panel-k.js";`
- `export type { PanelMode } from "./panel-k.js";`
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
- `export { ATTR, EXPORTABLE_ATTRIBUTES, FUSION_CONVENTIONS_VERSION, FUSION_MARKER_NAMES, FUSION_SCOPES, FUSION_SPAN_NAMES, FUSION_UNIT_SPAN_NAMES } from "./generated/trace-conventions.js";`
- `export type { FusionAttributeKey, FusionMarkerName, FusionSpanName } from "./generated/trace-conventions.js";`
- `export { PolicyDeniedError } from "./types.js";`
- `export type { ActorRef, AgentKind, AgentSpec, ArtifactKind, AttestationTier, BudgetSpec, ChainedEvent, Checkpoint, CheckpointTier, ConsentRule, ContinuationRef, DataClassRule, DisclosureMode, DisclosureRecord, FailureClass, HandoffEnvelope, HandoffSource, HandoffTargetRef, KeyRef, ManifestFile, ModelUsageRecord, NetworkAccessRecord, NetworkPolicy, Policy, Receipt, ReceiptBundle, RetentionPolicy, RunContract, RunEvent, RunnerIdentity, RunnerSelector, RunStatus, SecretClaim, SecretReleaseRecord, SecretScopeRule, SemanticState, SessionIsolation, Signature, TaskSpec, ToolCallRecord, ToolJournal, WorkspaceManifest } from "./types.js";`
- `export type { ClaimResult, DisclosureReport, PolicyDecision, RunnerSummary, RunRequest, RunRequestInput, RunSummary, RunView } from "./api.js";`

### `packages/registry/src/index.ts`

Typed accessors over the generated registry data (spec/registry/*.json).

This package is the Node-side single source of truth for provider metadata
(base URLs, API key env vars, key probes, discovery), subscription auth
metadata (Claude Code / Codex logins), the fusion model identity, the
cloud/local model catalogs, model-family capability quirks, and default
pricing. The Python workspace consumes the same data through
`fusionkit_core._generated.registry_data` — both are generated from the same
JSON by `scripts/generate-registry.mjs`, so the two stacks cannot drift.

Zero runtime dependencies (node builtins only) so any package can depend on
it without cycles.

- `export type ProviderAuthStyle ...`
- `export type ProviderKeyProbe ...`
- `export type ProviderDiscovery ...`
- `export type ProviderInfo ...`
- `export const PROVIDERS: Readonly<Record<string, ProviderInfo>> ...`
  All registered providers, keyed by canonical provider id.
- `export function providerDefaultBaseUrl(provider: string): string | undefined ...`
  Default base URL for a provider, or undefined for local providers (mlx).
- `export function defaultKeyEnv(provider: string): string | undefined ...`
  Default env var holding the API key for a provider, or undefined.
- `export function providerKeyProbe(provider: string): ProviderKeyProbe | undefined ...`
  Cheap key-validation probe metadata for a provider, or undefined.
- `export function providerDiscovery(provider: string): ProviderDiscovery | undefined ...`
  Live model-discovery capability for a provider, or undefined.
- `export type SubscriptionMode ...`
- `export type SubscriptionInfo ...`
- `export const SUBSCRIPTIONS: Readonly<Record<SubscriptionMode, SubscriptionInfo>> ...`
- `export function subscriptionInfo(mode: SubscriptionMode): SubscriptionInfo ...`
  Subscription metadata for an auth mode.
- `export function providerForAuthMode(mode: SubscriptionMode): string ...`
  The provider a subscription auth mode speaks (claude-code -> anthropic, codex -> codex).
- `export const FUSION_PANEL_MODEL: string ...`
  The model label the fused panel is fronted under (gateway + tool pickers).
- `export const DEFAULT_ENSEMBLE_NAME ...`
  The name of the implicit/default ensemble (advertised as {@link FUSION_PANEL_MODEL}).
- `export const FUSION_MODEL_ID_PREFIX ...`
  The id prefix every non-default ensemble's fused model is advertised under.
- `export function fusionModelId(ensemble: string): string ...`
  The advertised model id for a named ensemble: `fusion-<name>`, except the default ensemble which keeps the canonical {@link FUSION_PANEL_MODEL} id (`fusion-panel`) for full back-compat with single-ensemble configs.
- `export const CURSOR_BRIDGE_MODEL_NAME: string ...`
  The model name the Cursor bridge exposes to cursor-agent.
- `export const LOCAL_MODEL_LABEL: string ...`
  Provider/model label a tool advertises for the gateway-backed local model.
- `export const FUSION_MODEL_ALIASES: readonly string[] ...`
  Reserved fusion aliases the Python server's chat front door understands.
- `export const FUSION_DEFAULT_ALIAS: string ...`
  The Python server's default (router) fusion alias.
- `export const FUSION_PANEL_ALIAS: string ...`
  The panel-mode fusion alias external benchmark runners target.
- `export const FUSION_GATEWAY_DEFAULT_BASE_URL: string ...`
  Default local FusionKit gateway base URL used by benchmark runners.
- `export const FUSION_GATEWAY_API_KEY_ENV: string ...`
  Env var external runners can read for a FusionKit gateway API key placeholder.
- `export type CatalogPanelMember ...`
- `export type BenchmarkPanelPreset ...`
- `export const DEFAULT_CLOUD_PANEL_MEMBERS: readonly CatalogPanelMember[] ...`
  The default cloud panel trio (OpenAI + Anthropic + Google).
- `export const BENCHMARK_PANEL_PRESETS: Readonly<Record<string, BenchmarkPanelPreset>> ...`
  Named benchmark/live-smoke panel presets shared by CLI scripts and Python evals.
- `export const DEFAULT_REASONING_MODEL: string ...`
  The default narration-writer model for a bare `--reasoning-model` flag.
- `export function catalogDefaultModel(choice: string): string | undefined ...`
  The default model for an auth choice, or undefined for unknown choices.
- `export function curatedModels(choice: string): readonly string[] ...`
  Curated fallback model list for an auth choice (may be empty).
- `export function smokeModelForTool(tool: string): string | undefined ...`
  Default smoke-test model for a tool id, or undefined.
- `export function samplingOverridesForModel(model: string): Readonly<Record<string, number>> ...`
  Per-model sampling overrides (first matching family wins), e.g. qwen-family models want temperature 0.55 / top_p 1.0. Empty when no family matches.
- `export function chatTemplateKwargsForModel(`
  Chat-template kwargs the local MLX gateway should default for a model family (e.g. Qwen `enable_thinking`), or undefined when no family matches.
- `export type RegistryModelPricing ...`
- `export const PRICING_ALIASES: Readonly<Record<string, string>> ...`
  Explicit dated/variant model id → canonical priced id. Lookup is exact → alias → unknown; prefix matching is never used.
- `export const DEFAULT_MODEL_PRICING: Readonly<Record<string, RegistryModelPricing>> ...`
  Default per-model list prices (USD / 1M tokens), manual overrides merged over the generated table. Consumers resolve via exact id, then {@link PRICING_ALIASES}.
- `export type LocalModelRole ...`
- `export type LocalCatalogModel ...`
- `export const LOCAL_CATALOG_ENTRIES: readonly LocalCatalogModel[] ...`
  The curated local MLX catalog, ordered small -> large.
- `export type PreferredLocalModel ...`
- `export const PREFERRED_LOCAL_MODELS: readonly PreferredLocalModel[] ...`
  Repos `defaultTrioFor` prefers first, in order, with their panel member ids.
- `export const GATEWAY_DEFAULT_MLX_MODEL: string ...`
  The standalone model-gateway MLX fallback model.
- `export const LOCAL_PROBE_MODEL: string ...`
  Throwaway model id used to construct model-agnostic MLX envs.

### `packages/runtime-utils/src/index.ts`

No module JSDoc was found.

- `export const RUNTIME_TIMEOUT_MS ...`
- `export const MANAGED_SERVER_DEFAULTS ...`
- `export const CANDIDATE_ISOLATION_DEFAULTS ...`
- `export function sleep(ms: number): Promise<void> ...`
- `export function randomId(length ...`
  Generate a compact random id (hex, no dashes) with an optional prefix.
- `export function estimateTokens(...texts: string[]): number ...`
  Rough token estimate from text (and optional tool/JSON payload strings): minimum 1 token, ceil(chars / 4).
- `export function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal ...`
- `export function formatDurationMs(ms: number): string ...`
- `export function commandOnPath(`
  True when `command` resolves to an executable: an existing path when it contains a separator, else a match on any `PATH` entry (with Windows `PATHEXT` extensions appended). One implementation shared by every harness and launcher instead of three subtly-different copies.
- `export function captureWorktreeDiff(cwd: string): string | undefined ...`
  The `git diff` of a working tree, or undefined when clean or not a repo.
- `export function ensureRunOutputDir(dir: string): string ...`
  Create a run-output directory. When it lives under a `.fusionkit/` segment (the default output roots inside user repos), drop a self-ignoring `.gitignore` so run artifacts never pollute the user's `git status` — while committed config like `.fusionkit/fusion.json` stays trackable.
- `export function definedEnv(env: EnvInput): Record<string, string> ...`
- `export function trimTrailingSlashes(value: string): string ...`
  Strip trailing "/" characters in linear time (a `/\/+$/` regex backtracks polynomially on adversarial input, which code scanning rightly flags).
- `export function normalizeApiBaseUrl(baseUrl: string): string ...`
- `export type BuildChildEnvInput ...`
- `export function buildChildEnv(input: BuildChildEnvInput ...`
  Build a child environment from an explicit allowlist instead of spreading the entire parent environment: a harness CLI driven headlessly must not inherit every credential the parent process happens to hold. The baseline covers system plumbing (PATH/HOME/locale/TLS/proxy); everything else must be named by the caller.
- `export const DEFAULT_BRIDGE_SCRUB_PREFIXES ...`
- `export function scrubBridgeEnv(`
- `export type CliCaptureOptions ...`
- `export type CliCaptureResult ...`
- `export function runCliCapture(`
  Run a CLI to completion, capturing stdout/stderr, with the lifecycle rigor every harness child needs: the child is spawned in its own process group and timeout/abort kill the whole group with SIGTERM -> SIGKILL escalation, so a CLI that spawns its own subprocesses (codex/claude/cursor all do) cannot leave orphans behind. Rejects only on spawn failure (e.g. ENOENT); every other outcome resolves. Exit codes mirror coreutils conventions: 124 for timeout, 130 for abort.
- `export function spawnTool(`
- `export type LoggedSpawnOptions ...`
- `export type LoggedChild ...`
- `export function spawnLogged(`
- `export function distillLog(raw: string, options: ...`
- `export function waitForOutput(`
- `export function terminate(child: ChildProcess, graceMs ...`
- `export function escapeMarkdownCell(value: string): string ...`
- `export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] ...`

### `packages/tool-claude/src/index.ts`

Claude Code tool integration entry point. It exposes launcher environment helpers and the Claude Code ensemble harness adapter.

- `export const claudeTool: ToolIntegration ...`
- `export { claudeCodeHarness, claudeCodeHarnessCredentialSkipReason, createClaudeCodeHarness } from "./harness.js";`
- `export type { ClaudeCodeHarnessEnv, ClaudeCodeHarnessOptions } from "./harness.js";`
- `export { claudeAgentsJson, claudeEnv, claudeLaunchArgs, launchClaude } from "./launch.js";`
- `export { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";`
- `export type { ClaudeDriverConfig } from "./driver.js";`

### `packages/tool-codex/src/index.ts`

Codex tool integration entry point. It exposes the Codex launcher and ensemble harness adapter used by the FusionKit CLI.

- `export const codexTool: ToolIntegration ...`
- `export { codexConfigToml, codexEndReason, codexHarness, codexHarnessCredentialSkipReason, codexMemberCatalogJson, createCodexHarness, defaultCodexRunner, memberChatBackend } from "./harness.js";`
- `export type { CodexAmbientProvider, CodexApprovalPolicy, CodexConfigTomlInput, CodexExecInput, CodexExecResult, CodexExecRunner, CodexHarnessEnv, CodexHarnessOptions, CodexOpenAiCompatibleProvider, CodexProvider, CodexResponsesProvider, CodexSandboxMode } from "./harness.js";`
- `export { codexAgentRoles, codexAgentRoleToml, codexLaunchConfigToml, codexModelCatalogJson, codexRoleDescription, launchCodex, readCodexCatalogTemplate } from "./launch.js";`
- `export type { CodexAgentRole } from "./launch.js";`
- `export { codexDriverConfigSchema, createCodexDriver } from "./driver.js";`
- `export type { CodexDriverConfig } from "./driver.js";`

### `packages/tool-cursor/src/index.ts`

Cursor tool integration entry point. It exposes Cursor launcher helpers, the Cursorkit bridge, and the Cursor ensemble harness adapter.

- `export const cursorTool: ToolIntegration ...`
- `export { createCursorHarness, cursorHarness, cursorHarnessUnavailableReason, defaultCursorRunner } from "./harness.js";`
- `export type { CursorExecInput, CursorExecResult, CursorExecRunner, CursorHarnessOptions, CursorRunMode } from "./harness.js";`
- `export { buildCursorAcpProducer } from "./acp.js";`
- `export { startCursorBridge } from "./bridge.js";`
- `export { CURSOR_AGENT_TOOL_MAX_ITERATIONS, CURSOR_AGENT_TOOL_POLICY, cursorBridgeEnv, cursorBridgeModelEnv, cursorIdeEnv, cursorIdeModelsJson } from "./bridge-config.js";`
- `export { cursorIdeInstructions, cursorInstructions, launchCursor } from "./launch.js";`
- `export { CURSOR_AGENTS_DIRNAME, cursorSubagentMarkdown, scaffoldCursorSubagents } from "./subagents.js";`
- `export { createCursorDriver, cursorDriverConfigSchema } from "./driver.js";`
- `export type { CursorDriverConfig } from "./driver.js";`

### `packages/tool-opencode/src/index.ts`

opencode tool integration entry point. It exposes launcher configuration helpers for local-model and gateway-backed opencode sessions.

- `export const opencodeTool: ToolIntegration ...`
- `export { launchOpencode, opencodeConfig, opencodeModelArg } from "./launch.js";`
- `export { createOpencodeDriver, opencodeDriverConfigSchema } from "./driver.js";`
- `export type { OpencodeBackend, OpencodeBackendFactory, OpencodeDriverConfig, OpencodeDriverOptions, OpencodeTurnPart, OpencodeTurnResult } from "./driver.js";`

### `packages/tools/src/index.ts`

Tool integration entry point. It exposes the launcher and harness integration contract, registry helpers, process helpers, constants, environment compatibility helpers, and skipped-candidate utilities.

- `export { captureWorktreeDiff, commandOnPath, distillLog, formatDurationMs, freePort, runCliCapture, sleep, spawnLogged, spawnTool, terminate, waitForHttp, waitForOutput, withDeadline, withTimeout } from "./proc.js";`
- `export type { CliCaptureOptions, CliCaptureResult, LoggedChild, LoggedSpawnOptions } from "./proc.js";`
- `export { CANDIDATE_ISOLATION_DEFAULTS, escapeMarkdownCell, markdownTable, RUNTIME_TIMEOUT_MS, trimTrailingSlashes } from "@fusionkit/runtime-utils";`
- `export type { FusedEnsembleInfo, ToolDashboardLiveSmoke, ToolDashboardMetadata, ToolDashboardSmoke, ToolHarnessMetadata, ToolIntegration, ToolLaunchContext, ToolLaunchMode } from "./types.js";`
- `export { createToolRegistry } from "./registry.js";`
- `export type { ToolRegistry } from "./registry.js";`
- `export { CURSOR_BRIDGE_MODEL_NAME, DEFAULT_ENSEMBLE_NAME, FUSION_PANEL_MODEL, fusionModelId, LOCAL_MODEL_LABEL } from "./constants.js";`
- `export { envFlagEnabled, HARNESS_DRIVERS_FLAG, harnessDriversEnabled, readEnv } from "./env-compat.js";`
- `export { buildChildEnv, DEFAULT_BRIDGE_SCRUB_PREFIXES, definedEnv, normalizeApiBaseUrl, scrubBridgeEnv } from "./env.js";`
- `export type { BuildChildEnvInput } from "./env.js";`
- `export { buildSkippedCandidate } from "./candidate.js";`
- `export { deriveFusedSubagents, fusedSubagentDescription, fusedSubagentDeveloperInstructions, fusedSubagentMembers } from "./fused-subagents.js";`
- `export type { FusedSubagentDefinition, FusedSubagentDescriptionStyle } from "./fused-subagents.js";`

### `packages/tracing/src/index.ts`

@fusionkit/tracing — OpenTelemetry-based tracing for the fusion stack.

The engine is the OTel SDK (ids, W3C propagation, batching, flush, OTLP
export); this package owns the thin domain layer: typed span helpers over
the fusion semantic conventions (spec/fusion-trace/registry.json), the
serializable trace carrier that threads context through values, HTTP
headers, and child environments, and the in-process span listener the
narrator and product telemetry subscribe to.

- `export { flushFusionTracing, fusionTracingServiceName, initFusionTracing, isFusionTracingActive, isTraceExportConfigured, resetFusionTracingForTest, shutdownFusionTracing } from "./provider.js";`
- `export type { InitFusionTracingOptions } from "./provider.js";`
- `export { addSpanListener, hasSpanListeners, listenerSpanProcessor, removeSpanListener } from "./listener.js";`
- `export type { SpanListener } from "./listener.js";`
- `export { appendSpanListAttribute, carrierFromEnv, carrierFromHeaders, carrierOf, contextOf, emitFusionMarker, envOf, fusionBaggageOf, headersOf, jsonAttr, newSessionCarrier, newSpanId, newTraceId, sessionCarrier, startFusionSpan, traceIdOf, withFusionBaggage } from "./spans.js";`
- `export type { FusionAttributes, FusionBaggage, FusionScope, FusionSpan, FusionTraceCarrier } from "./spans.js";`
- `export { AllowlistSpanExporter, isLoopbackOtlpEndpoint, toExportable, TRACE_REDACTED_ATTRIBUTE } from "./exportable.js";`
- `export type { AllowlistSpanExporterOptions } from "./exportable.js";`
- `export { attrBool, attrJson, attrNum, attrStr, spanEndMs, spanId, spanTraceId } from "./readable.js";`
- `export type { ReadableSpan } from "./readable.js";`
- `export { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";`
- `export type { SpanProcessor } from "@opentelemetry/sdk-trace-base";`
- `export { ATTR, EXPORTABLE_ATTRIBUTES, FUSION_CONVENTIONS_VERSION, FUSION_MARKER_NAMES, FUSION_SCOPES, FUSION_SPAN_NAMES, FUSION_UNIT_SPAN_NAMES } from "@fusionkit/protocol";`
- `export type { FusionAttributeKey, FusionMarkerName, FusionSpanName } from "@fusionkit/protocol";`

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

- `ATTR`
- `AgentTrajectoryProducer`
- `AnthropicModelClient`
- `ArtifactRefV1`
- `BenchmarkTaskRecordV1`
- `ChatMessage`
- `ChatTrajectoryProducer`
- `CodexResponsesClient`
- `ContextBudget`
- `ContextPolicy`
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
- `PackReport`
- `PanelMode`
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
- `TraceContext`
- `Trajectory`
- `TrajectoryInspection`
- `TrajectoryPack`
- `TrajectoryProducer`
- `TrajectoryV1`
- `Usage`
- `build_client`
- `build_clients`
- `canonical_json`
- `classify_provider_error`
- `context_from_headers`
- `contract_metadata`
- `contract_model_for_schema`
- `emit_marker`
- `endpoint_to_contract`
- `estimate_cost`
- `estimate_messages_tokens`
- `estimate_tokens`
- `fusion_span`
- `hash_bytes`
- `hash_json`
- `hash_text`
- `json_attr`
- `judge_synthesizer_for`
- `load_claude_code_credentials`
- `load_codex_credentials`
- `make_id`
- `normalize_usage`
- `pack_trajectories`
- `producer`
- `producer_git_sha`
- `producer_version`
- `provider_metadata`
- `resolve_api_key`
- `resolve_credential`
- `schema_bundle_hash`
- `setup_fusion_tracing`
- `shutdown_fusion_tracing`
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

