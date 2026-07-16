# Generated code API reference

This file is generated from source comments by `pnpm docs:generate-code`. Do not edit it by hand. Update JSDoc or Python docstrings in the source files, then regenerate this file.

The generated reference intentionally covers package entry points and Python public package modules. It is the bridge between code annotations and maintained prose documentation.

## TypeScript package entry points

### `packages/accounts/src/index.ts`

`@routekit/accounts` — the subscription pooling SDK.

A cohesive, typed surface for pooling Claude Code and Codex OAuth
subscriptions behind one provider-native proxy: resolve an account set from
the official CLI login / an enrolled directory / explicit paths, select and
refresh members with quota-aware routing, and expose it over the gateway wire
protocols. `startSubscriptionProxy` is the one-call programmatic entrypoint;
`SubscriptionProxyClient` reads a running proxy's usage over a typed wire
contract. Product CLIs can wrap this module without owning account logic.

- `export { defaultSubscriptionAccountDirectory, defaultSubscriptionCredentialPath, enrollCurrentSubscription, loadSubscriptionCredential, persistSubscriptionCredential, removeSubscriptionAccount, sanitizeSubscriptionLabel, subscriptionCredentialLabel } from "./credentials.js";`
- `export type { RemoveSubscriptionAccountResult } from "./credentials.js";`
- `export { resolveSubscriptionAccounts } from "./account-source.js";`
- `export type { ResolvedSubscriptionAccounts, SubscriptionAccountSource } from "./account-source.js";`
- `export { subscriptionProvider } from "./provider.js";`
- `export type { AdminUsageCost, AdminUsageRange, SubscriptionProvider } from "./provider.js";`
- `export { RateLimitTracker, SubscriptionAccountSet, SubscriptionAccountSetExhaustedError } from "./account-set.js";`
- `export type { SubscriptionAccountSetOptions } from "./account-set.js";`
- `export { SubscriptionAccountBackend } from "./backend.js";`
- `export type { SubscriptionAccountBackendOptions } from "./backend.js";`
- `export { CodexBackendRelay, codexRelayAuth } from "./codex-relay.js";`
- `export type { CodexCatalogEntry, CodexRelayAuth, CodexRelayAuthSource, CodexRelayOptions, ProviderRelayLogger, CodexStockEntry } from "./codex-relay.js";`
- `export { AnthropicBackendRelay, forwardRelayHeaders, RelayOnlyBackend } from "./relay.js";`
- `export type { AnthropicRelayOptions, SubscriptionRelay, SubscriptionRelayDialect } from "./relay.js";`
- `export { openSubscriptionAccountSets, openSubscriptionRelays, subscriptionRelaysFromAccountSets } from "./gateway.js";`
- `export type { OpenSubscriptionRelaysOptions, OpenSubscriptionRelaysResult, SubscriptionAccountConfigs, SubscriptionAccountSets } from "./gateway.js";`
- `export { NoSubscriptionAccountsError, startSubscriptionProxy } from "./proxy.js";`
- `export type { StartSubscriptionProxyOptions, SubscriptionProxy } from "./proxy.js";`
- `export { SubscriptionProxyClient, SubscriptionProxyClientError } from "./client.js";`
- `export type { SubscriptionProxyClientOptions } from "./client.js";`
- `export { CLIPROXY_API_KEY_ENV, CLIPROXY_BASE_URL_ENV, CLIPROXY_HOME_ENV, CLIPROXY_LOGIN_FLAGS, CLIPROXY_PINNED_VERSION, cliproxyAssetName, cliproxyApiKey, cliproxyBaseUrl, cliproxyBinaryPath, cliproxyConfigPath, cliproxyHome, cliproxyStatus, ensureCliproxyConfig, installCliproxy, runCliproxyLogin, spawnCliproxy } from "./cliproxy.js";`
- `export type { CliproxyInstallResult, CliproxyStatus } from "./cliproxy.js";`
- `export { snapshotsToUsage, SUBSCRIPTION_USAGE_PATH, subscriptionUsageResponseSchema } from "./wire.js";`
- `export type { SubscriptionUsageResponse } from "./wire.js";`
- `export type { AccountLimits, CreditSnapshot, RateLimitWindow, SubscriptionAccountSetSnapshot, SubscriptionCredential, SubscriptionFailure, SubscriptionMemberStatus, SubscriptionSelectionStrategy } from "./types.js";`

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

