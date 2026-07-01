# Source symbol index

This index makes documentation coverage auditable against the repository source. It lists TypeScript exported declarations and Python classes and functions by source module. Use it with the narrative references when you need to find the exact file that owns a symbol.

The index is intentionally source-shaped. It does not replace package guides, API guides, or examples. It gives maintainers a complete map from documented areas to concrete modules.

## TypeScript exported declarations

### `adapter-ai-sdk`

- `packages/adapter-ai-sdk/src/managed-server.ts`: ManagedServerEvent (type), ManagedServerStatus (type), ManagedModelServerOptions (type), ManagedModelServer (class), managedModelServer (function), MlxServerOptions (type), mlxServer (function)
- `packages/adapter-ai-sdk/src/mlx-env.ts`: MLX_LM_PIN (const), MLX_LM_STRUCTURED_PIN (const), PYTHON_PIN (const), defaultMlxDir (function), MlxEnvManifest (type), SpawnSpec (type), LocalModelInfo (type), DownloadProgress (type), ProvisionEvent (type), MlxCapabilityError (class), MlxEnvOptions (type), MlxEnv (class)
- `packages/adapter-ai-sdk/src/mlx-helper-source.ts`: MLX_HELPER_PY (const)
- `packages/adapter-ai-sdk/src/model.ts`: EscalationReason (type), HandoffModelConfig (type), HandoffModel (class), handoffModel (function), attachModel (function), withModel (function)
- `packages/adapter-ai-sdk/src/remote-tools.ts`: RemoteToolsConfig (type), RemoteToolsContextConfig (type), ShellToolInput (type), ShellToolOutput (type), RemoteToolCallRecord (type), RemoteToolSet (type), RemoteTools (type), remoteTools (function)
- `packages/adapter-ai-sdk/src/routed-model.ts`: RouterCard (type), loadRouterCard (function), RouteDecision (type), RoutedModelConfig (type), RoutedModel (class), routedModel (function), withRoutedModel (function)
- `packages/adapter-ai-sdk/src/swarm-tools.ts`: SwarmPlane (type), SwarmToolsConfig (type), SwarmToolsContextConfig (type), WorkerTaskInput (type), DispatchInput (type), DispatchOutput (type), StatusInput (type), StatusOutput (type), PullInput (type), PullOutput (type), EscalateInput (type), EscalateOutput (type), SwarmToolSet (type), SwarmRunRecord (type), SwarmTools (type), swarmTools (function)
- `packages/adapter-ai-sdk/src/worktree-agent.ts`: TrajectoryStepType (type), TrajectoryStep (type), WorktreeAgentResult (type), WorktreeAgentInput (type), runWorktreeAgent (function), worktreeDiff (function)

### `adapter-compute`

- `packages/adapter-compute/src/sandbox.ts`: GovernedComputeConfig (type), CommandResult (type), SandboxRunRecord (type), GovernedCompute (type), SandboxBinding (type), GovernedSandbox (class), governedCompute (function), withCompute (function)

### `cli`

- `packages/cli/src/cli.ts`: buildProgram (function)
- `packages/cli/src/commands/config.ts`: registerConfig (function)
- `packages/cli/src/commands/deployment.ts`: registerDeployment (function)
- `packages/cli/src/commands/doctor.ts`: registerDoctor (function)
- `packages/cli/src/commands/ensemble-gateway.ts`: buildGatewayCommand (function)
- `packages/cli/src/commands/ensemble-records.ts`: HandoffPayload (type), HandoffHarnessSelection (type), safeId (function), writeEnsembleOutput (function), readStdinJson (function), parseHandoffTask (function), baseGitSha (function), recordsForResult (function), skippedHandoffRecords (function), selectHandoffHarness (function), handoffSideEffects (function), renderEnsembleSummary (function), renderHarnessSmokeDashboardSummary (function)
- `packages/cli/src/commands/ensemble.ts`: registerEnsemble (function)
- `packages/cli/src/commands/fusion.ts`: registerFusion (function)
- `packages/cli/src/commands/local.ts`: registerLocal (function)
- `packages/cli/src/commands/models.ts`: registerModels (function)
- `packages/cli/src/commands/runtime.ts`: registerRuntime (function)
- `packages/cli/src/commands/sessions.ts`: resolveSessionId (function), registerSessions (function)
- `packages/cli/src/commands/setup.ts`: registerSetup (function)
- `packages/cli/src/config.ts`: CliConfig (type), WarrantHome (type), InitOptions (type), initHome (function), loadHome (function), secretStoreFor (function)
- `packages/cli/src/cursor-acp.ts`: CursorAcpProducerInput (type), buildCursorAcpProducer (function)
- `packages/cli/src/dashboard.ts`: HarnessCapabilityTarget (type), HarnessAvailability (type), HarnessLiveSmokeTarget (type), HarnessSmokePurpose (type), HarnessAdapterReadiness (type), HarnessCapabilityMatrixRow (type), HarnessCapabilityMatrix (type), HarnessSmokeOutcome (type), HarnessSmokeRecord (type), HarnessSmokeDashboard (type), HarnessSmokeDashboardOptions (type), createHarnessCapabilityMatrix (function), runHarnessSmokeDashboard (function), harnessDashboard (const)
- `packages/cli/src/fusion/effective-config.ts`: ConfigSource (type), Provenance (type), DEFAULT_TOOL (const), DEFAULT_LOCAL (const), DEFAULT_OBSERVE (const), DEFAULT_ON_RATE_LIMIT (const), DEFAULT_PORTLESS (const), EffectiveOverrides (type), EffectiveFusionConfig (type), resolveEffectiveConfig (function)
- `packages/cli/src/fusion/env.ts`: FusionTool (type), PanelProvider (type), PanelAuthMode (type), PanelModelSpec (type), RunFusionOptions (type), StackEvent (type), StackReporter (type), FUSIONKIT_PYPI_VERSION (const), DEFAULT_CLOUD_PANEL (const), DEFAULT_TRIO (const), fusionkitPyCommand (function), fusionkitWarmArgv (function), loadEnvFileInto (function), defaultKeyEnv (function), gitToplevel (function)
- `packages/cli/src/fusion/local-catalog.ts`: ModelRole (type), LocalCatalogEntry (type), LOCAL_CATALOG (const), HostInfo (type), detectHost (function), USABLE_RAM_FRACTION (const), usableRamGB (function), fits (function), affordable (function), CatalogRecommendation (type), recommendFor (function), defaultTrioFor (function), catalogEntry (function), LOCAL_CATALOG_REPOS (const)
- `packages/cli/src/fusion/mlx.ts`: ownedMlxEnv (function)
- `packages/cli/src/fusion/model-catalog.ts`: ModelSource (type), ModelListResult (type), parseOpenAiModels (function), parseAnthropicModels (function), parseGoogleModels (function), listModelsForAuth (function), CURATED_MODELS (const)
- `packages/cli/src/fusion/model-sizing.ts`: KV_CONTEXT_TOKENS (const), SizingSource (type), ModelSizing (type), sumSafetensorBytes (function), kvCacheBytes (function), requiredGBFrom (function), EstimateOptions (type), clearSizingCacheForTests (function), estimateModelSizing (function)
- `packages/cli/src/fusion/observability.ts`: SCOPE_DASHBOARD_PORT (const), findScopeAppDir (function), bundledScopeServer (function), openUrl (function), Observability (type), startObservability (function)
- `packages/cli/src/fusion/panel-auth.ts`: AuthChoice (type), specForAuthChoice (function), defaultModelForAuthChoice (function), AuthOption (type), buildAuthOptions (function)
- `packages/cli/src/fusion/platform.ts`: panelUsesLocalMlx (function), localPanelUnsupportedMessage (function), ensureLocalPanelSupported (function), CapabilityLine (type), platformCapabilities (function)
- `packages/cli/src/fusion/preflight.ts`: agentBinary (function), preflightRequirements (function)
- `packages/cli/src/fusion/provision.ts`: ProvisionOutcome (type), engineCached (function), provisionFusionEngine (function), provisionEngineWithProgress (function)
- `packages/cli/src/fusion/stack.ts`: Router (type), routerConfigYaml (function), exportRouterYaml (function), startRouter (function), FusionStack (type), StartFusionStackOptions (type), startFusionStack (function)
- `packages/cli/src/fusion/subscriptions.ts`: DEFAULT_CLAUDE_SUB_MODEL (const), DEFAULT_CODEX_MODEL (const), SubscriptionStatus (type), detectSubscription (function), detectCodexModel (function)
- `packages/cli/src/fusion-config.ts`: FUSION_CONFIG_DIRNAME (const), FUSION_CONFIG_BASENAME (const), FUSION_PROMPTS_DIRNAME (const), FUSION_CONFIG_FILENAME (const), FUSION_CONFIG_VERSION (const), PROMPT_IDS (const), PromptId (type), PROMPT_CONFIG_KEY (const), PromptOverrides (type), FusionConfig (type), FusionConfigError (class), fusionConfigDir (function), fusionConfigPath (function), legacyFusionConfigPath (function), fusionPromptsDir (function), fusionPromptPath (function), parseFusionConfig (function), readFusionPrompts (function), loadFusionConfig (function), writeFusionConfig (function), writeFusionPrompts (function)
- `packages/cli/src/fusion-init.ts`: judgeOptions (function), defaultMemberId (function), runFusionInit (function)
- `packages/cli/src/fusion-quickstart.ts`: FUSION_TOOLS (const), portlessEnabled (function), runFusion (function), pickTool (function)
- `packages/cli/src/gateway.ts`: GatewayRunnerConfig (type), setGatewayChatter (function), buildFrontDoorRunner (function), buildAcpRunner (function), codexConfigSnippet (function), gatewaySetupSnippets (function), startFusionStepGateway (function), startConfiguredGateway (function), runGatewayAcp (function), GatewayAcceptanceInput (type), runGatewayAcceptance (function), installRegistryAdapters (function)
- `packages/cli/src/local.ts`: LocalTool (type), LOCAL_TOOLS (const), RunLocalOptions (type), runLocal (function)
- `packages/cli/src/render.ts`: renderReceipt (function), renderDisclosure (function), renderRunList (function), renderTrace (function)
- `packages/cli/src/shared/errors.ts`: fail (function)
- `packages/cli/src/shared/options.ts`: collect (function), parseIdValue (function), ensembleModels (function), liveSmokeTargets (function), unifiedHarnessKinds (function), parseTimeoutMs (function), parsePort (function), parseBudget (function), isolationFlag (function), PANEL_PROVIDERS (const), PANEL_AUTH_MODES (const), ON_RATE_LIMIT_POLICIES (const), parseOnRateLimit (function), parseFusionTool (function), parsePanelModelSpec (function)
- `packages/cli/src/shared/plane.ts`: WATCH_POLL_MS (const), CONTINUE_WAIT_TIMEOUT_MS (const), resolveDir (function), clientFor (function), waitForTerminal (function)
- `packages/cli/src/shared/portless.ts`: stateDir (function), caCertPath (function), tld (function), DetectedProxy (type), detectProxy (function), SpawnedService (type), DiscoverOrSpawnInput (type), DiscoverOrSpawnResult (type), PortlessSession (type), CreateSessionInput (type), createPortlessSession (function), reapFusionServices (function)
- `packages/cli/src/shared/preflight.ts`: PreflightError (class), hasBinary (function), INSTALL_HINTS (const), runPreflight (function)
- `packages/cli/src/tools.ts`: toolRegistry (const)
- `packages/cli/src/ui/boot.ts`: BootView (type), BootServer (type), createBootView (function)
- `packages/cli/src/ui/progress.ts`: formatBytes (function), ProgressUpdate (type), ProgressBar (class)
- `packages/cli/src/ui/prompt.ts`: SelectOption (type), select (function), confirm (function), text (function), done (function), note (function)
- `packages/cli/src/ui/runtime.ts`: isCI (function), uiStream (function), isInteractive (function), canPromptInteractively (function)
- `packages/cli/src/ui/spinner.ts`: Spinner (class), withSpinner (function)
- `packages/cli/src/ui/steps.ts`: StepStatus (type), StepInput (type), StepList (class)
- `packages/cli/src/ui/theme.ts`: supportsColor (function), bold (const), dim (const), italic (const), underline (const), red (const), green (const), yellow (const), blue (const), magenta (const), cyan (const), gray (const), glyph (const), SPINNER_FRAMES (const), brandHeader (function), stripAnsi (function), box (function), gradient (function), brandBanner (function)

### `ensemble`

- `packages/ensemble/src/advanced-operators.ts`: EvidenceBundle (type), CandidateRef (type), RankMatrix (type), SelectedCandidate (type), RepairOutput (type), RouteDecision (type), DelegationResult (type), ReviewResult (type), TreeNodeValue (type), ArchitectureEvaluation (type), MergeRecipe (type), EvidenceSource (type), SignalCalibrator (type), CandidateSelector (type), CandidateRepairer (type), RepairPredicate (type), EvidenceSourceOperator (class), CalibrateSignalOperator (class), SchemaValidationOperator (class), PairRankOperator (class), SelectOperator (class), RepairOperator (class), GenFuserOperator (class), RouteOperator (class), DelegateOperator (class), ReviewOperator (class), TreeExpandOperator (class), TreeScoreOperator (class), ArchitectureEvaluateOperator (class), OfflineModelMergeOperator (class)
- `packages/ensemble/src/agent.ts`: AgentHarnessOptions (type), createAgentHarness (function)
- `packages/ensemble/src/artifacts.ts`: ArtifactStore (type), createArtifactStore (function)
- `packages/ensemble/src/candidate-trace.ts`: CandidateTraceContext (type), CandidateTraceInput (type), CandidateOutcome (type), CandidateTracer (type), traceCandidate (function)
- `packages/ensemble/src/command.ts`: CommandHarnessEnvInput (type), CommandHarnessOptions (type), createCommandHarness (function)
- `packages/ensemble/src/cursorkit-path.ts`: CursorkitCli (type), resolveCursorkitCli (function)
- `packages/ensemble/src/external-executor.ts`: FusionKitToolExecutionRequest (type), FusionKitToolExecutionBatch (type), FusionKitToolExecutionResult (type), FusionKitToolExecutionResponse (type), FusionKitToolExecutorServerOptions (type), FusionKitToolExecutorServer (type), FusionKitToolExecutorError (class), FusionKitToolExecutorClientError (class), FusionKitToolExecutorClient (class), executeFusionKitToolBatch (function), startFusionKitToolExecutorServer (function)
- `packages/ensemble/src/fusion-operators.ts`: ChatMessage (type), ModelGenerateRequest (type), ModelGenerateOutput (type), ModelClient (type), CandidateArtifactValue (type), PanelCandidate (type), PanelRunInput (type), PanelRunner (type), JudgeComparison (type), JudgeComparator (type), SynthesisOutput (type), Synthesizer (type), ModelGenerateOperator (class), PanelGenerateOperator (class), JudgeCompareOperator (class), SynthesizeOperator (class)
- `packages/ensemble/src/harness.ts`: EnsembleModel (type), TrajectoryStepType (type), TrajectoryStep (type), HarnessTrajectory (type), CandidateIsolationKind (type), CandidateActualIsolationKind (type), CandidateIsolationNetworkPolicy (type), CandidateIsolationMountPolicy (type), CandidateIsolationSecretPolicy (type), CandidateContainerDriverInput (type), CandidateContainerDriverResult (type), CandidateContainerDriver (type), CandidateMicrovmProvider (type), CandidateMicrovmRuntimeMetadata (type), CandidateMicrovmDriverInput (type), CandidateMicrovmDriverResult (type), CandidateMicrovmDriver (type), CandidateIsolationConfig (type), CandidateHardeningMetadata (type), hardeningToJson (function), EnsembleRuntime (type), EnsembleJudge (type), EnsemblePolicy (type), VerificationProfile (type), HarnessCapabilities (type), HarnessArtifact (type), HarnessToolRecord (type), HarnessCandidateOutput (type), HarnessPrepareInput (type), HarnessRunInput (type), HarnessCollectInput (type), HarnessAdapter (type), ReviewEvidence (type), panelMemberPreamble (function), EnsembleDescriptor (type), EnsembleRunResult (type), EnsembleCandidateSummary (type), EnsembleRunSummary (type)
- `packages/ensemble/src/isolation.ts`: CandidateCommandIsolationInput (type), CandidateCommandIsolationResult (type), runCandidateCommandWithIsolation (function), createCliContainerDriver (function), secretAbsenceMetadata (function), secretValueHash (function)
- `packages/ensemble/src/judge.ts`: JudgeCandidateEvidence (type), JudgeInput (type), JudgePatch (type), JudgeSynthesisOutput (type), SynthesisFailureSummary (type), JudgeSynthesizer (type), MockJudgeSynthesizerOptions (type), createMockJudgeSynthesizer (function)
- `packages/ensemble/src/kernel-backend.ts`: KernelBackendOptions (type), KernelBackend (class)
- `packages/ensemble/src/kernel-gateway.ts`: KERNEL_FUSE_STEP_WORKFLOW (const), FuseStepTransport (type), createKernelFuseStepRunner (function)
- `packages/ensemble/src/kernel-helpers.ts`: CreateTaskArtifactInput (type), createTaskArtifact (function), defineOperator (function), taskFromInputs (function), candidateFromArtifact (function), candidatesFromInputs (function), artifactValue (function), firstArtifactByType (function), operatorSpec (function), consumeUsageFromOutput (function)
- `packages/ensemble/src/kernel.ts`: GraphNodeInput (type), KernelWorkflow (type), GraphBuilder (class), graph (function), refs (const), WorkflowFactory (type), registerWorkflow (function), getWorkflow (function), listWorkflows (function), runWorkflow (function)
- `packages/ensemble/src/legacy-workflows.ts`: LegacyArtifactTypes (const), LegacyRunEnsembleOperator (class), TrajectoryFuseRequest (type), PythonTrajectoryFuseOperator (class), EnsembleRunWorkflowInput (type), ensembleRunWorkflow (function), PythonTrajectoryFuseWorkflowInput (type), pythonTrajectoryFuseWorkflow (function), LegacyOperatorKinds (const)
- `packages/ensemble/src/mock.ts`: MockCandidateFixture (type), MockHarnessOptions (type), createMockHarness (function)
- `packages/ensemble/src/provenance.ts`: PRODUCER (const), PRODUCER_VERSION (const), PRODUCER_GIT_SHA (const)
- `packages/ensemble/src/run.ts`: runEnsembleLegacy (function), runEnsemble (function), ensemble (const)
- `packages/ensemble/src/schedulers.ts`: FixedLayerMoAScheduler (class), BestOfNScheduler (class), RankFuseScheduler (class), ExecutionSelectRepairScheduler (class), AdaptiveRouterScheduler (class), TreeSearchScheduler (class), AgenticDelegationScheduler (class), LearnedWorkflowPolicy (type), LearnedWorkflowScheduler (class), OfflineArchitectureSearchScheduler (class)
- `packages/ensemble/src/synthesis.ts`: SynthesisResult (type), RunSynthesisInput (type), runJudgeSynthesis (function)
- `packages/ensemble/src/tool-executor.ts`: ToolImplementation (type), ToolExecutor (type), createToolExecutor (function), registerDemoTools (function), sideEffectsForTool (function)
- `packages/ensemble/src/unified.ts`: UnifiedHarnessKind (type), ToolHarnessResolveOptions (type), ToolHarnessProvider (type), setToolHarnessProvider (function), UnifiedHarnessMatrixResult (type), UnifiedHarnessE2EResult (type), CursorHarnessRunnerInput (type), CursorHarnessRunnerResult (type), UnifiedHarnessE2EOptions (type), buildPanelPrompt (function), createFusionKitJudgeSynthesizer (function), FusionPanelOptions (type), runFusionPanelWorkflow (function), runFusionPanels (function), runUnifiedHarnessE2E (function)
- `packages/ensemble/src/workflows.ts`: DirectModelWorkflowInput (type), directModelWorkflow (function), PanelCaptureWorkflowInput (type), panelCaptureWorkflow (function), PanelJudgeSynthWorkflowInput (type), panelJudgeSynthWorkflow (function), RankFuseWorkflowInput (type), rankFuseWorkflow (function), ExecutionSelectRepairWorkflowInput (type), ExecutionSelectWorkflowInput (type), executionSelectWorkflow (function), executionSelectRepairWorkflow (function), registerBuiltInWorkflows (function)
- `packages/ensemble/src/worktree.ts`: CandidateWorktree (type), WorktreePlan (type), defaultOutputRoot (function), candidateId (function), createWorktreePlan (function), sealCandidateWorktree (function), cleanupCandidateWorktree (function), cleanupWorktreePlan (function), diffCandidateWorktree (function)

### `example-utils`

- `packages/example-utils/src/manifest.ts`: DemoInfo (type), demoInfo (function), demoBanner (function)
- `packages/example-utils/src/mock-models.ts`: mockTextModel (function), mockToolThenTextModel (function)
- `packages/example-utils/src/models.ts`: LiveModels (type), MockModels (type), DemoModels (type), resolveDemoModels (function)
- `packages/example-utils/src/narrate.ts`: bold (const), dim (const), banner (function), step (function), detail (function), ok (function), expectedFailure (function), finale (function)

### `handoff`

- `packages/handoff/src/agents.ts`: agents (const)
- `packages/handoff/src/checkpoint-manager.ts`: HandoffCheckpointManager (class)
- `packages/handoff/src/defaults.ts`: DEFAULT_POLL_INTERVAL_MS (const), DEFAULT_WAIT_TIMEOUT_MS (const), DEFAULT_STREAM_TIMEOUT_MS (const), DEFAULT_ACTOR_ID (const), BLOB_UPLOAD_CONCURRENCY (const)
- `packages/handoff/src/handoff.ts`: HandoffConfig (type), ContinueOptions (type), ParallelOptions (type), defineHandoffConfig (function), HandoffInit (type), HandoffTraceEvent (type), ModelDecision (type), HandoffSummary (type), HandoffStreamEvent (type), Handoff (class), handoff (function)
- `packages/handoff/src/isolation.ts`: IsolationStrategy (type), branch (function)
- `packages/handoff/src/policy.ts`: ContinuationPolicy (type), LocalFirstOptions (type), DEFAULT_MAX_PARALLEL_RUNS (const), DEFAULT_DISCLOSURE (const), localFirst (function), PlanningDecision (type), PlanInput (type), planContinuation (function)
- `packages/handoff/src/review.ts`: ReviewStrategy (type), reviewStrategies (const), Scorecard (type), ReviewedRun (type), ReviewResult (type), scorecardFor (function), reviewRuns (function)
- `packages/handoff/src/run-executor.ts`: CommandHarnessConfig (type), createCommandContext (function), GovernedCommandOptions (type), GovernedCommandResult (type), GovernedRunRecord (type), toGovernedRunRecord (function), executeGovernedCommand (function)
- `packages/handoff/src/run.ts`: WaitOptions (type), WaitOutcome (type), HandoffRun (class)
- `packages/handoff/src/targets.ts`: RuntimeTarget (type), targets (const)
- `packages/handoff/src/tool-journal.ts`: HandoffToolJournal (class)
- `packages/handoff/src/tools.ts`: ToolLike (type), ToolCallObservation (type), wrapTools (function)
- `packages/handoff/src/trace-log.ts`: HandoffTraceLog (class)
- `packages/handoff/src/triggers.ts`: Trigger (type), triggers (const), TriggerState (type), FiredTrigger (type), evaluateTriggers (function)