### `packages/cli-core/src/index.ts`

No module JSDoc was found.

- `export { attachGlobalFlags, contextFor, emitJson, isJsonMode, resetContextForTest } from "./context.js";`
- `export type { CommandContext, GlobalFlags } from "./context.js";`
- `export { CliError, cliErrorPayload, fail, renderCliError } from "./errors.js";`
- `export type { CliErrorInput } from "./errors.js";`
- `export { findFlagTypos, knownLongFlags, levenshtein, warnPassthroughTypos } from "./flags.js";`
- `export { argOrPick, canPickInteractively } from "./pickers.js";`
- `export { collect, parseIdValue, parsePort, parsePositiveInteger, parsePositiveNumber } from "./options.js";`
- `export { COMPLETION_SHELLS, completionCandidates, completionScript, filterCompletionCandidates, isCompletionShell, registerCompletion, visibleCommandNames, visibleLongFlags, walkCompletionTree } from "./completion.js";`
- `export type { CompletionShell, CompletionValueProvider, CompletionWalk } from "./completion.js";`
- `export { formatPackageVersion, probeBinaryVersion, readPackageVersion } from "./version.js";`

### `packages/cli-ui/src/index.ts`

@routekit/cli-ui — a brand-configurable terminal UX layer.

One presenter contract, two implementations: rich Ink (React) rendering on
interactive TTYs, ordered plain-text lines everywhere else (CI, pipes,
`ROUTEKIT_NO_TUI=1`). All UI goes to stderr; stdout stays reserved for
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

### `packages/config-core/src/index.ts`

No module JSDoc was found.

- `export type ConfigSource ...`
- `export type LayeredValue<T> ...`
- `export function resolveLayer<T>(`
- `export function isRecord(value: unknown): value is Record<string, unknown> ...`
- `export function readJson(path: string): unknown ...`
- `export function readValidatedJson<T>(`
- `export function writeJsonAtomic(`
- `export function loadMigratingConfig<T>(input: ...`
- `export function editConfig<T, U ...`

### `packages/contracts/src/index.ts`

No module JSDoc was found.

- `export { canonicalize } from "./jcs.js";`
- `export type { JsonValue } from "./jcs.js";`
- `export { SHA256_PREFIX, artifactHash, hashCanonical, hashCanonicalSha256, requestHash, responseHash, schemaBundleHash, sha256Hex, sha256PrefixedHex } from "./hash.js";`
- `export type { CapabilityStatus, ModelCallContract, ModelCallSideEffects, ModelCallStatus, ModelChatMessage, ModelChatRole, ModelEndpoint, ModelUsage, ProviderError, ProviderErrorKind, ProviderFailure, ProviderFailureCategory } from "./model.js";`
- `export { ProviderFailureError, classifyProviderFailure, isRetryableProviderFailure, parseRetryAfterSeconds } from "./model.js";`
- `export type { HarnessApprovalDecision, HarnessContentStream, HarnessEvent, HarnessEventRaw, HarnessEventType, HarnessItemType, HarnessRequestType, HarnessTokenUsage, HarnessTurnEndReason } from "./harness-event.js";`

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

### `packages/harness-core/src/index.ts`

@routekit/harness-core is the single coding-agent harness contract:
driver -> instance -> session interfaces, the canonical harness event
union (with raw provider envelopes), one tagged error taxonomy with
derived retryability, deferred-based approvals with explicit policies,
status probes with an identity-checked disk cache, and an explicit driver
registry. Drivers (tool-codex, tool-claude, tool-cursor, tool-opencode)
implement this contract; orchestrators and launchers consume it.