### `kernel`

- `packages/kernel/src/artifact-types.ts`: ArtifactTypes (const), ArtifactType (type), OperatorKinds (const), OperatorKind (type)
- `packages/kernel/src/graph-utils.ts`: artifactRef (function), nodeRef (function), inputNodeIds (function), dependenciesFor (function), terminalNodeIds (function), nodesById (function), topoLayers (function), countOperatorKind (function), nodeOutputRefs (function)
- `packages/kernel/src/graph-validation.ts`: GraphValidationIssue (type), GraphExplanation (type), validateOperatorGraph (function), validateSchedulerGraph (function), assertValidOperatorGraph (function), explainGraph (function)
- `packages/kernel/src/runtime.ts`: ArtifactVisibility (type), ArtifactLeakage (type), OperatorSideEffects (type), RuntimeStatus (type), TaskSpec (type), CostEstimate (type), BudgetUsage (type), SignalDimension (type), SignalCalibration (type), Observation (type), Signal (type), RecordObservationInput (type), RecordSignalInput (type), Provenance (type), Artifact (type), OperatorSpec (type), RetryPolicy (type), CreateArtifactInput (type), OperatorRunContext (type), ObservationFilter (type), SignalFilter (type), Operator (type), RuntimeEvent (type), StreamingOperator (type), ArtifactInputRef (type), OperatorGraphNode (type), OperatorGraph (type), BudgetPolicy (type), BudgetLedger (type), TraceEventType (type), TraceEventInput (type), TraceEvent (type), RuntimeState (type), OutcomeRecord (type), SchedulerRunResult (type), SchedulerExecutionContext (type), Scheduler (type), RuntimeExecutionResult (type), KernelTurnState (type), KernelSessionState (type), KernelStateStore (type), InMemoryKernelStateStore (class), RuntimeExecutionError (class), RuntimeReplayRecord (type), BudgetExceededError (class), OperatorGraphError (class), RuntimeCancelledError (class), createArtifact (function), FusionRuntime (class), createRuntimeReplayRecord (function), runtimeReplayRecordJson (function), DirectFastPathScheduler (class), StaticDAGScheduler (class)
- `packages/kernel/src/wire-artifacts.ts`: WireResponseValue (type), WireArtifactTypes (const), captureWireResponse (function)

### `model-gateway`

- `packages/model-gateway/src/acp-agent.ts`: ACP_PROTOCOL_VERSION (const), AcpRunnerInput (type), AcpRunnerResult (type), AcpRunner (type), AcpAgentOptions (type), runAcpAgent (function)
- `packages/model-gateway/src/acp-registry.ts`: ACP_REGISTRY_URL (const), AcpRegistryAgent (type), AcpRegistry (type), AcpRegistryFetcher (type), InstalledAcpAdapter (type), fetchAcpRegistry (function), InstallAcpAdaptersOptions (type), installAcpAdapters (function)
- `packages/model-gateway/src/adapters/anthropic.ts`: AnthropicRequest (type), anthropicToChat (function), mapStopReason (function), chatToAnthropicMessage (function), openAiSseToAnthropic (function), countTokensEstimate (function), handleAnthropicMessages (function), handleCountTokens (function), CLAUDE_ALIAS_PREFIX (const), claudeModelAlias (function), anthropicModelsResponse (function)
- `packages/model-gateway/src/adapters/chat.ts`: withDefaultModel (function), isStream (function), effectiveModel (function)
- `packages/model-gateway/src/adapters/responses.ts`: ResponsesRequest (type), responsesToChat (function), chatToResponses (function), openAiSseToResponses (function), handleResponses (function)
- `packages/model-gateway/src/backend.ts`: Backend (type), BackendRequestOptions (type), OpenAiBackendOptions (type), joinPath (function), OpenAiBackend (class)
- `packages/model-gateway/src/config.ts`: DEFAULT_MLX_MODEL (const), BackendConfig (type), resolveBackendConfig (function), createBackend (function)
- `packages/model-gateway/src/cost.ts`: ModelPricing (type), TokenUsage (type), TurnCost (type), SessionCost (type), DEFAULT_MODEL_PRICING (const), parseUsage (function), parseUsageFromSse (function), lookupPricing (function), estimateCost (function), meterTurn (function), emptySessionCost (function), addTurnCost (function), formatUsd (function), turnCostLine (function)
- `packages/model-gateway/src/front-door-acceptance.ts`: FrontDoorStatus (type), FrontDoorOutcome (type), FrontDoorAcceptanceReport (type), FrontDoorOutcomeProducer (type), FrontDoorAcceptanceOptions (type), runFrontDoorAcceptance (function)
- `packages/model-gateway/src/frontdoor/operators.ts`: FrontdoorArtifactTypes (const), FrontdoorOperatorKinds (const), FrontdoorFuseError (class), FrontdoorPanelError (class), BudgetValue (type), RouteValue (type), FailoverValue (type), CandidateSetValue (type), frontdoorBudgetGateOperator (function), frontdoorBudgetStopOperator (function), frontdoorResolveModelOperator (function), frontdoorVendorProxyOperator (function), frontdoorPanelOperator (function), frontdoorFuseOperator (function), frontdoorStreamingFuseOperator (function), frontdoorFinalizeOperator (function)
- `packages/model-gateway/src/frontdoor/request.ts`: FUSION_FRONTDOOR_REQUEST_WORKFLOW (const), FrontdoorRequestScheduler (class), runFrontdoorRequest (function)
- `packages/model-gateway/src/frontdoor/sse.ts`: EventsToSseOptions (type), eventsToSseResponse (function)
- `packages/model-gateway/src/frontdoor/types.ts`: FrontdoorChatBody (type), FRONTDOOR_SIGNAL (const), FrontdoorRequestValue (type), FrontdoorRoute (type), VendorProxyOutcome (type), FrontdoorServices (type)
- `packages/model-gateway/src/frontdoor/workflow.ts`: FUSION_FRONTDOOR_TURN_WORKFLOW (const), FrontdoorTurnOutcome (type), frontdoorRequestArtifact (function), runFusionFrontdoorTurn (function), streamFusionFrontdoorTurn (function)
- `packages/model-gateway/src/fusion-backend.ts`: PassthroughModel (type), ChatMessageLike (type), PanelRunInput (type), PanelRunner (type), FuseStepRunInput (type), FuseStepRunner (type), OnRateLimitPolicy (type), FusionBackendOptions (type), SessionMetaInput (type), FusionBackendKernelSessionState (type), FusionBackendKernelStateStore (type), InMemoryFusionBackendKernelStateStore (class), FusionBackend (class)
- `packages/model-gateway/src/fusion-gateway.ts`: FrontDoorDialect (type), FrontDoorRunnerInput (type), FrontDoorRunnerResult (type), FrontDoorRunner (type), FusionGatewayOptions (type), FusionGateway (type), FUSION_RUN_ID_HEADER (const), FUSION_STATUS_HEADER (const), FUSION_EVIDENCE_HEADER (const), FUSION_REPORT_HEADER (const), promptFromResponses (function), promptFromAnthropic (function), ChatRequest (type), promptFromChat (function), formatResponses (function), formatAnthropic (function), formatChat (function), startFusionGateway (function)
- `packages/model-gateway/src/mlx-backend.ts`: MlxBackendOptions (type), MlxBackend (class)
- `packages/model-gateway/src/provenance.ts`: GatewayDialect (type), MODEL_CALL_ID_HEADER (const), UNKNOWN_GIT_SHA (const), resolveProducerGitSha (function), readProducerVersion (function), ModelGatewayCallContext (type), ModelGatewayCallResult (type), ModelCallRecord (type), ProvenanceSink (type), buildModelCallRecord (function), modelCallId (function), responseBodyHash (function)
- `packages/model-gateway/src/server.ts`: GatewayOptions (type), Gateway (type), startGateway (function)
- `packages/model-gateway/src/session-store.ts`: SessionTurnRecord (type), SessionMeta (type), PersistedSession (type), SessionSummary (type), SessionStore (interface), defaultSessionsDir (function), FileSystemSessionStore (class), InMemorySessionStore (class)
- `packages/model-gateway/src/trajectory-capture.ts`: CapturedStep (type), CapturedTrajectory (type), reconstructTrajectory (function), TrajectoryCapture (type), createTrajectoryCapture (function)

### `plane`

- `packages/plane/src/auth.ts`: Principal (type), hashToken (function), toPrincipal (function), Capability (type), principalCan (function)
- `packages/plane/src/claim-token-service.ts`: ClaimTokenPayload (type), VerifiedClaimToken (type), ClaimTokenServiceOptions (type), ClaimTokenService (class)
- `packages/plane/src/contract-service.ts`: ContractServiceOptions (type), ContractService (class)
- `packages/plane/src/domain-errors.ts`: PlaneErrorCode (type), PlaneDomainError (class), badRequest (function), unauthorized (function), forbidden (function), notFound (function), conflict (function), capabilityMismatch (function), isPlaneDomainError (function)
- `packages/plane/src/idp.ts`: IdpConfig (type), VerifiedApproval (type), IdpVerifier (class)
- `packages/plane/src/keys.ts`: MasterKey (type), DEFAULT_MASTER_KEY_ENV (const), generateMasterKeyHex (function), masterKeyFromMaterial (function), resolveMasterKey (function), SealedBlob (type), seal (function), open (function), sealToFile (function), openFromFile (function), OrgKeyPair (type), KeyProvider (interface), FileKeyProvider (class)
- `packages/plane/src/logging.ts`: createLogger (function), Metrics (class)
- `packages/plane/src/plane.ts`: PlaneConfig (type), PlaneTuning (type), DEFAULT_PLANE_TUNING (const), IssuedPrincipal (type), Plane (class)
- `packages/plane/src/policy.ts`: PolicyRequest (type), evaluatePolicy (function), defaultPolicy (function)
- `packages/plane/src/ratelimit.ts`: RateLimitConfig (type), DEFAULT_RATE_LIMIT (const), RateLimiter (class)
- `packages/plane/src/receipt-service.ts`: ReceiptServiceConfig (type), ReceiptService (class)
- `packages/plane/src/retention.ts`: collectReferencedBlobs (function), RetentionResult (type), RetentionSweeper (class)
- `packages/plane/src/run-lifecycle.ts`: assertRunTransition (function)
- `packages/plane/src/secrets.ts`: SecretStore (class)
- `packages/plane/src/server.ts`: DEFAULT_MAX_BODY_BYTES (const), PlaneServerOptions (type), startPlaneServer (function)
- `packages/plane/src/sqlite-store.ts`: SqliteStoreOptions (type), SqliteStore (class)
- `packages/plane/src/store.ts`: RunRecord (type), ApprovalRecord (type), RunnerRecord (type), PrincipalRole (type), PRINCIPAL_ROLES (const), isPrincipalRole (function), PrincipalRecord (type), EnrollTokenRecord (type), RunSummaryRow (type), PlaneStore (interface), ContinuationRefOrUndefined (type)
- `packages/plane/src/validation.ts`: runRequestSchema (const), createRunBodySchema (const), enrollBodySchema (const), claimBodySchema (const), approveBodySchema (const), cancelBodySchema (const), eventsBodySchema (const), completeBodySchema (const), issuePrincipalBodySchema (const), ValidationError (class), parseBody (function)