- `export { HARNESS_KINDS, isHarnessKind } from "./kinds.js";`
- `export type { HarnessKind } from "./kinds.js";`
- `export { HARNESS_ERROR_CODES, HarnessError, asHarnessError, isRetryable } from "./errors.js";`
- `export type { HarnessErrorCategory, HarnessErrorCode } from "./errors.js";`
- `export type { HarnessContentStream, HarnessEvent, HarnessEventRaw, HarnessEventType, HarnessItemType, HarnessRequestType, HarnessTokenUsage, HarnessTurnEndReason } from "./events.js";`
- `export { DEFAULT_AUTOMATION_APPROVAL_POLICY, PendingRequests, createDeferred, decideApproval } from "./approvals.js";`
- `export type { ApprovalDecision, ApprovalPolicy, Deferred, PendingRequest } from "./approvals.js";`
- `export { DEFAULT_STATUS_CACHE_DIR, readCachedStatus, statusSkipReason, writeCachedStatus } from "./status.js";`
- `export type { HarnessAuthStatus, HarnessModelDescriptor, HarnessStatus } from "./status.js";`
- `export type { AnyHarnessDriver, DriverContext, HarnessDriver, HarnessInstance, ResumeCursor, SessionHandle, SessionTurnInput, StartSessionOptions } from "./contract.js";`
- `export { DriverRegistry } from "./registry.js";`
- `export { createCachedHarnessDriver, probeCliVersion, resolveDriverEnv } from "./driver-factory.js";`
- `export type { CachedHarnessDriverInput, CliVersionProbeInput } from "./driver-factory.js";`
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

Product-neutral RouteKit gateway and router.

- `export { startGateway } from "./server.js";`
- `export type { Gateway, GatewayOptions, ProviderRelay, ProviderRelayDialect } from "./server.js";`
- `export { joinPath, ModelRoutedBackend, OpenAiBackend } from "./backend.js";`
- `export type { Backend, BackendRequestOptions, ModelRoutedBackendOptions, OpenAiBackendOptions } from "./backend.js";`
- `export { AnthropicBackend, CodexResponsesBackend, GoogleGenAiBackend } from "./provider-backends.js";`
- `export type { ProviderBackendOptions, ProviderTransport } from "./provider-backends.js";`
- `export { CatalogBackend, EndpointPool, isAccountEndpointConfig, modelEndpointSchema, normalizeRouterConfigAliases, parseRouterConfig, providerBackend, routerConfigSchema, UnknownEndpointError } from "./router.js";`
- `export type { AccountEndpointConfig, CatalogBackendOptions, EndpointPoolOptions, ModelEndpointConfig, RouterConfig, UrlEndpointConfig } from "./router.js";`
- `export { endpointHealthProbe, probeEndpointHealth, providerAuthHeaders } from "./endpoint-health.js";`
- `export type { EndpointHealthProbe, EndpointHealthProbePlan, EndpointHealthResult } from "./endpoint-health.js";`
- `export { CapacityPool } from "./capacity-pool.js";`
- `export type { CapacityLease, CapacityPoolMember, CapacityPoolOptions, CapacityPoolStrategy } from "./capacity-pool.js";`
- `export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";`
- `export { isCursorChatBody, translateCursorRequest } from "./adapters/cursor.js";`
- `export { anthropicModelsResponse, anthropicToChat, CLAUDE_ALIAS_PREFIX, chatToAnthropicMessage, claudeModelAlias, countTokensEstimate, handleAnthropicMessages, handleCountTokens, mapStopReason, openAiSseToAnthropic } from "./adapters/anthropic.js";`
- `export type { AnthropicRequest } from "./adapters/anthropic.js";`
- `export { chatToResponses, customToolNames, handleResponses, openAiSseToResponses, responsesToChat, responsesToolRegistry } from "./adapters/responses.js";`
- `export type { ResponsesRequest, ResponsesToolKind, ResponsesToolRegistry } from "./adapters/responses.js";`
- `export { MAX_WEB_SEARCHES_PER_TURN, resolveWebSearchExecutor } from "./adapters/web-search.js";`
- `export type { WebSearchDialect, WebSearchExecutor, WebSearchOutcome } from "./adapters/web-search.js";`
- `export { DIALECT_DROPPED_ATTRIBUTE, droppedField, resetDroppedFieldWarnings, withDroppedFieldSpan } from "./adapters/dropped.js";`
- `export type { DialectName, DroppedFieldSpan } from "./adapters/dropped.js";`
- `export { ACP_PROTOCOL_VERSION, runAcpAgent } from "./acp-agent.js";`
- `export type { AcpAgentOptions, AcpRunner, AcpRunnerInput, AcpRunnerResult } from "./acp-agent.js";`
- `export { ACP_REGISTRY_URL, fetchAcpRegistry, installAcpAdapters } from "./acp-registry.js";`
- `export type { AcpRegistry, AcpRegistryAgent, AcpRegistryFetcher, InstallAcpAdaptersOptions, InstalledAcpAdapter } from "./acp-registry.js";`
- `export { DEFAULT_MODEL_PRICING, estimateCost, formatUsd, lookupPricing, meterCall, parseUsage, parseUsageFromSse } from "./cost.js";`
- `export type { CallCostRecord, ModelPricing, ProviderCostMetadata, TokenUsage } from "./cost.js";`
- `export { buildModelCallRecord, MODEL_CALL_ID_HEADER, modelCallId, readProducerVersion, resolveProducerGitSha, responseBodyHash, UNKNOWN_GIT_SHA } from "./provenance.js";`
- `export type { GatewayDialect, ModelCallRecord, ModelGatewayCallContext, ModelGatewayCallResult, ProvenanceSink } from "./provenance.js";`
- `export { authorizedRequest } from "./auth.js";`
- `export { errorEvent, finishChunk, noticeChunk, reasoningChunk, sseResponse } from "./sse-wire.js";`
- `export { ChatStreamAssembler } from "./sse/chat-assembler.js";`
- `export type { AssembledToolCall } from "./sse/chat-assembler.js";`
- `export { decodeBufferedSse, SseDecoder, SseParseError } from "./sse/parse.js";`