### `protocol`

- `packages/protocol/src/api.ts`: RunRequest (type), RunRequestInput (type), PolicyDecision (type), DisclosureReport (type), ClaimResult (type), RunView (type), RunSummary (type), RunnerSummary (type)
- `packages/protocol/src/chain.ts`: appendEvent (function), ChainVerification (type), verifyChain (function)
- `packages/protocol/src/constants.ts`: PROTOCOL_VERSIONS (const), MODEL_FUSION_SCHEMA_NAMES (const), KEY_ID_HEX_LENGTH (const)
- `packages/protocol/src/contract.ts`: contractHash (function), signContract (function), KeyResolver (type), verifyContractSignature (function)
- `packages/protocol/src/execution.ts`: ExecutionEnv (type), ExecutionLogPolicy (type), ExecutionSpec (type), defaultExecutionSpec (function), executionFromRunRequest (function)
- `packages/protocol/src/fusion-wire.ts`: WireTrajectory (type), isWireTrajectory (function), assertWireTrajectory (function), normalizeWireTrajectories (function)
- `packages/protocol/src/generated/model-fusion-openapi.ts`: MODEL_FUSION_OPENAPI_SOURCE_HASH (const), MODEL_FUSION_HARNESS_EXECUTOR_PATH (const), ModelFusionOpenApiPersistedJsonRecord (type), ModelFusionOpenApiArtifactRef (type), ModelFusionOpenApiHarnessExecutionRequest (type), ModelFusionOpenApiHarnessExecutionResult (type), ModelFusionOpenApiErrorResponse (type), ExecuteHarnessTaskClientOptions (type), executeHarnessTask (function)
- `packages/protocol/src/hash.ts`: SHA256_PREFIX (const), sha256Hex (function), sha256PrefixedHex (function), hashCanonical (function), hashCanonicalSha256 (function), requestHash (function), responseHash (function), artifactHash (function), schemaBundleHash (function)
- `packages/protocol/src/jcs.ts`: JsonValue (type), canonicalize (function)
- `packages/protocol/src/keys.ts`: KeyPairPem (type), generateEd25519KeyPair (function), keyIdFromPublicPem (function), signData (function), verifyData (function)
- `packages/protocol/src/model-fusion.ts`: MODEL_FUSION_SCHEMA_NAMES (const), MODEL_FUSION_SCHEMA_BUNDLE_HASH (const), ModelFusionSchemaName (type), ModelFusionStatus (type), ModelFusionSideEffects (type), ModelFusionHarnessKind (type), ModelFusionCapabilityStatus (type), ModelFusionArtifactKind (type), ModelFusionRedactionStatus (type), ModelFusionErrorKind (type), ModelFusionChatRole (type), BenchmarkTaskKind (type), BenchmarkSourceRepo (type), BenchmarkScorerKind (type), JudgeSynthesisDecision (type), ContractMetadataV1 (type), ModelFusionChatMessage (type), ModelFusionUsage (type), ModelFusionError (type), ArtifactRef (type), ArtifactRefV1 (type), ModelCallRecordV1 (type), HarnessRunRequestV1 (type), HarnessRunResultV1 (type), HarnessCandidateRecordV1 (type), JudgeSynthesisRecordV1 (type), BenchmarkScorer (type), BenchmarkTaskRecordV1 (type), ToolCallPlanV1 (type), ToolExecutionRecordV1 (type), EnsembleReceiptV1 (type), ModelFusionRecordV1 (type), assertArtifactRefV1 (function), assertModelCallRecordV1 (function), assertHarnessRunRequestV1 (function), assertHarnessRunResultV1 (function), assertHarnessCandidateRecordV1 (function), assertJudgeSynthesisRecordV1 (function), assertBenchmarkTaskRecordV1 (function), assertToolCallPlanV1 (function), assertToolExecutionRecordV1 (function), assertEnsembleReceiptV1 (function), assertModelFusionRecord (function)
- `packages/protocol/src/receipt-story.ts`: EventSummary (type), ReceiptStory (type), summarizeRunEvent (function), buildReceiptStory (function)
- `packages/protocol/src/receipt.ts`: signReceipt (function), verifyReceiptSignature (function), BundleVerification (type), RunnerReceiptVerificationInput (type), verifyRunnerReceipt (function), verifyReceiptBundle (function)
- `packages/protocol/src/tool-executor.ts`: ToolSideEffectClass (type), ToolExecutorMode (type), ToolPolicyDecision (type), ToolDefinition (type), ToolExecutorLimits (type), ToolExecutorBudget (type), ToolExecutorContract (type), ToolExecutionRequest (type), ToolExecutionResult (type), toolArgumentsHash (function), toolCallKey (function), modelFusionSideEffects (function), toolSideEffectClassFromModelFusion (function), evaluateToolPolicy (function)
- `packages/protocol/src/trace.ts`: FUSION_TRACE_EVENT_SCHEMA (const), FUSION_TRACE_EVENT_VERSION (const), TRACE_ID_HEADER (const), TRACE_SPAN_HEADER (const), TRACE_PARENT_SPAN_HEADER (const), TRACE_CANDIDATE_HEADER (const), FusionTraceComponent (type), FusionTraceEventType (type), FUSION_TRACE_COMPONENTS (const), FUSION_TRACE_EVENT_TYPES (const), FusionTraceEvent (type), EmitInput (type), newTraceId (function), newSpanId (function), ambientTraceId (function), TraceEmitter (class), getTraceEmitter (function), emitTrace (function), assertFusionTraceEvent (function), isFusionTraceEvent (function), judgeRequestPayload (function), judgeThinkingPayload (function), judgeFinalPayload (function), modelCallStartedPayload (function), modelCallFinishedPayload (function)
- `packages/protocol/src/types.ts`: RunStatus (type), FailureClass (type), DisclosureMode (type), CheckpointTier (type), AttestationTier (type), SessionIsolation (type), AgentKind (type), AgentSpec (type), TaskSpec (type), RunnerSelector (type), ActorRef (type), KeyRef (type), Signature (type), ManifestFile (type), WorkspaceManifest (type), SecretClaim (type), NetworkPolicy (type), BudgetSpec (type), RunContract (type), DataClassRule (type), SecretScopeRule (type), ConsentRule (type), RetentionPolicy (type), Policy (type), ArtifactKind (type), RunEvent (type), ChainedEvent (type), RunnerIdentity (type), SecretReleaseRecord (type), NetworkAccessRecord (type), ModelUsageRecord (type), DisclosureRecord (type), Receipt (type), SemanticState (type), ToolCallRecord (type), ToolJournal (type), Checkpoint (type), HandoffSource (type), HandoffTargetRef (type), HandoffEnvelope (type), ContinuationRef (type), ReceiptBundle (type), PolicyDeniedError (class)
- `packages/protocol/src/validators.ts`: SECRET_NAME_PATTERN (const), POOL_NAME_PATTERN (const), WORKSPACE_RELATIVE_PATH_PATTERN (const), parseSecretName (function), parsePoolName (function), parseHostAllowlistEntry (function), parseWorkspaceManifestPath (function)
- `packages/protocol/src/vocabulary.ts`: RUN_STATUSES (const), TERMINAL_RUN_STATUSES (const), AGENT_KINDS (const), SESSION_ISOLATIONS (const), DISCLOSURE_MODES (const), CHECKPOINT_TIERS (const), ACTOR_KINDS (const), RUN_EVENT_TYPES (const), HEX_HASH_PATTERN (const), isTerminalStatus (function), isAgentKind (function)

### `runner`

- `packages/runner/src/agents.ts`: AgentCommand (type), AgentContext (type), buildAgentCommand (function)
- `packages/runner/src/backend.ts`: SessionExecution (type), SessionBackendResult (type), SessionBackend (type)
- `packages/runner/src/egress.ts`: EgressEvent (type), EgressProxy (type), parseConnectAuthority (function), startEgressProxy (function)
- `packages/runner/src/execution.ts`: PreparedExecution (type), BackendExecutionKind (type), PrepareExecutionInput (type), DEFAULT_TIMEOUT_MS (const), resolveSessionEnv (function), executionSpecFor (function), prepareExecution (function), executionHash (function), requireShellExecution (function)
- `packages/runner/src/process-backend.ts`: ProcessSessionBackend (class)
- `packages/runner/src/runner.ts`: RunnerOptions (type), Runner (class)
- `packages/runner/src/session.ts`: SessionResult (type), runSession (function), CapabilityMismatchError (class)

### `sdk`

- `packages/sdk/src/client.ts`: PlaneClientError (class), PlaneClient (class)

### `session-harness`

- `packages/session-harness/src/auth.ts`: claudeCodeAuthFromEnv (function), piAuthFromEnv (function)
- `packages/session-harness/src/backend.ts`: HarnessAdapter (type), HarnessSandboxProvider (type), CreateHarnessInput (type), CreateSandboxProviderInput (type), HarnessBinding (type), isAgentRunFor (function), AiSdkHarnessBackend (class), harnessBackend (function)
- `packages/session-harness/src/claude-code.ts`: ClaudeCodeBindingOptions (type), isClaudeCodeAgentRun (function), claudeCodeBinding (function), AiSdkHarnessBackendOptions (type), aiSdkHarnessBackend (function)
- `packages/session-harness/src/pi.ts`: PiBindingOptions (type), isPiAgentRun (function), piBinding (function), PiHarnessBackendOptions (type), piHarnessBackend (function)
- `packages/session-harness/src/test/fakes.ts`: FakeHarnessLog (type), emptyHarnessLog (function), fakeHarness (function), fakeLocalSandboxProvider (function)
- `packages/session-harness/src/transcript.ts`: TranscriptLine (type), TranscriptRecorder (class)

### `session-hermetic`

- `packages/session-hermetic/src/index.ts`: toJustBashNetwork (function), HermeticSessionBackend (class), hermeticBackend (function)

### `session-vercel-sandbox`

- `packages/session-vercel-sandbox/src/index.ts`: VercelSandboxSource (type), VercelSandboxResources (type), VercelSandboxCreateInput (type), VercelSandboxInstance (type), VercelSandboxFactory (type), VercelSandboxOptions (type), SANDBOX_IGNORED_DIRS (const), shellQuote (function), listWorkspaceFiles (function), writeMirroredFile (function), vercelCredentialsFromEnv (function), toVercelNetwork (function), VercelSandboxBackend (class), vercelSandboxBackend (function)

### `testkit`

- `packages/testkit/src/index.ts`: git (function), RepoFixtureOptions (type), makeRepo (function), StackOptions (type), Stack (type), uploadWorkspace (function), mockRunRequest (function), withStackAndRepo (function), startStack (function)

### `tool-claude`

- `packages/tool-claude/src/harness.ts`: ClaudeCodeHarnessEnv (type), ClaudeCodeHarnessOptions (type), claudeCodeHarnessCredentialSkipReason (function), createClaudeCodeHarness (function), claudeCodeHarness (function)
- `packages/tool-claude/src/index.ts`: claudeTool (const)
- `packages/tool-claude/src/launch.ts`: claudeEnv (function), launchClaude (function)
- `packages/tool-claude/src/stream-trajectory.ts`: ClaudeStreamTrajectory (type), parseClaudeStreamJson (function), resolveClaudeCliModel (function)