### `packages/protocol/src/index.ts`

@fusionkit/protocol is the open, versioned data contract layer.

It exports FusionKit wire/panel/model-fusion schemas and generated clients.
The signed-run governance contracts below are unrelated legacy Warrant
surface retained here for compatibility during this phase; they are
intentionally guarded as FusionKit protocol, not RouteKit contracts.
Generic hashing/JCS and model-call primitives come from @routekit/contracts.

Everything here is stable protocol surface. Packages should consume these
interfaces instead of recreating local string lists or proof logic.

- `export { ACTOR_KINDS, AGENT_KINDS, CHECKPOINT_TIERS, DISCLOSURE_MODES, HEX_HASH_PATTERN, isAgentKind, isTerminalStatus, MODEL_FUSION_SCHEMA_NAMES, PROTOCOL_VERSIONS, RUN_EVENT_TYPES, RUN_STATUSES, SESSION_ISOLATIONS, TERMINAL_RUN_STATUSES } from "./constants.js";`
- `export { parseHostAllowlistEntry, parsePoolName, parseSecretName, parseWorkspaceManifestPath } from "./validators.js";`
- `export { defaultExecutionSpec, executionFromRunRequest } from "./execution.js";`
- `export type { ExecutionEnv, ExecutionLogPolicy, ExecutionSpec } from "./execution.js";`
- `export { evaluateToolPolicy, modelFusionSideEffects, toolArgumentsHash, toolCallKey, toolSideEffectClassFromModelFusion } from "./tool-executor.js";`
- `export type { ToolDefinition, ToolExecutionRequest, ToolExecutionResult, ToolExecutorBudget, ToolExecutorContract, ToolExecutorLimits, ToolExecutorMode, ToolPolicyDecision, ToolSideEffectClass } from "./tool-executor.js";`
- `export { canonicalize } from "@routekit/contracts";`
- `export type { JsonValue } from "@routekit/contracts";`
- `export { assertWireTrajectory, isWireTrajectory, normalizeWireTrajectories } from "./fusion-wire.js";`
- `export type { WireTrajectory } from "./fusion-wire.js";`
- `export { isFiniteK, isLookaheadK, isProposalK, panelModeForK } from "./panel-k.js";`
- `export type { PanelMode } from "./panel-k.js";`
- `export { artifactHash, hashCanonical, hashCanonicalSha256, requestHash, responseHash, schemaBundleHash, SHA256_PREFIX, sha256Hex, sha256PrefixedHex } from "@routekit/contracts";`
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
local model metadata lives in @routekit/registry.

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