### `tool-codex`

- `packages/tool-codex/src/harness.ts`: CodexSandboxMode (type), CodexApprovalPolicy (type), CodexAmbientProvider (type), CodexResponsesProvider (type), CodexOpenAiCompatibleProvider (type), CodexProvider (type), CodexExecInput (type), CodexExecResult (type), CodexExecRunner (type), CodexHarnessOptions (type), CodexHarnessEnv (type), CodexConfigTomlInput (type), codexHarnessCredentialSkipReason (function), codexConfigToml (function), defaultCodexRunner (function), createCodexHarness (function), codexHarness (const)
- `packages/tool-codex/src/index.ts`: codexTool (const)
- `packages/tool-codex/src/launch.ts`: CodexModelPreset (type), readCodexCatalogTemplate (function), codexModelCatalogJson (function), codexLaunchConfigToml (function), launchCodex (function)

### `tool-cursor`

- `packages/tool-cursor/src/bridge.ts`: startCursorBridge (function)
- `packages/tool-cursor/src/harness.ts`: CursorRunMode (type), CursorExecInput (type), CursorExecResult (type), CursorExecRunner (type), CursorHarnessOptions (type), cursorHarnessUnavailableReason (function), defaultCursorRunner (function), createCursorHarness (function), cursorHarness (const)
- `packages/tool-cursor/src/index.ts`: cursorTool (const)
- `packages/tool-cursor/src/launch.ts`: cursorIdeInstructions (function), cursorInstructions (function), launchCursor (function)
- `packages/tool-cursor/src/stream-trajectory.ts`: CursorStreamTrajectory (type), parseCursorStreamJson (function)

### `tool-opencode`

- `packages/tool-opencode/src/index.ts`: opencodeTool (const)
- `packages/tool-opencode/src/launch.ts`: opencodeConfig (function), opencodeModelArg (function), launchOpencode (function)

### `tools`

- `packages/tools/src/candidate.ts`: buildSkippedCandidate (function)
- `packages/tools/src/constants.ts`: LOCAL_MODEL_LABEL (const), CURSOR_BRIDGE_MODEL_NAME (const), FUSION_PANEL_MODEL (const)
- `packages/tools/src/env-compat.ts`: legacyEnvName (function), readEnv (function), envFlagEnabled (function)
- `packages/tools/src/env.ts`: definedEnv (function), normalizeApiBaseUrl (function), DEFAULT_BRIDGE_SCRUB_PREFIXES (const), scrubBridgeEnv (function)
- `packages/tools/src/proc.ts`: sleep (function), freePort (function), spawnTool (function), LoggedSpawnOptions (type), LoggedChild (type), spawnLogged (function), distillLog (function), waitForHttp (function), waitForOutput (function), terminate (function)
- `packages/tools/src/registry.ts`: ToolRegistry (type), createToolRegistry (function)
- `packages/tools/src/types.ts`: ToolLaunchMode (type), ToolLaunchContext (type), ToolHarnessMetadata (type), ToolDashboardSmoke (type), ToolDashboardLiveSmoke (type), ToolDashboardMetadata (type), ToolIntegration (type)

### `workspace`

- `packages/workspace/src/git.ts`: GIT_MAX_BUFFER_BYTES (const), GitOptions (type), gitText (function), gitBinary (function)
- `packages/workspace/src/paths.ts`: WorkspaceRoot (type), WorkspaceRelativePath (type), parseWorkspaceRoot (function), parseWorkspaceRelativePath (function), resolveInsideWorkspace (function)
- `packages/workspace/src/workspace.ts`: PULL_BRANCH_PREFIX (const), DEFAULT_PULL_COMMITTER (const), DELETED_FILE_HASH (const), DEFAULT_DENY_PATTERNS (const), matchesPattern (function), CapturedWorkspace (type), CaptureOptions (type), captureWorkspace (function), BlobFetcher (type), materializeWorkspace (function), WorkspaceOutput (type), collectOutput (function), PullResult (type), PullOptions (type), pullRun (function)

## TypeScript entry-point re-exports

### `packages/adapter-ai-sdk/src/index.ts`

- `export { remoteTools } from "./remote-tools.js";`
- `export type {`
- `export { swarmTools } from "./swarm-tools.js";`
- `export type {`
- `export { handoffModel, withModel } from "./model.js";`
- `export type { EscalationReason, HandoffModelConfig } from "./model.js";`
- `export { loadRouterCard, routedModel, withRoutedModel } from "./routed-model.js";`
- `export type { RouteDecision, RoutedModelConfig, RouterCard } from "./routed-model.js";`
- `export { runWorktreeAgent, worktreeDiff } from "./worktree-agent.js";`
- `export type {`
- `export { defaultMlxDir, MlxCapabilityError, MlxEnv } from "./mlx-env.js";`
- `export type { DownloadProgress, LocalModelInfo, ProvisionEvent } from "./mlx-env.js";`
- `export { managedModelServer, mlxServer } from "./managed-server.js";`
- `export type {`

### `packages/adapter-compute/src/index.ts`

- `export { governedCompute, GovernedSandbox, withCompute } from "./sandbox.js";`
- `export type {`

### `packages/cli/src/index.ts`

- No explicit entry-point exports found.

### `packages/ensemble/src/index.ts`

- `export { createCommandHarness } from "./command.js";`
- `export type { CommandHarnessOptions } from "./command.js";`
- `export { resolveCursorkitCli } from "./cursorkit-path.js";`
- `export type { CursorkitCli } from "./cursorkit-path.js";`
- `export { createArtifactStore } from "./artifacts.js";`
- `export type { ArtifactStore } from "./artifacts.js";`
- `export { createMockJudgeSynthesizer } from "./judge.js";`
- `export type {`
- `export {`
- `export {`
- `export type {`
- `export {`
- `export type {`
- `export { runJudgeSynthesis } from "./synthesis.js";`
- `export type {`
- `export { ArtifactTypes, OperatorKinds } from "./artifact-types.js";`
- `export type { ArtifactType, OperatorKind } from "./artifact-types.js";`
- `export {`
- `export {`
- `export type { GraphExplanation, GraphValidationIssue } from "./graph-validation.js";`
- `export {`
- `export { KernelBackend } from "./kernel-backend.js";`
- `export { captureWireResponse, WireArtifactTypes } from "./wire-artifacts.js";`
- `export type { WireResponseValue } from "./wire-artifacts.js";`
- `export { createKernelFuseStepRunner, KERNEL_FUSE_STEP_WORKFLOW } from "./kernel-gateway.js";`
- `export type { FuseStepTransport } from "./kernel-gateway.js";`
- `export type { GraphNodeInput, KernelWorkflow, WorkflowFactory } from "./kernel.js";`
- `export {`
- `export type { CreateTaskArtifactInput } from "./kernel-helpers.js";`
- `export {`
- `export {`
- `export type {`
- `export type {`
- `export {`
- `export type {`
- `export {`
- `export type {`
- `export {`
- `export {`
- `export type { LearnedWorkflowPolicy } from "./schedulers.js";`
- `export type {`
- `export { createMockHarness } from "./mock.js";`
- `export type { MockCandidateFixture, MockHarnessOptions } from "./mock.js";`
- `export { traceCandidate } from "./candidate-trace.js";`
- `export type {`
- `export {`
- `export type { ToolExecutor, ToolImplementation } from "./tool-executor.js";`
- `export {`
- `export {`
- `export type {`
- `export type {`
- `export {`
- `export type { CandidateWorktree, WorktreePlan } from "./worktree.js";`
- `export { hardeningToJson, panelMemberPreamble } from "./harness.js";`
- `export type {`

### `packages/example-utils/src/index.ts`

- `export * from "./manifest.js";`
- `export * from "./mock-models.js";`
- `export * from "./models.js";`
- `export * from "./narrate.js";`

### `packages/handoff/src/index.ts`

- `export { defineHandoffConfig, Handoff, handoff } from "./handoff.js";`
- `export type {`
- `export { HandoffRun } from "./run.js";`
- `export type { WaitOptions, WaitOutcome } from "./run.js";`
- `export {`
- `export type {`
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
- `export type {`
- `export type { ToolCallObservation, ToolLike } from "./tools.js";`

### `packages/kernel/src/index.ts`

- `export * from "./runtime.js";`
- `export * from "./graph-utils.js";`
- `export * from "./graph-validation.js";`
- `export * from "./artifact-types.js";`
- `export * from "./wire-artifacts.js";`

### `packages/model-gateway/src/index.ts`

- `export { startGateway } from "./server.js";`
- `export type { Gateway, GatewayOptions } from "./server.js";`
- `export { joinPath, OpenAiBackend } from "./backend.js";`
- `export type { Backend, BackendRequestOptions, OpenAiBackendOptions } from "./backend.js";`
- `export { FusionBackend } from "./fusion-backend.js";`
- `export { InMemoryFusionBackendKernelStateStore } from "./fusion-backend.js";`
- `export {`
- `export type {`
- `export {`
- `export type { FrontdoorTurnOutcome } from "./frontdoor/workflow.js";`
- `export {`
- `export { eventsToSseResponse } from "./frontdoor/sse.js";`
- `export type { EventsToSseOptions } from "./frontdoor/sse.js";`
- `export { FRONTDOOR_SIGNAL } from "./frontdoor/types.js";`
- `export type {`
- `export type {`
- `export type { WireTrajectory } from "@fusionkit/protocol";`
- `export {`
- `export type {`
- `export {`
- `export type { ModelPricing, SessionCost, TokenUsage, TurnCost } from "./cost.js";`
- `export { MlxBackend } from "./mlx-backend.js";`
- `export type { MlxBackendOptions } from "./mlx-backend.js";`
- `export { createBackend, DEFAULT_MLX_MODEL, resolveBackendConfig } from "./config.js";`
- `export type { BackendConfig } from "./config.js";`
- `export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";`
- `export {`
- `export type { AnthropicRequest } from "./adapters/anthropic.js";`
- `export {`
- `export type { ResponsesRequest } from "./adapters/responses.js";`
- `export {`
- `export type {`
- `export { ACP_PROTOCOL_VERSION, runAcpAgent } from "./acp-agent.js";`
- `export type {`
- `export { runFrontDoorAcceptance } from "./front-door-acceptance.js";`
- `export type {`
- `export {`
- `export type {`
- `export {`
- `export type {`
- `export { createTrajectoryCapture, reconstructTrajectory } from "./trajectory-capture.js";`
- `export type { CapturedStep, CapturedTrajectory, TrajectoryCapture } from "./trajectory-capture.js";`

### `packages/plane/src/index.ts`