### `packages/routekit-cli/src/index.ts`

Executable entrypoint for the independent RouteKit router CLI.

No exports found.

### `packages/routekit-config/src/index.ts`

No module JSDoc was found.

- `export type RouterConfigSource ...`
- `export type LoadedRouterConfig ...`
- `export type RouterConfigPaths ...`
- `export type UpdateRouterConfigInput ...`
- `export function configuredEndpointIds(config: RouterConfig): string[] ...`
  Unique configured endpoint ids in declaration order.
- `export function missingEndpointIds(`
  Required endpoint ids absent from the configured/advertised set.
- `export function assertEndpointIdsConfigured(`
  Reject when any required endpoint id is absent.
- `export function resolveEndpointId(config: RouterConfig, requested?: string): string ...`
  Resolve an explicit endpoint, or the configured default/first endpoint.
- `export const selectEndpointId ...`
  Alias retained for callers that describe endpoint resolution as selection.
- `export function routekitHome(env: NodeJS.ProcessEnv ...`
- `export function globalRouterConfigPath(home: string ...`
- `export function projectRouterConfigPath(cwd: string ...`
- `export function findProjectRouterConfig(cwd: string ...`
- `export function routerConfigPaths(`
- `export function loadRouterConfig(`
- `export function writeRouterConfig(path: string, config: RouterConfig | unknown): string ...`
- `export function updateEffectiveRouterConfig(`
  Mutate only the selected raw config layer while validating the merged result.  This keeps project overlays sparse instead of materializing defaults or inherited global values into the project file.
- `export function updateRouterConfig(`
- `export const DEFAULT_ROUTER_CONFIG: RouterConfig ...`

### `packages/routekit-registry/src/index.ts`

Typed accessors over RouteKit's generated neutral registry data.

Provider/auth metadata, model catalogs, capabilities, pricing, and local
model data are generated from spec/registry. Product-specific identities and
panel presets are deliberately excluded.

- `export type ProviderAuthStyle ...`
- `export type ProviderKeyProbe ...`
- `export type ProviderDiscovery ...`
- `export type ProviderInfo ...`
- `export const PROVIDERS: Readonly<Record<string, ProviderInfo>> ...`
- `export function providerDefaultBaseUrl(provider: string): string | undefined ...`
- `export function defaultKeyEnv(provider: string): string | undefined ...`
- `export function providerKeyProbe(provider: string): ProviderKeyProbe | undefined ...`
- `export function providerDiscovery(provider: string): ProviderDiscovery | undefined ...`
- `export type SubscriptionMode ...`
- `export type SubscriptionOAuthInfo ...`
- `export type SubscriptionRateLimitInfo ...`
- `export type SubscriptionAdminInfo ...`
- `export type SubscriptionInfo ...`
- `export const SUBSCRIPTIONS: Readonly<Record<SubscriptionMode, SubscriptionInfo>> ...`
- `export function subscriptionInfo(mode: SubscriptionMode): SubscriptionInfo ...`
- `export function providerForAuthMode(mode: SubscriptionMode): string ...`
- `export const DEFAULT_REASONING_MODEL: string ...`
- `export function catalogDefaultModel(choice: string): string | undefined ...`
- `export function curatedModels(choice: string): readonly string[] ...`
- `export function smokeModelForTool(tool: string): string | undefined ...`
- `export function samplingOverridesForModel(model: string): Readonly<Record<string, number>> ...`
- `export function chatTemplateKwargsForModel(`
- `export type RegistryModelPricing ...`
- `export const PRICING_ALIASES: Readonly<Record<string, string>> ...`
- `export const DEFAULT_MODEL_PRICING: Readonly<Record<string, RegistryModelPricing>> ...`
- `export type LocalModelRole ...`
- `export type LocalCatalogModel ...`
- `export const LOCAL_CATALOG_ENTRIES: readonly LocalCatalogModel[] ...`
- `export type PreferredLocalModel ...`
- `export const PREFERRED_LOCAL_MODELS: readonly PreferredLocalModel[] ...`
- `export const GATEWAY_DEFAULT_MLX_MODEL: string ...`
- `export const LOCAL_PROBE_MODEL: string ...`