- `export { Plane } from "./plane.js";`
- `export type { PlaneConfig, IssuedPrincipal } from "./plane.js";`
- `export { startPlaneServer } from "./server.js";`
- `export type { PlaneServerOptions } from "./server.js";`
- `export { defaultPolicy, evaluatePolicy } from "./policy.js";`
- `export type { PolicyDecision, PolicyRequest } from "./policy.js";`
- `export {`
- `export type { PlaneErrorCode } from "./domain-errors.js";`
- `export { ClaimTokenService } from "./claim-token-service.js";`
- `export type {`
- `export { ContractService } from "./contract-service.js";`
- `export type { ContractServiceOptions } from "./contract-service.js";`
- `export { ReceiptService } from "./receipt-service.js";`
- `export type { ReceiptServiceConfig } from "./receipt-service.js";`
- `export { SqliteStore } from "./sqlite-store.js";`
- `export type {`
- `export { SecretStore } from "./secrets.js";`
- `export {`
- `export type { KeyProvider, MasterKey, OrgKeyPair, SealedBlob } from "./keys.js";`
- `export { hashToken, principalCan, toPrincipal } from "./auth.js";`
- `export type { Capability, Principal } from "./auth.js";`
- `export { IdpVerifier } from "./idp.js";`
- `export type { IdpConfig, VerifiedApproval } from "./idp.js";`
- `export { DEFAULT_RATE_LIMIT, RateLimiter } from "./ratelimit.js";`
- `export type { RateLimitConfig } from "./ratelimit.js";`
- `export { createLogger, Metrics } from "./logging.js";`
- `export type { Logger } from "./logging.js";`
- `export {`
- `export type { RetentionResult } from "./retention.js";`
- `export {`

### `packages/protocol/src/index.ts`

- `export {`
- `export {`
- `export { defaultExecutionSpec, executionFromRunRequest } from "./execution.js";`
- `export type {`
- `export {`
- `export type {`
- `export { canonicalize } from "./jcs.js";`
- `export type { JsonValue } from "./jcs.js";`
- `export {`
- `export type { WireTrajectory } from "./fusion-wire.js";`
- `export {`
- `export {`
- `export {`
- `export type {`
- `export type {`
- `export {`
- `export type { KeyPairPem } from "./keys.js";`
- `export { contractHash, signContract } from "./contract.js";`
- `export { appendEvent, verifyChain } from "./chain.js";`
- `export type { ChainVerification } from "./chain.js";`
- `export {`
- `export type { BundleVerification } from "./receipt.js";`
- `export { buildReceiptStory, summarizeRunEvent } from "./receipt-story.js";`
- `export type { EventSummary, ReceiptStory } from "./receipt-story.js";`
- `export {`
- `export type {`
- `export { PolicyDeniedError } from "./types.js";`
- `export type {`
- `export type {`

### `packages/runner/src/index.ts`

- `export { Runner } from "./runner.js";`
- `export { CapabilityMismatchError } from "./session.js";`
- `export type {`
- `export {`
- `export type { BackendExecutionKind } from "./execution.js";`

### `packages/sdk/src/index.ts`

- `export { PlaneClient, PlaneClientError } from "./client.js";`

### `packages/session-harness/src/index.ts`

- `export { AiSdkHarnessBackend, harnessBackend, isAgentRunFor } from "./backend.js";`
- `export type {`
- `export {`
- `export type {`
- `export { isPiAgentRun, piBinding, piHarnessBackend } from "./pi.js";`
- `export type { PiBindingOptions, PiHarnessBackendOptions } from "./pi.js";`
- `export { claudeCodeAuthFromEnv, piAuthFromEnv } from "./auth.js";`
- `export { TranscriptRecorder } from "./transcript.js";`
- `export type { TranscriptLine } from "./transcript.js";`

### `packages/session-hermetic/src/index.ts`

- `export function toJustBashNetwork(policy: NetworkPolicy): NetworkConfig {`
- `export class HermeticSessionBackend implements SessionBackend {`
- `export function hermeticBackend(): HermeticSessionBackend {`

### `packages/session-vercel-sandbox/src/index.ts`

- `export type VercelSandboxSource =`
- `export type VercelSandboxResources = {`
- `export type VercelSandboxCreateInput =`
- `export type VercelSandboxInstance = Awaited<ReturnType<typeof Sandbox.create>>;`
- `export type VercelSandboxFactory = (`
- `export type VercelSandboxOptions = {`
- `export const SANDBOX_IGNORED_DIRS: ReadonlySet<string> = new Set([`
- `export function shellQuote(value: string): string {`
- `export function listWorkspaceFiles(`
- `export function writeMirroredFile(`
- `export function vercelCredentialsFromEnv(`
- `export function toVercelNetwork(`
- `export class VercelSandboxBackend implements SessionBackend {`
- `export function vercelSandboxBackend(`

### `packages/testkit/src/index.ts`

- `export function git(cwd: string, args: string[]): string {`
- `export type RepoFixtureOptions = {`
- `export function makeRepo(options: RepoFixtureOptions = {}): string {`
- `export type StackOptions = {`
- `export type Stack = {`
- `export async function uploadWorkspace(`
- `export function mockRunRequest(`
- `export async function withStackAndRepo(`
- `export async function startStack(options: StackOptions = {}): Promise<Stack> {`

### `packages/tool-claude/src/index.ts`

- `export const claudeTool: ToolIntegration = {`
- `export {`
- `export type { ClaudeCodeHarnessEnv, ClaudeCodeHarnessOptions } from "./harness.js";`
- `export { claudeEnv, launchClaude } from "./launch.js";`

### `packages/tool-codex/src/index.ts`

- `export const codexTool: ToolIntegration = {`
- `export {`
- `export type {`
- `export {`

### `packages/tool-cursor/src/index.ts`

- `export const cursorTool: ToolIntegration = {`
- `export {`
- `export type {`
- `export { startCursorBridge } from "./bridge.js";`
- `export { cursorIdeInstructions, cursorInstructions, launchCursor } from "./launch.js";`

### `packages/tool-opencode/src/index.ts`

- `export const opencodeTool: ToolIntegration = {`
- `export { launchOpencode, opencodeConfig, opencodeModelArg } from "./launch.js";`

### `packages/tools/src/index.ts`

- `export {`
- `export type { LoggedChild, LoggedSpawnOptions } from "./proc.js";`
- `export type {`
- `export { createToolRegistry } from "./registry.js";`
- `export type { ToolRegistry } from "./registry.js";`
- `export { CURSOR_BRIDGE_MODEL_NAME, FUSION_PANEL_MODEL, LOCAL_MODEL_LABEL } from "./constants.js";`
- `export { envFlagEnabled, legacyEnvName, readEnv } from "./env-compat.js";`
- `export {`
- `export { buildSkippedCandidate } from "./candidate.js";`

### `packages/workspace/src/index.ts`

- `export {`
- `export { gitText } from "./git.js";`
- `export { parseWorkspaceRelativePath, resolveInsideWorkspace } from "./paths.js";`
- `export type {`

## Python classes and functions

### `fusionkit-cli`

- `python/fusionkit-cli/src/fusionkit_cli/main.py`: _legacy_kernel (def, internal), prompts_dump (def, public), serve (def, public), _status_label (def, internal), init (def, public), want (def, public), auth_status (def, public), _switch_endpoint (def, internal), auth_switch (def, public), auth_set_default (def, public), auth_login (def, public), serve_endpoint (def, public), run_eval (def, public), pareto (def, public), tiny_bench (def, public), fusion_bench (def, public), fusion_bench_report (def, public), public_bench (def, public), _fmt_ci (def, internal), _optional_str (def, internal), public_bench_baselines (def, public), tune_prompts (def, public), fusion_hillclimb (def, public), fusion_hillclimb_polyglot (def, public), _format_hillclimb_report (def, internal), _fmt_num (def, internal), _format_tuning_report (def, internal), _resolve_public_suite (def, internal), _write_fusion_bench_reports (def, internal)
- `python/fusionkit-cli/src/fusionkit_cli/onboarding.py`: global_config_path (def, public), resolve_config_path (def, public), default_write_path (def, public), write_config (def, public), detect_api_keys (def, public), detect_codex_model (def, public), subscription_endpoint (def, public), api_key_endpoint (def, public)

### `fusionkit-core`

- `python/fusionkit-core/src/fusionkit_core/artifacts.py`: hash_bytes (def, public), hash_text (def, public), LocalArtifactStore (class, public), __init__ (def, internal), write_text (def, public)
- `python/fusionkit-core/src/fusionkit_core/clients.py`: ProviderCallError (class, public), __init__ (def, internal), retryable (def, public), _status_code (def, internal), _retry_after (def, internal), _error_blob (def, internal), _category_for (def, internal), classify_provider_error (def, public), ChatClient (class, public), stream_chat (def, public), OpenAICompatibleClient (class, public), __init__ (def, internal), _payload (def, internal), AnthropicModelClient (class, public), __init__ (def, internal), _system_param (def, internal), _kwargs (def, internal), CodexResponsesClient (class, public), __init__ (def, internal), _request_kwargs (def, internal), GoogleModelClient (class, public), __init__ (def, internal), _request (def, internal), FakeModelClient (class, public), __init__ (def, internal), _next_content (def, internal), build_client (def, public), build_clients (def, public), _openai_messages (def, internal), _openai_tools (def, internal), _openai_tool_choice (def, internal), _openai_tool_calls (def, internal), _openai_stream_tool_call (def, internal), _anthropic_messages (def, internal), _codex_input (def, internal), _codex_tools (def, internal), _codex_tool_choice (def, internal), _codex_usage (def, internal), _anthropic_tools (def, internal), _anthropic_tool_choice (def, internal), _google_contents (def, internal), _google_tools (def, internal), _google_tool_config (def, internal), _google_extract (def, internal), _loads_arguments (def, internal)
- `python/fusionkit-core/src/fusionkit_core/config.py`: EndpointAuth (class, public), EndpointCapabilities (class, public), CostMetadata (class, public), RunBudget (class, public), SamplingConfig (class, public), PromptOverrides (class, public), ModelEndpoint (class, public), strip_trailing_slash (def, public), FusionConfig (class, public), endpoint_for (def, public), resolved_judge_model (def, public), resolved_synthesizer_model (def, public), load_config (def, public)
- `python/fusionkit-core/src/fusionkit_core/contracts.py`: ContractBaseModel (class, public), ContractMetadata (class, public), ContractRecord (class, public), validate_expected_schema (def, public), ContractChatMessage (class, public), ContractUsage (class, public), ContractError (class, public), ContractSampling (class, public), ArtifactRefV1 (class, public), ContractArtifactRef (class, public), ModelEndpointV1 (class, public), ModelCallRecordV1 (class, public), FusionRunRequestV1 (class, public), FusionRecordV1 (class, public), HarnessRunRequestV1 (class, public), HarnessRunResultV1 (class, public), HarnessCandidateRecordV1 (class, public), TrajectoryItem (class, public), TrajectorySynthesis (class, public), TrajectoryV1 (class, public), BenchmarkScorer (class, public), BenchmarkTaskRecordV1 (class, public), ToolCallPlanV1 (class, public), ToolExecutionRecordV1 (class, public), EnsembleReceiptV1 (class, public), schema_bundle_hash (def, public), producer (def, public), producer_version (def, public), _is_git_sha (def, internal), producer_git_sha (def, public), contract_metadata (def, public), contract_model_for_schema (def, public), status_for_run_state (def, public), _find_schema_dir (def, internal), _checkout_root (def, internal), _load_json (def, internal)
- `python/fusionkit-core/src/fusionkit_core/credentials.py`: SubscriptionAuthError (class, public), SubscriptionToken (class, public), is_expired (def, public), _decode_jwt_claims (def, internal), _codex_account_id_from_claims (def, internal), _read_claude_credentials_blob (def, internal), _read_macos_keychain (def, internal), load_claude_code_credentials (def, public), load_codex_credentials (def, public), _token_env_credential (def, internal), _load_for_mode (def, internal), _login_hint (def, internal), resolve_credential (def, public), _ensure_fresh (def, internal), clear_credential_cache (def, public), SubscriptionStatus (class, public), hours_to_expiry (def, public), _claude_credentials_source (def, internal), subscription_status (def, public)
- `python/fusionkit-core/src/fusionkit_core/fusion.py`: FusionEngine (class, public), __init__ (def, internal), stream_passthrough (def, public), _resolve_mode (def, internal), _client (def, internal), normalize_messages (def, public), _trajectory_metrics (def, internal), _optional_int (def, internal)
- `python/fusionkit-core/src/fusionkit_core/judge.py`: FuseResult (class, public), JudgeSynthesizer (class, public), __init__ (def, internal), _selected_verbatim (def, internal), _identity (def, internal), _split_harness_system (def, internal), _build_fuse_result (def, internal), _emit_step (def, internal), accumulate_tool_call (def, public), parse_analysis (def, public), _consolidated_trajectory (def, internal), _synthesis_metrics (def, internal), _best_trajectory_output (def, internal), _rank (def, internal), _selected_trajectory_id (def, internal), _trajectory_id_for_reason (def, internal), _rationale (def, internal), _judge_parse_status (def, internal), _judge_parse_failed (def, internal), _synthesis_id (def, internal), _last_user_text (def, internal), _extract_json (def, internal), _emit_judge (def, internal), _usage_payload (def, internal)
- `python/fusionkit-core/src/fusionkit_core/kernel.py`: FusionKernel (class, public), __init__ (def, internal), config (def, public), store (def, public), clients (def, public), client (def, public), read_summary (def, public), inspect_run (def, public), event_page (def, public), submit_tool_result (def, public), run_stream (def, public), stream_passthrough (def, public), fuse_trajectories_stream (def, public)
- `python/fusionkit-core/src/fusionkit_core/metrics.py`: RunRecord (class, public), JsonlRunLogger (class, public), __init__ (def, internal), append (def, public)
- `python/fusionkit-core/src/fusionkit_core/producers.py`: trajectory_from_response (def, public), failed_trajectory (def, public), PanelExhaustedError (class, public), trajectory_to_contract (def, public), trajectory_from_contract (def, public), ToolExecutor (class, public), TrajectoryProducer (class, public), ChatTrajectoryProducer (class, public), __init__ (def, internal), _client (def, internal), ExternalTrajectoryProducer (class, public), __init__ (def, internal), AgentTrajectoryProducer (class, public), __init__ (def, internal), _client (def, internal)
- `python/fusionkit-core/src/fusionkit_core/prompts.py`: FusionIdentity (class, public), _truncate (def, internal), _format_item (def, internal), format_trajectories (def, public), build_judge_prompt (def, public), build_identity_block (def, public), build_judge_system (def, public), build_fuse_system (def, public)
- `python/fusionkit-core/src/fusionkit_core/providers.py`: resolve_api_key (def, public), endpoint_to_contract (def, public), normalize_usage (def, public), estimate_cost (def, public), provider_metadata (def, public), _api_compatibility (def, internal), _capability (def, internal)
- `python/fusionkit-core/src/fusionkit_core/router.py`: RouterDecision (class, public), HeuristicRouter (class, public), route (def, public)
- `python/fusionkit-core/src/fusionkit_core/run.py`: FusionRunManager (class, public), __init__ (def, internal), create_run (def, public), cancel_run (def, public), record_requires_action (def, public), request_tool_action (def, public), submit_tool_result (def, public), _pause_for_tool_action (def, internal), _tool_call_plan (def, internal), _record_trajectories (def, internal), _append_state (def, internal), _append_artifact_event (def, internal), _fail_run (def, internal), _check_candidate_budget (def, internal), _check_wall_clock_budget (def, internal), _check_cost_budget (def, internal), _check_tool_budget (def, internal), make_id (def, public), canonical_json (def, public), hash_json (def, public), _request_from_events (def, internal), _runtime_messages (def, internal), _sampling_from_request (def, internal), _model_call_record (def, internal), _pending_tool_actions_from_events (def, internal), _endpoint_for_trajectory (def, internal), _run_cost_estimate (def, internal), _budget_error (def, internal), _validate_tool_policy (def, internal), _policy_cache_key (def, internal), _trajectory_id_for_source (def, internal), _run_metrics (def, internal)
- `python/fusionkit-core/src/fusionkit_core/run_models.py`: RunBaseModel (class, public), NativeRunError (class, public), ToolExecutionPolicy (class, public), ToolPausePlaceholder (class, public), ToolResultSubmission (class, public), FusionRunEvent (class, public), IdempotencyRecord (class, public), CreateRunResult (class, public), RunStateSummary (class, public), TrajectoryInspection (class, public), RunInspection (class, public), RunEventPage (class, public), RunStore (class, public), get_idempotency (def, public), write_idempotency (def, public), append_event (def, public), list_events (def, public), event_page (def, public), read_summary (def, public), write_summary (def, public), inspect_run (def, public), ArtifactWriter (class, public), write_text (def, public)
- `python/fusionkit-core/src/fusionkit_core/run_store.py`: FileSystemRunStore (class, public), __init__ (def, internal), get_idempotency (def, public), write_idempotency (def, public), append_event (def, public), list_events (def, public), event_page (def, public), read_summary (def, public), write_summary (def, public), inspect_run (def, public), _summary_from_events (def, internal), _next_event_seq (def, internal), _read_seq (def, internal), _write_seq (def, internal), _run_dir (def, internal), _event_path (def, internal), _seq_path (def, internal), _lock_path (def, internal), _summary_path (def, internal), _idempotency_path (def, internal), _read_json (def, internal), _write_json (def, internal), _artifact_from_payload (def, internal), _optional_str (def, internal), _latest_pending_action (def, internal), _dedupe_artifacts (def, internal)
- `python/fusionkit-core/src/fusionkit_core/trace.py`: new_trace_id (def, public), new_span_id (def, public), ambient_trace_id (def, public), TraceEmitter (class, public), __init__ (def, internal), enabled (def, public), _next_seq (def, internal), emit (def, public), _run (def, internal), _write_jsonl (def, internal), _post (def, internal), close (def, public), get_emitter (def, public), emit (def, public)
- `python/fusionkit-core/src/fusionkit_core/types.py`: ToolCall (class, public), ChatMessage (class, public), _coerce_content (def, internal), _flatten_tool_calls (def, internal), Usage (class, public), CallMetrics (class, public), ModelResponse (class, public), StreamChunk (class, public), TrajectorySynthesis (class, public), Trajectory (class, public), FusionAnalysis (class, public), FusionResult (class, public)

### `fusionkit-evals`