### `packages/routekit-router/src/index.ts`

No module JSDoc was found.

- `export type StartRouterOptions ...`
- `export type RunningRouter ...`

### `packages/routekit-tracing/src/index.ts`

No module JSDoc was found.

- `export { baggageOf, carrierFromEnv, carrierFromHeaders, carrierOf, contextOf, envOf, headersOf, newSessionCarrier, newSpanId, newTraceId, sessionCarrier, traceIdOf, withBaggage } from "./carrier.js";`
- `export type { TraceCarrier } from "./carrier.js";`
- `export { addEventListener, addSpanListener, hasEventListeners, hasSpanListeners, listenerLogRecordProcessor, listenerSpanProcessor, removeEventListener, removeSpanListener } from "./listener.js";`
- `export type { EventListener, SpanListener } from "./listener.js";`
- `export { attrBool, attrJson, attrNum, attrStr, eventNameOf, eventSpanId, eventTimeMs, eventTraceId, spanEndMs, spanId, spanTraceId } from "./readable.js";`
- `export type { AttributeSource, ReadableEvent, ReadableSpan } from "./readable.js";`
- `export { isLoopbackOtlpEndpoint, PolicyLogExporter, PolicySpanExporter, toExportableEvent, toExportableSpan } from "./exportable.js";`
- `export type { AttributePolicy } from "./exportable.js";`
- `export { flushTracing, initTracing, isEventExportConfigured, isTraceExportConfigured, isTracingActive, resetTracingForTest, shutdownTracing, tracingServiceName } from "./provider.js";`
- `export type { InitTracingOptions } from "./provider.js";`
- `export { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";`
- `export type { SpanProcessor } from "@opentelemetry/sdk-trace-base";`
- `export { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";`
- `export type { LogRecordProcessor } from "@opentelemetry/sdk-logs";`

### `packages/runtime-utils/src/index.ts`

No module JSDoc was found.

- `export { registerCleanup, runCleanups } from "./cleanup.js";`
- `export { buildChildEnv, commandOnPath, DEFAULT_BRIDGE_SCRUB_PREFIXES, definedEnv, scrubBridgeEnv } from "./environment.js";`
- `export type { BuildChildEnvInput } from "./environment.js";`
- `export { superviseSpawn, terminateGroup } from "./process.js";`
- `export type { ExitInfo, Spawned, SuperviseSpawnOptions } from "./process.js";`
- `export { createActivePortlessSession, createPortlessSession, detectPortlessProxy, reapPortlessProject, reapPortlessService } from "./portless.js";`
- `export type { DetectedProxy, DiscoverOrSpawnInput, DiscoverOrSpawnResult, PortlessModule, PortlessOptions, PortlessSession, RouteMapping, RouteStoreLike, SpawnedService } from "./portless.js";`
- `export { assertAuthenticatedBind, isLoopbackHost, normalizeApiBaseUrl, trimSurroundingSlashes, trimTrailingSlashes } from "./url.js";`
- `export const DEFAULT_RUNTIME_TIMEOUTS ...`
- `export function defineTimeouts<const T extends Record<string, number>>(timeouts: T): Readonly<T> ...`
  Build a named timeout map in the product package that owns those names.
- `export const MANAGED_SERVER_DEFAULTS ...`
- `export const CANDIDATE_ISOLATION_DEFAULTS ...`
- `export function sleep(ms: number): Promise<void> ...`
- `export function randomId(length ...`
  Generate a compact random id (hex, no dashes) with an optional prefix.
- `export function estimateTokens(...texts: string[]): number ...`
  Rough token estimate from text (and optional tool/JSON payload strings): minimum 1 token, ceil(chars / 4).
- `export function withDeadline(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal ...`
- `export function formatDurationMs(ms: number): string ...`
- `export function captureWorktreeDiff(cwd: string): string | undefined ...`
  The `git diff` of a working tree, or undefined when clean or not a repo.
- `export function ensureRunOutputDir(`
  Create an output directory. When it lives under one of the caller-owned data-directory segments, drop a self-ignoring `.gitignore` so generated artifacts never pollute the user's working tree.
- `export function writeFileAtomic(`
  Atomically replace a UTF-8 file by writing a sibling temporary first.
- `export type FileLock ...`
- `export function tryAcquireFileLock(path: string): FileLock | undefined ...`
  Acquire an exclusive lock file. Creation is atomic; callers own retry policy and must release the returned handle.
- `export type ReservedPort ...`
  A held ephemeral port: the loopback listener stays open (so nothing else can grab the port) until the caller `release()`s it — ideally immediately before spawning the process that will bind it, which closes the classic probe-then-close race where a returned port is stolen in the gap. The `server` is exposed so a Node-side caller can adopt the already-bound listener instead of releasing and re-binding.
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
  SIGTERM -> SIGKILL a child's whole process group. Thin wrapper over {@link terminateGroup} (the shared supervisor primitive) kept for the many existing `terminate(child)` call sites.
- `export function escapeMarkdownCell(value: string): string ...`
- `export function markdownTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] ...`

### `packages/telemetry-core/src/index.ts`

No module JSDoc was found.

- `export type ConsentFile ...`
- `export type ConsentDecision ...`
- `export type ConsentOptions ...`
- `export const CLI_COMMAND_TELEMETRY_FIELDS ...`
  Fields shared by every CLI's anonymous command event.
- `export type TelemetryFieldMap ...`
- `export function telemetryStatusMetadata(`
  Shared machine-readable consent status. Products may add operational fields and render this metadata differently, but consent semantics stay identical.
- `export function createConsentManager(options: ConsentOptions) ...`
- `export function durationBucket(ms: number): string ...`
- `export function allowlistedProperties(`
- `export function anonymousEventProperties(`

### `packages/testkit/src/index.ts`

@fusionkit/testkit — cross-stack test tooling (never published).

Composable layers for realistic end-to-end tests (see docs/testing.md):

- {@link startProviderSim}: the scriptable provider simulator
  (python/fusionkit-testkit) as a child process, driven over its HTTP
  control plane and observed through its wire journal.
- {@link simSidecarConfigYaml}: production-shaped sidecar config over opaque
  simulator endpoint IDs.
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
- `export type { SimEndpointSpec } from "./router-config.js";`
- `export { judgeAnalysis, scriptFusedTurn } from "./scenarios.js";`
- `export type { FusedTurnScript } from "./scenarios.js";`
- `export { parseSse, sseDone, sseReasoning, sseText } from "./sse.js";`
- `export type { SseFrame } from "./sse.js";`

### `packages/tool-claude/src/index.ts`

No module JSDoc was found.

- `export const claudeTool: ToolIntegration ...`
- `export { claudeDriverConfigSchema, createClaudeDriver } from "./driver.js";`
- `export type { ClaudeDriverConfig, ClaudeDriverOptions, ClaudeQueryFn } from "./driver.js";`
- `export { claudeAgentsJson, claudeEnv, claudeLaunchArgs, launchClaude } from "./launch.js";`

### `packages/tool-codex/src/index.ts`

No module JSDoc was found.