- `python/fusionkit-evals/adapters/aider_polyglot_adapter.py`: log (def, public), _root (def, internal), _languages (def, internal), cache_dir (def, public), panel_signature (def, public), cache_path (def, public), load_cached_row (def, public), save_cached_row (def, public), _candidate_cost (def, internal), _terminal_row (def, internal)
- `python/fusionkit-evals/adapters/lcb_select_adapter.py`: log (def, public), _temps (def, internal), cache_dir (def, public), signature (def, public), cache_path (def, public), load_cached (def, public), save_cached (def, public), _public_score (def, internal), _private_pass (def, internal), _score_problem (def, internal), _terminal (def, internal), _cost (def, internal), _resolve_checker (def, internal)
- `python/fusionkit-evals/adapters/livecodebench_adapter.py`: log (def, public), cache_dir (def, public), panel_signature (def, public), cache_path (def, public), load_cached_row (def, public), save_cached_row (def, public), artifacts_dir (def, public), _write_artifacts (def, internal), _terminal_row (def, internal), _score_result (def, internal), _resolve_checker_mode (def, internal), _candidate_cost (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/bench_history.py`: BenchRunRecord (class, public), BenchDrift (class, public), append_run (def, public), load_runs (def, public), previous_comparable (def, public), drift_vs_previous (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/bench_runtime.py`: is_transient (def, public), classify_exception (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/bench_stats.py`: ProportionCI (class, public), wilson_interval (def, public), pass_at_k (def, public), SeedAggregate (class, public), aggregate_seeds (def, public), bootstrap_ci (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/bench_verify.py`: SolutionRun (class, public), verify_solution (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/benchmark.py`: BenchmarkRunner (class, public), __init__ (def, internal), load_jsonl_samples (def, public), write_jsonl_results (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/benchmark_panel.py`: BenchmarkPanelMember (class, public), resolved_base_url (def, public), resolved_api_key_env (def, public), BenchmarkPanel (class, public), _validate_panel (def, internal), member_ids (def, public), resolved_synthesizer_id (def, public), member_for (def, public), to_fusion_config (def, public), PanelHeadroom (class, public), estimate_panel_headroom (def, public), get_benchmark_panel (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/candidate_bank.py`: _log (def, internal), PreparedTask (class, public), BankCandidate (class, public), BankTask (class, public), n_pass (def, public), oracle_pass (def, public), is_decision_task (def, public), CandidateBank (class, public), bank_signature (def, public), panel_model_ids (def, public), _verify_candidates (def, internal), save_bank (def, public), load_bank (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/checkers.py`: normalize_lines (def, public), exact_check (def, public), token_check (def, public), case_insensitive_check (def, public), float_check (def, public), check_output (def, public), _as_float (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/code_extract.py`: ExtractedCode (class, public), extract_code (def, public), extract_code_str (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/dirty_dozen.py`: load_dirty_dozen_tasks (def, public), assert_dirty_dozen_manifest (def, public), _assert_task_policy (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/exec_select.py`: CandidateSample (class, public), public_all (def, public), select_index (def, public), selected_private_pass (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_bench.py`: FusionBenchTask (class, public), FusionBenchFailure (class, public), FusionBenchAttemptRow (class, public), FusionBenchTaskMetrics (class, public), FusionBenchAggregateMetrics (class, public), FusionBenchFailureCorrelation (class, public), FusionBenchParetoPoint (class, public), FusionBenchReproducibilityMetadata (class, public), FusionBenchReport (class, public), HandoffKitExecutorUnavailable (class, public), HandoffKitExecutorError (class, public), HandoffKitExecutor (class, public), CommandHandoffKitExecutor (class, public), __init__ (def, internal), _subprocess_env (def, internal), FusionBenchRunner (class, public), __init__ (def, internal), load_benchmark_tasks (def, public), join_run_records (def, public), join_handoffkit_records (def, public), skip_row (def, public), write_fusion_bench_jsonl (def, public), load_fusion_bench_jsonl (def, public), build_fusion_bench_report (def, public), score_fusion_bench_row (def, public), parse_handoffkit_records (def, public), _coerce_record (def, internal), _validate_contract_payload (def, internal), _records_by_schema (def, internal), _first_record_by_schema (def, internal), _assert_joined_task_matches (def, internal), _artifact_records_from_contracts (def, internal), _contract_payloads (def, internal), _first_contract_payload (def, internal), _first_raw_payload (def, internal), _failure_from_inspection (def, internal), _failure_from_handoff_records (def, internal), _first_contract_error (def, internal), _error_code (def, internal), _error_message (def, internal), _error_retryable (def, internal), _judge_parse_failed (def, internal), _cost_from_provider_metadata (def, internal), _latency_from_model_calls (def, internal), _provider_metadata_from_model_calls (def, internal), _model_ids_from_handoff_records (def, internal), _handoff_trace_id (def, internal), _handoff_output (def, internal), _optional_string (def, internal), _state_for_handoff_status (def, internal), _row_is_skipped (def, internal), _row_is_failed (def, internal), _harness_verification_outcome (def, internal), _score_by_task_record (def, internal), _candidate_scores (def, internal), _candidate_model_id (def, internal), _expected (def, internal), _json_key_score (def, internal), _tool_call_validity (def, internal), _regret (def, internal), _tool_success (def, internal), _candidate_failure_rate (def, internal), _aggregate_metrics (def, internal), _average_metric (def, internal), _average (def, internal), _failure_correlations (def, internal), _pearson (def, internal), _pareto_points (def, internal), _reproducibility_metadata (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_compound.py`: ModelRate (class, public), CompoundComparison (class, public), _is_pass (def, internal), _fused_pass (def, internal), _rate (def, internal), compare_compound_vs_individual (def, public), _oracle_regret (def, internal), format_compound_comparison_markdown (def, public), _fmt (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_hillclimb.py`: BestSingle (class, public), ClimbDiagnosis (class, public), TargetCheck (class, public), ClimbResult (class, public), best_single_baseline (def, public), diagnose_bank (def, public), check_target (def, public), _mean_failure_correlation (def, internal), _pearson (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_reports.py`: write_fusion_bench_report_jsonl (def, public), write_fusion_bench_markdown_report (def, public), format_fusion_bench_markdown_report (def, public), write_fusion_bench_html_report (def, public), format_fusion_bench_html_report (def, public), _ensure_report (def, internal), _write_report_record (def, internal), _format_pareto_table (def, internal), _format_metric (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/gateway_target.py`: GatewayTarget (class, public), normalized_base_url (def, public), path (def, public), endpoint_url (def, public), is_fusion_alias (def, public), runner_env (def, public), default_dialect_for_runner (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/livecodebench_data.py`: _log (def, internal), load_manifest (def, public), load_problems (def, public), _select_from_manifest (def, internal), _select_recent (def, internal), decode_tests (def, public), decode_public_private (def, public), prepare_tasks (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/pareto.py`: ParetoPoint (class, public), find_pareto_front (def, public), load_points (def, public), write_pareto_report (def, public), format_pareto_markdown (def, public), _dominates (def, internal), _format_optional (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/polyglot.py`: LanguageSpec (class, public), PolyglotExercise (class, public), _read (def, internal), _instructions (def, internal), _primary_solution (def, internal), load_polyglot_exercises (def, public), build_prompt (def, public), _scrubbed_env (def, internal), PolyglotRun (class, public), run_polyglot (def, public), _bank_log (def, internal), _task_cache_path (def, internal), _load_cached (def, internal), _save_cached (def, internal), polyglot_verifier (def, public), verify (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/prompt_tuning.py`: PromptVariant (class, public), to_overrides (def, public), with_role (def, public), role_text (def, public), hash (def, public), TaskSplit (class, public), PerTaskResult (class, public), PromptEval (class, public), McNemarResult (class, public), TrialRecord (class, public), TuningResult (class, public), select_decision_tasks (def, public), regression_guard_tasks (def, public), split_dev_val (def, public), TunerRuntime (class, public), __init__ (def, internal), verify (def, public), _sampling_hash (def, internal), _cache_path (def, internal), mcnemar (def, public), FailureExemplar (class, public), PromptProposer (class, public), StubProposer (class, public), __init__ (def, internal), LLMProposer (class, public), __init__ (def, internal), _collect_failures (def, internal), _optimizer_user_prompt (def, internal), _strip_fences (def, internal), _load_cached (def, internal), _save_cached (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/provenance.py`: package_versions (def, public), hash_text (def, public), build_provenance (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/public_bench.py`: PublishedBaseline (class, public), PublicBenchmarkInfo (class, public), ExternalBenchmarkRequest (class, public), ExternalBenchmarkTaskRow (class, public), ExternalBenchmarkRun (class, public), ExternalBenchmarkUnavailable (class, public), ExternalBenchmarkError (class, public), ExternalBenchmarkExecutor (class, public), CommandExternalBenchmarkExecutor (class, public), __init__ (def, internal), _subprocess_env (def, internal), parse_external_run (def, public), baselines_for (def, public), best_baseline (def, public), panel_member_published_scores (def, public), panel_headroom_for_suite (def, public), assert_public_benchmark_registry (def, public), _unavailable_run (def, internal), _parse_task_row (def, internal), _as_int (def, internal), _as_float (def, internal), _as_str (def, internal), write_external_runs_jsonl (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/public_bench_report.py`: ComparisonBaselineRow (class, public), FailureCorrelationRow (class, public), BenchmarkComparison (class, public), build_benchmark_comparison (def, public), format_benchmark_comparison_markdown (def, public), write_benchmark_comparison_markdown (def, public), _measured_oracle_regret (def, internal), _failure_correlations (def, internal), _pearson (def, internal), _row_score (def, internal), format_comparisons_markdown (def, public), _fmt (def, internal), _fmt_cost (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/public_smoke.py`: PublicSmokeSuiteInfo (class, public), load_public_smoke_tasks (def, public), assert_public_smoke_matrix (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/sandbox.py`: SandboxResult (class, public), ok (def, public), SandboxUnavailable (class, public), Sandbox (class, public), run (def, public), LocalSandbox (class, public), __init__ (def, internal), scrubbed_env (def, public), _limit_setter (def, internal), set_limits (def, public), run (def, public), DockerSandbox (class, public), __init__ (def, internal), docker_command (def, public), run (def, public), SandboxConfig (class, public), build_sandbox (def, public), _read_capped (def, internal), _bytes_to_docker (def, internal)
- `python/fusionkit-evals/src/fusionkit_evals/schema.py`: EvalSample (class, public), EvalResult (class, public)
- `python/fusionkit-evals/src/fusionkit_evals/scorers.py`: exact_match (def, public), contains_expected (def, public)
- `python/fusionkit-evals/src/fusionkit_evals/tiny.py`: TinyBenchmarkTask (class, public), TinyBenchmarkMetrics (class, public), TinyBenchmarkResult (class, public), load_tiny_tasks (def, public), assert_tiny_task_matrix (def, public), score_tiny_output (def, public), write_tiny_jsonl (def, public), load_tiny_results (def, public), write_tiny_benchmark_report (def, public), format_tiny_benchmark_report (def, public), _score_by_task (def, internal), _expected (def, internal), _json_key_score (def, internal), _schema_validity (def, internal), _tool_call_validity (def, internal), _optional_run_id (def, internal), _average_metric (def, internal), _optional_float (def, internal), _format_metric (def, internal)

### `fusionkit-mlx`

- `python/fusionkit-mlx/src/fusionkit_mlx/launcher.py`: MlxServerCommand (class, public), argv (def, public), build_mlx_lm_server_command (def, public)

### `fusionkit-server`

- `python/fusionkit-server/src/fusionkit_server/app.py`: FusionToolExecutionOptions (class, public), FusionOptions (class, public), FusionRequest (class, public), TrajectoryItemInput (class, public), TrajectoryInput (class, public), FuseTrajectoriesRequest (class, public), create_app (def, public), _is_endpoint_model (def, internal), _request_sampling (def, internal), chunk (def, public), _sse_error_event (def, internal), _create_run_manager (def, internal), _create_run_payload (def, internal), _fusion_request_to_run_request (def, internal), _tool_policy_from_options (def, internal), _tool_execution_policy_from_options (def, internal), _chat_fusion_metadata (def, internal), _native_error_response (def, internal), _openai_native_error_response (def, internal), _openai_error_response (def, internal), _run_not_found_response (def, internal), _json_response (def, internal), _dump_optional (def, internal), _mode_from_request (def, internal), _coerce_message_content (def, internal), _to_chat_message (def, internal), _normalize_tools (def, internal), _normalize_tool_choice (def, internal), _tool_calls_payload (def, internal), _usage_dict (def, internal), _fusion_extension (def, internal), _openai_step_response (def, internal), _provider_error_response (def, internal), _status_for_category (def, internal), _openai_chat_response (def, internal)
- `python/fusionkit-server/src/fusionkit_server/openai_endpoint.py`: _to_chat_message (def, internal), _to_tools (def, internal), chunk (def, public), make_handler (def, public), Handler (class, public), log_message (def, public), _send_json (def, internal), do_GET (def, public), _serve_stream (def, internal), do_POST (def, public), build_endpoint (def, public), serve_single_endpoint (def, public)

### `uniroute`

- `python/uniroute/src/uniroute/demo.py`: MethodResult (class, public), __init__ (def, internal), add (def, public), _summary (def, internal), _qnc_summary (def, internal), run_trial (def, public), main (def, public)
- `python/uniroute/src/uniroute/evaluate.py`: DeferralCurve (class, public), __post_init__ (def, internal), quality_at (def, public), default_lambda_grid (def, public), pareto_clean (def, public), deferral_curve (def, public), zero_router_curve (def, public), area_under_curve (def, public), quality_neutral_cost (def, public), select_n_clusters (def, public)
- `python/uniroute/src/uniroute/kmeans.py`: KMeansResult (class, public), _squared_distances (def, internal), _kmeans_plus_plus (def, internal), kmeans (def, public), assign (def, public)
- `python/uniroute/src/uniroute/learned_map.py`: _augment (def, internal), _softmax (def, internal), _init_theta (def, internal), loss_and_grad (def, public), TrainingTrace (class, public), initial (def, public), final (def, public), UniRouteLearnedMap (class, public), __init__ (def, internal), centroids (def, public), theta (def, public), fit (def, public), _cluster_ids (def, internal), assignment (def, public), embed_llms (def, public), gamma (def, public), route (def, public)
- `python/uniroute/src/uniroute/routers.py`: route (def, public), cluster_error_embedding (def, public), UniRouteKMeans (class, public), __init__ (def, internal), centroids (def, public), fit (def, public), cluster_ids (def, public), assignment (def, public), embed_llms (def, public), gamma (def, public), route (def, public), KNNRouter (class, public), __init__ (def, internal), fit (def, public), gamma (def, public), route (def, public), ZeroRouterPlan (class, public), expected (def, public), ZeroRouter (class, public), __init__ (def, internal), fit (def, public), frontier (def, public), plan (def, public), sample (def, public)
- `python/uniroute/src/uniroute/synthetic.py`: SyntheticBenchmark (class, public), make_benchmark (def, public)
- `python/uniroute/src/uniroute/trials.py`: synthetic_trial_curves (def, public)

### `uniroute-mlx`

- `python/uniroute-mlx/src/uniroute_mlx/card.py`: CardModel (class, public), RouteDecision (class, public), RouterCard (class, public), n_clusters (def, public), psi_matrix (def, public), costs (def, public), cluster_weights (def, public), decide (def, public), build_card (def, public), save_card (def, public), load_card (def, public)
- `python/uniroute-mlx/src/uniroute_mlx/cli.py`: load_prompts (def, public), _embed_in_batches (def, internal), cmd_evaluate (def, public), _parse_cost_overrides (def, internal), cmd_fit (def, public), cmd_route (def, public), build_parser (def, public), main (def, public)
- `python/uniroute-mlx/src/uniroute_mlx/client.py`: EndpointError (class, public), ChatResult (class, public), _normalise_base_url (def, internal), OpenAICompatibleClient (class, public), __init__ (def, internal), _post (def, internal), _get (def, internal), chat (def, public), embed (def, public), models (def, public)
- `python/uniroute-mlx/src/uniroute_mlx/evaluate.py`: Example (class, public), Evaluation (class, public), error_rate (def, public), load_examples (def, public), score (def, public), evaluate_model (def, public), _eval_path (def, internal), save_evaluation (def, public), load_evaluations (def, public)

## How to use this index

Use this page as the coverage backstop. If a symbol appears here and is part of a public package entry point, it should be explained in the package reference or linked from a task guide. If a symbol is internal, it should be documented only when it affects protocol compatibility, persistence, security, release automation, or user-visible behavior.