- `export const codexTool: ToolIntegration ...`
- `export { codexDriverConfigSchema, createCodexDriver } from "./driver.js";`
- `export type { CodexDriverConfig } from "./driver.js";`
- `export { codexAgentRoles, codexAgentRoleToml, codexAuthPath, codexCatalogEntries, codexLaunchConfigToml, codexListedStockSlugs, codexModelCatalogJson, codexProfileFiles, codexProfileFileToml, hasCodexLogin, isCodexConfigFailure, launchCodex, readCodexCatalogTemplate, readCodexModelsCache } from "./launch.js";`
- `export type { CodexAgentRole, CodexModelPreset } from "./launch.js";`
- `export { codexIntegrationBlock, installCodexIntegration, uninstallCodexIntegration } from "./install.js";`
- `export type { CodexInstallInput, CodexInstallOwner, CodexInstallProfile, CodexInstallResult } from "./install.js";`

### `packages/tool-cursor/src/index.ts`

No module JSDoc was found.

- `export const cursorTool: ToolIntegration ...`
- `export { buildCursorAcpProducer } from "./acp.js";`
- `export { startCursorBridge } from "./bridge.js";`
- `export { CURSOR_AGENT_TOOL_MAX_ITERATIONS, CURSOR_AGENT_TOOL_POLICY, cursorBridgeEnv, cursorBridgeModelEnv, cursorIdeEnv, cursorIdeModelsJson } from "./bridge-config.js";`
- `export { resolveCursorkitCli } from "./cursorkit-path.js";`
- `export type { CursorkitCli } from "./cursorkit-path.js";`
- `export { cursorIdeInstructions, cursorInstructions, launchCursor } from "./launch.js";`
- `export { CURSOR_AGENTS_DIRNAME, cursorSubagentMarkdown, scaffoldCursorSubagents } from "./subagents.js";`
- `export { createCursorDriver, cursorDriverConfigSchema } from "./driver.js";`
- `export type { CursorDriverConfig } from "./driver.js";`

### `packages/tool-opencode/src/index.ts`

No module JSDoc was found.

- `export const opencodeTool: ToolIntegration ...`
- `export { launchOpencode, opencodeConfig, opencodeModelArg, opencodeProviderConfig } from "./launch.js";`
- `export { createOpencodeDriver, opencodeDriverConfigSchema } from "./driver.js";`
- `export type { OpencodeBackend, OpencodeBackendFactory, OpencodeDriverConfig, OpencodeDriverOptions, OpencodeTurnPart, OpencodeTurnResult } from "./driver.js";`

### `packages/tool-registry/src/index.ts`

Canonical registry of the coding-tool integrations shipped by RouteKit.

Add a new integration to `toolIntegrations`; consumers receive it through
`toolRegistry` without maintaining their own package imports or lists.

- `export { codexIntegrationBlock, installCodexIntegration, uninstallCodexIntegration } from "@routekit/tool-codex";`
- `export type { CodexInstallInput, CodexInstallOwner, CodexInstallProfile, CodexInstallResult } from "@routekit/tool-codex";`
- `export const toolIntegrations: readonly ToolIntegration[] ...`
- `export const toolRegistry: ToolRegistry ...`

### `packages/tools/src/index.ts`

No module JSDoc was found.

- `export type { AgentProfile, ToolCapabilityGrade, ToolCapabilityMetadata, ToolDriverMetadata, ToolDriverRoute, ToolIntegration, ToolLaunchContext, ToolLaunchSpec, ToolModel, ToolModelFeature, ToolModelFeatureStatus } from "./types.js";`
- `export { createToolCapabilityMatrix, createToolRegistry } from "./registry.js";`
- `export type { ToolCapabilityCell, ToolRegistry } from "./registry.js";`
- `export { createDisposerRunner, createToolLaunchContext } from "./launch-context.js";`
- `export type { CreateToolLaunchContextInput, DisposerRunner, ToolDisposer, ToolLaunchContextHandle } from "./launch-context.js";`

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
- `export { InMemoryLogRecordExporter, InMemorySpanExporter, SimpleLogRecordProcessor, SimpleSpanProcessor } from "@routekit/tracing";`
- `export type { LogRecordProcessor, SpanProcessor } from "@routekit/tracing";`
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

