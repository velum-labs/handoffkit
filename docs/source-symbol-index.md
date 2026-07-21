# Source symbol index

This index is generated from current source by `pnpm docs:generate-code`. Do not edit it by hand. It lists exported top-level TypeScript declarations and top-level Python classes/functions; tests are intentionally excluded.

Use it with the narrative references when you need to find the module that owns a symbol. For comment-derived package entry-point documentation, see [Generated code API reference](generated/code-api.md).

## TypeScript exported declarations

### `packages/accounts`

- `packages/accounts/src/account-set.ts`: SubscriptionAccountSetOptions (type), RateLimitTracker (class), SubscriptionAccountSetExhaustedError (class), SubscriptionAccountSet (class)
- `packages/accounts/src/account-source.ts`: SubscriptionAccountSource (type), ResolvedSubscriptionAccounts (type), resolveSubscriptionAccounts (function)
- `packages/accounts/src/backend.ts`: SubscriptionAccountBackendOptions (type), SubscriptionAccountBackend (class)
- `packages/accounts/src/client.ts`: SubscriptionProxyClientOptions (type), SubscriptionProxyClient (class), SubscriptionProxyClientError (class)
- `packages/accounts/src/cliproxy.ts`: CLIPROXY_PINNED_VERSION (const), CLIPROXY_API_KEY_ENV (const), CLIPROXY_BASE_URL_ENV (const), CLIPROXY_HOME_ENV (const), cliproxyHome (function), cliproxyBaseUrl (function), cliproxyConfigPath (function), cliproxyBinaryPath (function), cliproxyAssetName (function), cliproxyApiKey (function), ensureCliproxyConfig (function), CliproxyInstallResult (type), installCliproxy (function), CLIPROXY_LOGIN_FLAGS (const), runCliproxyLogin (function), spawnCliproxy (function), CliproxyStatus (type), cliproxyStatus (function)
- `packages/accounts/src/codex-relay.ts`: CodexCatalogEntry (type), ProviderRelayLogger (type), CodexStockEntry (type), CodexRelayOptions (type), CodexRelayAuthSource (type), CodexRelayAuth (type), codexRelayAuth (function), CodexBackendRelay (class)
- `packages/accounts/src/credentials.ts`: defaultSubscriptionAccountDirectory (function), defaultSubscriptionCredentialPath (function), loadSubscriptionCredential (function), persistSubscriptionCredential (function), sanitizeSubscriptionLabel (function), enrollCurrentSubscription (function), RemoveSubscriptionAccountResult (type), removeSubscriptionAccount (function), subscriptionCredentialLabel (function)
- `packages/accounts/src/gateway.ts`: SubscriptionAccountConfigs (type), OpenSubscriptionRelaysOptions (type), OpenSubscriptionRelaysResult (type), SubscriptionAccountSets (type), openSubscriptionAccountSets (function), subscriptionRelaysFromAccountSets (function), openSubscriptionRelays (function)
- `packages/accounts/src/provider.ts`: AdminUsageRange (type), AdminUsageCost (type), SubscriptionProvider (type), canonicalRateLimitWindowKey (function), codexModelsSearch (function), subscriptionProvider (function)
- `packages/accounts/src/proxy.ts`: StartSubscriptionProxyOptions (type), SubscriptionProxy (type), NoSubscriptionAccountsError (class), startSubscriptionProxy (function)
- `packages/accounts/src/relay.ts`: SubscriptionRelayDialect (type), SubscriptionRelay (type), forwardRelayHeaders (function), AnthropicRelayOptions (type), RelayOnlyBackend (class), AnthropicBackendRelay (class)
- `packages/accounts/src/types.ts`: SubscriptionSelectionStrategy (type), RateLimitObservationSource (type), SubscriptionCredential (type), RateLimitWindow (type), CreditSnapshot (type), AccountLimits (type), SubscriptionFailure (type), SubscriptionMemberStatus (type), SubscriptionAccountSetSnapshot (type)
- `packages/accounts/src/usage.ts`: DEFAULT_SUBSCRIPTION_USAGE_REFRESH_MS (const), SubscriptionUsageSource (type), collectSubscriptionUsage (function), openLocalSubscriptionUsage (function)
- `packages/accounts/src/wire.ts`: SUBSCRIPTION_USAGE_PATH (const), subscriptionUsageResponseSchema (const), SubscriptionUsageResponse (type), snapshotsToUsage (function)

### `packages/adapter-ai-sdk`

- `packages/adapter-ai-sdk/src/managed-server.ts`: ManagedServerEvent (type), ManagedServerStatus (type), ManagedModelServerOptions (type), ManagedModelServer (class), managedModelServer (function), MlxServerOptions (type), mlxServer (function)
- `packages/adapter-ai-sdk/src/mlx-env.ts`: MLX_LM_PIN (const), MLX_LM_STRUCTURED_PIN (const), PYTHON_PIN (const), defaultMlxDir (function), MlxEnvManifest (type), SpawnSpec (type), LocalModelInfo (type), DownloadProgress (type), ProvisionEvent (type), MlxCapabilityError (class), MlxEnvOptions (type), MlxEnv (class)
- `packages/adapter-ai-sdk/src/mlx-helper-source.ts`: MLX_HELPER_PY (const)
- `packages/adapter-ai-sdk/src/worktree-agent.ts`: TrajectoryStepType (type), TrajectoryStep (type), WorktreeAgentResult (type), WorktreeAgentInput (type), runWorktreeCommand (function), runWorktreeAgent (function), worktreeDiff (function)

### `packages/cli-core`

- `packages/cli-core/src/completion.ts`: COMPLETION_SHELLS (const), CompletionShell (type), CompletionWalk (type), CompletionValueProvider (type), isCompletionShell (function), visibleCommandNames (function), visibleLongFlags (function), filterCompletionCandidates (function), walkCompletionTree (function), completionCandidates (function), completionScript (function), registerCompletion (function)
- `packages/cli-core/src/context.ts`: GlobalFlags (type), CommandContext (type), isJsonMode (function), resetContextForTest (function), emitJson (function), contextFor (function), attachGlobalFlags (function)
- `packages/cli-core/src/errors.ts`: CliErrorInput (type), CliError (class), cliErrorPayload (function), renderCliError (function), fail (function)
- `packages/cli-core/src/flags.ts`: levenshtein (function), knownLongFlags (function), findFlagTypos (function), warnPassthroughTypos (function)
- `packages/cli-core/src/options.ts`: collect (function), parseIdValue (function), parsePort (function), parsePositiveNumber (function), parsePositiveInteger (function)
- `packages/cli-core/src/pickers.ts`: canPickInteractively (function), argOrPick (function)
- `packages/cli-core/src/testing.ts`: CliTestResult (type), runCliForTest (function), withEnvironment (function)
- `packages/cli-core/src/version.ts`: readPackageVersion (function), probeBinaryVersion (function), formatPackageVersion (function)

### `packages/cli-ui`

- `packages/cli-ui/src/format.ts`: formatBytes (function), formatEta (function), relativeTime (function), timeUntil (function), middleEllipsis (function), wrapText (function), contentWidth (function)
- `packages/cli-ui/src/fuzzy.ts`: FuzzyMatch (type), fuzzyMatch (function), FuzzyResult (type), fuzzyFilter (function)
- `packages/cli-ui/src/index.ts`: createPresenter (function)
- `packages/cli-ui/src/ink/store.ts`: Store (class)
- `packages/cli-ui/src/plain.ts`: renderTableLines (function), renderErrorPanelLines (function), renderKeyValueLines (function), PlainPresenter (class)
- `packages/cli-ui/src/presenter.ts`: StepStatus (type), StepInput (type), ChecklistController (type), TaskController (type), ProgressUpdate (type), ProgressController (type), LiveFrameContent (type), LiveFrameController (type), KeyValueRow (type), TableOptions (type), ErrorPanelInput (type), StatusKind (type), Presenter (interface), withTask (function), WatchOptions (type), watch (function)
- `packages/cli-ui/src/runtime.ts`: isCI (function), uiStream (function), forceNonInteractive (function), isInteractive (function), canPromptInteractively (function)
- `packages/cli-ui/src/theme.ts`: supportsColor (function), supportsUnicode (function), bold (const), dim (const), italic (const), underline (const), red (const), green (const), yellow (const), blue (const), magenta (const), cyan (const), gray (const), glyph (const), SPINNER_FRAMES (const), BrandOptions (type), configureBrand (function), brandHeader (function), stripAnsi (function), visibleWidth (function), wrapAnsi (function), BoxTone (type), box (function), gradient (function), brandBanner (function)
- `packages/cli-ui/src/wizard.ts`: WizardStep (type), runWizard (function)

### `packages/cli`

- `packages/cli/src/cli.ts`: buildProgram (function)
- `packages/cli/src/commands/complete.ts`: completionCandidates (function), registerComplete (function)
- `packages/cli/src/commands/completion.ts`: registerCompletion (function)
- `packages/cli/src/commands/config.ts`: settableConfigPaths (function), registerConfig (function)
- `packages/cli/src/commands/doctor.ts`: registerDoctor (function)
- `packages/cli/src/commands/ensemble-config.ts`: registerEnsembleConfig (function), ensembleConfigPath (function)
- `packages/cli/src/commands/ensemble.ts`: registerEnsemble (function)
- `packages/cli/src/commands/fusion.ts`: registerFusion (function)
- `packages/cli/src/commands/models.ts`: provisionMlxRuntime (function), registerModels (function)
- `packages/cli/src/commands/palette.ts`: PaletteAction (type), registerPaletteAction (function), paletteActions (function), configuredDefaultToolArgv (function), runCommandPalette (function)
- `packages/cli/src/commands/prompts.ts`: registerPrompts (function)
- `packages/cli/src/commands/sessions.ts`: resolveSessionId (function), registerSessions (function)
- `packages/cli/src/commands/setup.ts`: registerSetup (function)
- `packages/cli/src/commands/stop.ts`: runFusionStop (function), registerStop (function)
- `packages/cli/src/commands/telemetry.ts`: registerTelemetry (function)
- `packages/cli/src/commands/version.ts`: registerVersion (function)
- `packages/cli/src/dashboard.ts`: HarnessCapabilityTarget (type), HarnessAvailability (type), HarnessLiveSmokeTarget (type), HarnessSmokePurpose (type), HarnessAdapterReadiness (type), HarnessCapabilityMatrixRow (type), HarnessCapabilityMatrix (type), HarnessSmokeOutcome (type), HarnessSmokeRecord (type), HarnessSmokeDashboard (type), HarnessSmokeDashboardOptions (type), createHarnessCapabilityMatrix (function), runHarnessSmokeDashboard (function), harnessDashboard (const)
- `packages/cli/src/fusion-init.ts`: InitOverwriteResolution (type), resolveInitOverwrite (function), runFusionInit (function)
- `packages/cli/src/fusion-quickstart.ts`: FUSION_TOOLS (const), fusionAgentProfiles (function), fusionToolLaunchSpec (function), runFusion (function), toolSelectOptions (function)
- `packages/cli/src/fusion/boot-view.ts`: BootView (type), BootServer (type), createBootView (function)
- `packages/cli/src/fusion/catalog.ts`: CatalogModel (type), catalogCachePath (function), cachedCatalog (function), refreshCatalog (function), catalogFor (function)
- `packages/cli/src/fusion/config-store.ts`: ConfigShape (type), repoRootFor (function), loadConfigOrFail (function), persistedShape (function), shapeEnsembles (function), validateAndWrite (function)
- `packages/cli/src/fusion/effective-config.ts`: Provenance (type), DEFAULT_TOOL (const), DEFAULT_OBSERVE (const), DEFAULT_ON_RATE_LIMIT (const), DEFAULT_PORTLESS (const), DEFAULT_REASONING (const), EffectiveEnsemble (type), EffectiveOverrides (type), EffectiveFusionConfig (type), configDefaultEnsembleName (function), resolveEffectiveConfig (function)
- `packages/cli/src/fusion/env.ts`: EnsembleRunSpec (type), RunFusionOptions (type), StackEvent (type), StackReporter (type), FUSIONKIT_PYPI_VERSION (const), fusionkitPyCommand (function), fusionkitWarmArgv (function), gitToplevel (function)
- `packages/cli/src/fusion/gateway-log.ts`: setGatewayChatter (function), gatewayChatterEnabled (function), logTurnStart (function), candidateFailureReason (function), logTurnCandidates (function), logTurnFailed (function), requestLogGatewayLogger (const), logServing (function), logRequestStart (function), logRequestDone (function)
- `packages/cli/src/fusion/local-catalog.ts`: ModelRole (type), LocalCatalogEntry (type), LOCAL_CATALOG (const), HostInfo (type), detectHost (function), USABLE_RAM_FRACTION (const), usableRamGB (function), fits (function), affordable (function), CatalogRecommendation (type), recommendFor (function), defaultTrioFor (function), catalogEntry (function), LOCAL_CATALOG_REPOS (const)
- `packages/cli/src/fusion/mlx.ts`: ownedMlxEnv (function)
- `packages/cli/src/fusion/model-sizing.ts`: KV_CONTEXT_TOKENS (const), SizingSource (type), ModelSizing (type), sumSafetensorBytes (function), kvCacheBytes (function), requiredGBFrom (function), EstimateOptions (type), clearSizingCacheForTests (function), estimateModelSizing (function)
- `packages/cli/src/fusion/observability.ts`: scopeDashboardPort (function), findScopeAppDir (function), bundledScopeServer (function), SCOPE_BUNDLED_IDENTITY (const), SCOPE_DEV_SERVER_IDENTITY (const), scopeSourceIdentity (function), expectedScopeIdentity (function), openUrl (function), Observability (type), startObservability (function)
- `packages/cli/src/fusion/platform.ts`: CapabilityLine (type), localPanelUnsupportedMessage (function), platformCapabilities (function)
- `packages/cli/src/fusion/prompts.ts`: fetchDefaultPrompts (function)
- `packages/cli/src/fusion/provision.ts`: ProvisionOutcome (type), engineCached (function), provisionFusionEngine (function), provisionEngineWithProgress (function)
- `packages/cli/src/fusion/stack.ts`: RouteKitConnection (type), FusionStack (type), StartFusionStackOptions (type), describeServerCrash (function), gatewayEnsembleConfigs (function), sidecarConfigYaml (function), sidecarEnvironment (function), startFusionStack (function), resolveRouterConfigPath (function)
- `packages/cli/src/gateway.ts`: GatewayEnsembleConfig (type), GatewayRunnerConfig (type), GatewayTurnStatus (type), setGatewayStatusSink (function), gatewaySetupSnippets (function), startFusionStepGateway (function), installRegistryAdapters (function)
- `packages/cli/src/package-version.ts`: readToolPackageVersion (function), VersionMatrix (type), collectVersionMatrix (function)
- `packages/cli/src/shared/options.ts`: parseBudget (function), parseK (function), isolationFlag (function), ON_RATE_LIMIT_MESSAGE (const), ON_RATE_LIMIT_OPTIONS (const), ON_RATE_LIMIT_POLICIES (const), parseOnRateLimit (function), PANEL_TRUST_MESSAGE (const), PANEL_TRUST_HELP (const), PANEL_TRUST_OPTIONS (const), PANEL_TRUST_LEVELS (const), parsePanelTrust (function)
- `packages/cli/src/shared/portless.ts`: stateDir (const), caCertPath (const), tld (const), detectProxy (function), CreateSessionInput (type), createPortlessSession (function), activeSession (function), reapService (function), reapFusionServices (function)
- `packages/cli/src/shared/preflight.ts`: PreflightError (class), hasBinary (function), INSTALL_HINTS (const), runPreflight (function)
- `packages/cli/src/telemetry/consent.ts`: TelemetryFile (type), TelemetryDecision (type), telemetryPath (function), resolveTelemetry (const), enableTelemetry (const), disableTelemetry (const), clearTelemetryFile (const)
- `packages/cli/src/telemetry/telemetry.ts`: TELEMETRY_DEFAULT_HOST (const), TELEMETRY_DEFAULT_PROJECT_KEY (const), telemetryProjectKey (function), telemetryHost (function), CliCommandEvent (type), FusionSessionEvent (type), InitTelemetryOptions (type), initTelemetry (function), captureCommand (function), shutdownTelemetry (function), pendingSessionEventsForTest (function), resetTelemetryForTest (function)

### `packages/config-core`

- `packages/config-core/src/index.ts`: ConfigSource (type), LayeredValue (type), resolveLayer (function), isRecord (function), readJson (function), readValidatedJson (function), writeJsonAtomic (function), loadMigratingConfig (function), editConfig (function)

### `packages/contracts`

- `packages/contracts/src/harness-event.ts`: HarnessApprovalDecision (type), HarnessRequestType (type), HarnessEventRaw (type), HarnessItemType (type), HarnessContentStream (type), HarnessTurnEndReason (type), HarnessTokenUsage (type), HarnessEvent (type), HarnessEventType (type)
- `packages/contracts/src/hash.ts`: SHA256_PREFIX (const), sha256Hex (function), sha256PrefixedHex (function), hashCanonical (function), hashCanonicalSha256 (function), requestHash (function), responseHash (function), artifactHash (function), schemaBundleHash (function)
- `packages/contracts/src/jcs.ts`: JsonValue (type), canonicalize (function)
- `packages/contracts/src/model.ts`: CapabilityStatus (type), ModelCallStatus (type), ModelCallSideEffects (type), ModelChatRole (type), ModelChatMessage (type), ModelUsage (type), ProviderErrorKind (type), ProviderError (type), ProviderFailureCategory (type), ProviderFailure (type), ProviderFailureError (class), isRetryableProviderFailure (function), parseRetryAfterSeconds (function), classifyProviderFailure (function), ModelEndpoint (type), ModelCallContract (type)
- `packages/contracts/src/reasoning.ts`: ReasoningEffortOption (type), ReasoningCapabilityProvenance (type), ReasoningCapabilityStatus (type), ModelReasoningCapabilities (type), ReasoningSelection (type), resolveReasoningEffort (function)

### `packages/ensemble`

- `packages/ensemble/src/advanced-operators.ts`: EvidenceBundle (type), CandidateRef (type), RankMatrix (type), SelectedCandidate (type), RepairOutput (type), RouteDecision (type), DelegationResult (type), ReviewResult (type), TreeNodeValue (type), ArchitectureEvaluation (type), MergeRecipe (type), EvidenceSource (type), SignalCalibrator (type), CandidateSelector (type), CandidateRepairer (type), RepairPredicate (type), EvidenceSourceOperator (class), CalibrateSignalOperator (class), SchemaValidationOperator (class), PairRankOperator (class), SelectOperator (class), RepairOperator (class), GenFuserOperator (class), RouteOperator (class), DelegateOperator (class), ReviewOperator (class), TreeExpandOperator (class), TreeScoreOperator (class), ArchitectureEvaluateOperator (class), OfflineModelMergeOperator (class)
- `packages/ensemble/src/agent.ts`: AgentHarnessOptions (type), terminalProposalFromSteps (function), createAgentHarness (function)
- `packages/ensemble/src/artifacts.ts`: ArtifactStore (type), createArtifactStore (function)
- `packages/ensemble/src/candidate-trace.ts`: CandidateTraceContext (type), CandidateTraceInput (type), CandidateOutcome (type), CandidateTracer (type), traceCandidate (function)
- `packages/ensemble/src/command.ts`: COMMAND_DASHBOARD_CAPABILITIES (const), CommandHarnessEnvInput (type), CommandHarnessOptions (type), createCommandHarness (function)
- `packages/ensemble/src/cursorkit-path.ts`: CursorkitCli (type), resolveCursorkitCli (function)
- `packages/ensemble/src/driver-adapter.ts`: DriverModelRoute (type), DriverHarnessOptions (type), createDriverHarness (function), PanelDriver (type)
- `packages/ensemble/src/external-executor.ts`: FusionKitToolExecutionRequest (type), FusionKitToolExecutionBatch (type), FusionKitToolExecutionResult (type), FusionKitToolExecutionResponse (type), FusionKitToolExecutorServerOptions (type), FusionKitToolExecutorServer (type), FusionKitToolExecutorError (class), FusionKitToolExecutorClientError (class), FusionKitToolExecutorClient (class), executeFusionKitToolBatch (function), startFusionKitToolExecutorServer (function)
- `packages/ensemble/src/fusion-operators.ts`: ChatMessage (type), ModelGenerateRequest (type), ModelGenerateOutput (type), ModelClient (type), CandidateArtifactValue (type), PanelCandidate (type), PanelRunInput (type), PanelRunner (type), JudgeComparison (type), JudgeComparator (type), SynthesisOutput (type), Synthesizer (type), ModelGenerateOperator (class), PanelGenerateOperator (class), JudgeCompareOperator (class), SynthesizeOperator (class)
- `packages/ensemble/src/harness-factories.ts`: sideEffectsForHarness (function), harnessSupportsFiniteK (function), responseShapeFor (function), descriptorFor (function), runUnifiedHarnessE2E (function)
- `packages/ensemble/src/harness-kind-registry.ts`: setToolDriverRegistry (function), harnessKindForUnified (function), resolveToolAdapter (function), resolveToolDriverAdapter (function)
- `packages/ensemble/src/harness.ts`: EnsembleModel (type), TrajectoryStepType (type), TrajectoryStep (type), HarnessTrajectory (type), HarnessEndReason (type), CandidateIsolationKind (type), CandidateActualIsolationKind (type), CandidateIsolationNetworkPolicy (type), CandidateIsolationMountPolicy (type), CandidateIsolationSecretPolicy (type), CandidateContainerDriverInput (type), CandidateContainerDriverResult (type), CandidateContainerDriver (type), CandidateMicrovmProvider (type), CandidateMicrovmRuntimeMetadata (type), CandidateMicrovmDriverInput (type), CandidateMicrovmDriverResult (type), CandidateMicrovmDriver (type), CandidateIsolationConfig (type), CandidateHardeningMetadata (type), hardeningToJson (function), EnsembleRuntime (type), EnsembleJudge (type), EnsemblePolicy (type), VerificationProfile (type), HarnessCapabilities (type), HarnessArtifact (type), HarnessToolRecord (type), HarnessCandidateOutput (type), HarnessPrepareInput (type), HarnessRunInput (type), HarnessCollectInput (type), HarnessAdapter (type), ReviewEvidence (type), panelMemberPreamble (function), EnsembleDescriptor (type), EnsembleRunResult (type), EnsembleCandidateSummary (type), EnsembleRunSummary (type)
- `packages/ensemble/src/isolation.ts`: CandidateCommandIsolationInput (type), CandidateCommandIsolationResult (type), runCandidateCommandWithIsolation (function), createCliContainerDriver (function), secretAbsenceMetadata (function), secretValueHash (function)
- `packages/ensemble/src/judge.ts`: JudgeCandidateEvidence (type), JudgeInput (type), JudgePatch (type), JudgeSynthesisOutput (type), SynthesisFailureSummary (type), JudgeSynthesizer (type), MockJudgeSynthesizerOptions (type), createMockJudgeSynthesizer (function)
- `packages/ensemble/src/kernel-backend.ts`: KernelBackendOptions (type), KernelBackend (class)
- `packages/ensemble/src/kernel-gateway.ts`: KERNEL_FUSE_STEP_WORKFLOW (const), FuseStepTransport (type), createKernelFuseStepRunner (function)
- `packages/ensemble/src/kernel-helpers.ts`: CreateTaskArtifactInput (type), createTaskArtifact (function), defineOperator (function), taskFromInputs (function), candidateFromArtifact (function), candidatesFromInputs (function), artifactValue (function), firstArtifactByType (function), operatorSpec (function), consumeUsageFromOutput (function)
- `packages/ensemble/src/kernel.ts`: GraphNodeInput (type), KernelWorkflow (type), GraphBuilder (class), graph (function), refs (const), WorkflowFactory (type), registerWorkflow (function), getWorkflow (function), listWorkflows (function), runWorkflow (function)
- `packages/ensemble/src/legacy-workflows.ts`: LegacyArtifactTypes (const), LegacyRunEnsembleOperator (class), TrajectoryFuseRequest (type), PythonTrajectoryFuseOperator (class), EnsembleRunWorkflowInput (type), ensembleRunWorkflow (function), PythonTrajectoryFuseWorkflowInput (type), pythonTrajectoryFuseWorkflow (function), LegacyOperatorKinds (const)
- `packages/ensemble/src/mock.ts`: MOCK_DASHBOARD_CAPABILITIES (const), MOCK_DASHBOARD_IDENTITY (const), MockCandidateFixture (type), MockHarnessOptions (type), createMockHarness (function)
- `packages/ensemble/src/panel-orchestration.ts`: PANEL_CANDIDATE_CONTRACT (const), panelCandidateContract (function), buildPanelPrompt (function), createFusionKitJudgeSynthesizer (function), FusionPanelOptions (type), runFusionPanelWorkflow (function), runFusionPanels (function)
- `packages/ensemble/src/panel-propose.ts`: ProposalPanelOptions (type), runProposalPanels (function)
- `packages/ensemble/src/panel-round.ts`: PanelRoundOptions (type), runPanelRound (function)
- `packages/ensemble/src/provenance.ts`: PRODUCER (const), PRODUCER_VERSION (const), PRODUCER_GIT_SHA (const)
- `packages/ensemble/src/run.ts`: STRAGGLER_ABANDONED (const), settleWithStragglerGrace (function), runEnsembleLegacy (function), runEnsemble (function), ensemble (const)
- `packages/ensemble/src/schedulers.ts`: FixedLayerMoAScheduler (class), BestOfNScheduler (class), RankFuseScheduler (class), ExecutionSelectRepairScheduler (class), AdaptiveRouterScheduler (class), TreeSearchScheduler (class), AgenticDelegationScheduler (class), LearnedWorkflowPolicy (type), LearnedWorkflowScheduler (class), OfflineArchitectureSearchScheduler (class)
- `packages/ensemble/src/source-repo.ts`: deriveSourceRepo (function)
- `packages/ensemble/src/synthesis.ts`: SynthesisResult (type), RunSynthesisInput (type), runJudgeSynthesis (function)
- `packages/ensemble/src/tool-executor.ts`: ToolImplementation (type), ToolExecutor (type), createToolExecutor (function), registerDemoTools (function), sideEffectsForTool (function)
- `packages/ensemble/src/topology-spec.ts`: TopologySpec (type), ResolvedTopology (type), topology (function), topologyHash (function), resolveTopology (function)
- `packages/ensemble/src/unified-types.ts`: UnifiedHarnessKind (type), PanelTrust (type), FusedSubagentEnsemble (type), FusedSubagentAccess (type), ToolHarnessResolveOptions (type), ToolDriverRegistry (type), UnifiedHarnessMatrixResult (type), UnifiedHarnessE2EResult (type), CursorHarnessRunnerInput (type), CursorHarnessRunnerResult (type), UnifiedHarnessE2EOptions (type)
- `packages/ensemble/src/unified-url.ts`: normalizeFusionBackendUrl (function), chatCompletionsUrl (function)
- `packages/ensemble/src/workflows.ts`: DirectModelWorkflowInput (type), directModelWorkflow (function), PanelCaptureWorkflowInput (type), panelCaptureWorkflow (function), PanelJudgeSynthWorkflowInput (type), panelJudgeSynthWorkflow (function), RankFuseWorkflowInput (type), rankFuseWorkflow (function), ExecutionSelectRepairWorkflowInput (type), ExecutionSelectWorkflowInput (type), executionSelectWorkflow (function), executionSelectRepairWorkflow (function), registerBuiltInWorkflows (function)
- `packages/ensemble/src/worktree.ts`: CandidateWorktree (type), WorktreePlan (type), defaultOutputRoot (function), candidateId (function), createWorktreePlan (function), sealCandidateWorktree (function), cleanupCandidateWorktree (function), cleanupWorktreePlan (function), diffWorkspace (function), diffCandidateWorktree (function)

### `packages/example-utils`

- `packages/example-utils/src/manifest.ts`: DemoInfo (type), demoInfo (function), demoBanner (function)
- `packages/example-utils/src/mock-models.ts`: mockTextModel (function), mockToolThenTextModel (function)
- `packages/example-utils/src/models.ts`: LiveModels (type), MockModels (type), DemoModels (type), resolveDemoModels (function)
- `packages/example-utils/src/narrate.ts`: bold (const), dim (const), banner (function), step (function), detail (function), ok (function), expectedFailure (function), finale (function)

### `packages/fusion-config`

- `packages/fusion-config/src/index.ts`: FUSION_CONFIG_DIRNAME (const), FUSION_CONFIG_BASENAME (const), FUSION_PROMPTS_DIRNAME (const), FUSION_CONFIG_VERSION (const), DEFAULT_ENSEMBLE_NAME (const), FUSION_TOOLS (const), FusionTool (type), PROMPT_IDS (const), PromptId (type), PROMPT_CONFIG_KEY (const), PromptOverrides (type), OnRateLimitPolicy (type), PanelTrust (type), EmbeddedRouterConfig (type), ExternalRouterConfig (type), FusionRouterConfig (type), EnsembleConfig (type), FusionConfig (type), FusionConfigError (class), fusionConfigDir (function), fusionConfigPath (function), fusionPromptsDir (function), fusionPromptPath (function), validateEnsembleName (function), parseFusionConfig (function), readFusionPrompts (function), loadFusionConfig (function), persistedFusionConfig (function), writeFusionConfig (function), writeFusionPrompts (function)

### `packages/fusion-gateway`

- `packages/fusion-gateway/src/config.ts`: DEFAULT_MLX_MODEL (const), BackendConfig (type), resolveBackendConfig (function), createBackend (function)
- `packages/fusion-gateway/src/cost.ts`: LocalComputeUsage (type), LocalComputePricing (type), CostStage (type), TurnCost (type), CostLedgerEntry (type), SessionCost (type), estimateLocalComputeCost (function), localComputeFromLatency (function), meterTurn (function), meterCall (function), emptySessionCost (function), addTurnCost (function), addLedgerEntry (function), turnCostLine (function)
- `packages/fusion-gateway/src/frontdoor/narration-writer.ts`: ChatFn (type), ChatNarrationWriterOptions (type), createChatNarrationWriter (function)
- `packages/fusion-gateway/src/frontdoor/narration.ts`: ReasoningDeltaEvent (type), NarrationWriter (type), TurnNarration (type), sanitizeGist (function), DiffStat (type), diffStat (function), changedFiles (function), ProposedCall (type), terminalProposal (function), executedEvidence (function), renderProposal (function), proposalsAgree (function), NarratorBeat (type), CandidateFinish (type), JudgeCandidate (type), NarrationTrigger (type), NarratorState (type), createNarratorState (function), narrationBeat (function), TurnNarratorInput (type), createTurnNarrator (function), sseChunkHasPayload (function), mergeEventsWithNarration (function)
- `packages/fusion-gateway/src/frontdoor/operators.ts`: FrontdoorArtifactTypes (const), FrontdoorOperatorKinds (const), FrontdoorFuseError (class), FrontdoorPanelError (class), BudgetValue (type), RouteValue (type), FailoverValue (type), CandidateSetValue (type), frontdoorBudgetGateOperator (function), frontdoorBudgetStopOperator (function), frontdoorResolveModelOperator (function), frontdoorVendorProxyOperator (function), frontdoorPanelOperator (function), frontdoorFuseOperator (function), frontdoorStreamingFuseOperator (function), frontdoorFinalizeOperator (function)
- `packages/fusion-gateway/src/frontdoor/request.ts`: FUSION_FRONTDOOR_REQUEST_WORKFLOW (const), FrontdoorRequestScheduler (class), runFrontdoorRequest (function)
- `packages/fusion-gateway/src/frontdoor/sse.ts`: EventsToSseOptions (type), eventsToSseResponse (function)
- `packages/fusion-gateway/src/frontdoor/types.ts`: FrontdoorChatBody (type), FRONTDOOR_SIGNAL (const), FrontdoorRequestValue (type), FrontdoorRoute (type), VendorProxyOutcome (type), FrontdoorServices (type)
- `packages/fusion-gateway/src/frontdoor/workflow.ts`: FUSION_FRONTDOOR_TURN_WORKFLOW (const), FrontdoorTurnOutcome (type), frontdoorRequestArtifact (function), runFusionFrontdoorTurn (function), streamFusionFrontdoorTurn (function)
- `packages/fusion-gateway/src/fusion-cost-meter.ts`: optionalString (function), trajectoryMetadata (function), trajectoryUsage (function), providerCostMetadata (function), usageWithProviderCost (function), providerCostFromPayload (function), providerCostFromSse (function), trajectoryLatencyMs (function), FusionCostMeterOptions (type), FusionCostMeter (class)
- `packages/fusion-gateway/src/fusion-failover.ts`: failoverNotice (function), resumeNotice (function), normalizeFailoverCategory (function), isFailoverWorthy (function), failureFromErrorObject (function), sseDataObjects (function), sseObjectError (function), sseObjectHasContent (function), sseEventError (function), firstSseSignal (function), rebuildErrorResponse (function)
- `packages/fusion-gateway/src/fusion-proxy.ts`: FusionBackend (class)
- `packages/fusion-gateway/src/fusion-session.ts`: DEFAULT_SESSION_TTL_MS (const), DEFAULT_PANEL_TIMEOUT_MS (const), DEFAULT_STEP_TIMEOUT_MS (const), PendingSessionWrites (class), InMemoryFusionBackendKernelStateStore (class), textOfContent (function), errorText (function), isHarnessNotification (function), hasUsableCandidates (function), FusionSessionManagerOptions (type), FusionSessionManager (class)
- `packages/fusion-gateway/src/fusion-turn.ts`: FusionTurnAssemblerOptions (type), FusionTurnAssembler (class)
- `packages/fusion-gateway/src/fusion-types.ts`: PassthroughModel (type), FusedModelRoute (type), ChatMessageLike (type), ChatBody (type), PanelRunInput (type), PanelRunner (type), FuseStepRunInput (type), FuseStepRunner (type), OnRateLimitPolicy (type), FailoverCategory (type), ProxyFailure (type), FailoverDecision (type), SessionMetaInput (type), FusionBackendOptions (type), FusionBackendKernelSessionState (type), FusionBackendKernelStateStore (type)
- `packages/fusion-gateway/src/fusion-vendor-proxy.ts`: FusionVendorProxyOptions (type), FusionVendorProxy (class)
- `packages/fusion-gateway/src/logger.ts`: FusionGatewayLogger (type), defaultFusionGatewayLogger (const)
- `packages/fusion-gateway/src/mlx-backend.ts`: MlxBackendOptions (type), withThinkingDefault (function), MlxBackend (class)
- `packages/fusion-gateway/src/provenance.ts`: toFusionModelCallRecord (function)
- `packages/fusion-gateway/src/request-context.ts`: PANEL_DEPTH_HEADER (const), parsePanelDepth (function), panelDepthFromRequest (function)
- `packages/fusion-gateway/src/session-lock.ts`: SessionLockManager (class)
- `packages/fusion-gateway/src/session-store.ts`: SessionTurnRecord (type), SessionMeta (type), PersistedSession (type), SessionSummary (type), SessionStore (interface), defaultSessionsDir (function), FileSystemSessionStoreOptions (type), FileSystemSessionStore (class), InMemorySessionStore (class)
- `packages/fusion-gateway/src/trajectory-capture.ts`: CapturedStep (type), CapturedTrajectory (type), reconstructTrajectory (function), TrajectoryCapture (type), createTrajectoryCapture (function)

### `packages/harness-core`

- `packages/harness-core/src/approvals.ts`: ApprovalDecision (type), HarnessRequestType (type), ApprovalPolicy (type), DEFAULT_AUTOMATION_APPROVAL_POLICY (const), decideApproval (function), Deferred (type), createDeferred (function), PendingRequest (type), PendingRequests (class)
- `packages/harness-core/src/channel.ts`: AsyncChannel (class)
- `packages/harness-core/src/contract.ts`: ResumeCursor (type), SessionTurnInput (type), SessionHandle (interface), StartSessionOptions (type), HarnessInstance (interface), DriverContext (type), HarnessDriver (interface), AnyHarnessDriver (type)
- `packages/harness-core/src/driver-factory.ts`: resolveDriverEnv (function), CliVersionProbeInput (type), probeCliVersion (function), CachedHarnessDriverInput (type), createCachedHarnessDriver (function)
- `packages/harness-core/src/errors.ts`: HARNESS_ERROR_CODES (const), HarnessErrorCode (type), HarnessErrorCategory (type), HarnessError (class), isRetryable (function), asHarnessError (function)
- `packages/harness-core/src/events.ts`: HarnessEvent (type)
- `packages/harness-core/src/kinds.ts`: HARNESS_KINDS (const), HarnessKind (type), isHarnessKind (function)
- `packages/harness-core/src/logging.ts`: EventLogOptions (type), EventLog (class)
- `packages/harness-core/src/registry.ts`: DriverRegistry (class)
- `packages/harness-core/src/status.ts`: HarnessAuthStatus (type), HarnessModelDescriptor (type), HarnessStatus (type), DEFAULT_STATUS_CACHE_DIR (const), readCachedStatus (function), writeCachedStatus (function), statusSkipReason (function)
- `packages/harness-core/src/stream-json.ts`: STREAM_JSON_MAX_TEXT (const), STREAM_JSON_MAX_TOOL_INPUT (const), StreamJsonStepText (type), StreamJsonEmitterOptions (type), ParseStreamJsonOptions (type), ParsedStreamJson (type), truncateStreamJsonText (function), asObject (function), asArray (function), asString (function), stringifyStreamJsonValue (function), streamJsonResultContentText (function), parseStreamJsonLine (function), createStreamJsonStepEmitter (function), parseStreamJsonTrajectory (function)
- `packages/harness-core/src/testing/contract-suite.ts`: DriverContractSuiteInput (type), driverContractSuite (function)
- `packages/harness-core/src/testing/mock-driver.ts`: mockDriverConfigSchema (const), MockDriverConfig (type), createMockDriver (function)
- `packages/harness-core/src/tmp-sweep.ts`: DEFAULT_TMP_MANIFEST (const), createTrackedTmpDir (function), releaseTrackedTmpDir (function), sweepTrackedTmpDirs (function)

### `packages/kernel`

- `packages/kernel/src/artifact-types.ts`: ArtifactTypes (const), ArtifactType (type), OperatorKinds (const), OperatorKind (type)
- `packages/kernel/src/budget.ts`: cloneBudgetLedger (function), costOf (function), budgetMessage (function), usageWithDefaults (function), isRetryable (function)
- `packages/kernel/src/engine.ts`: FusionRuntime (class)
- `packages/kernel/src/graph-utils.ts`: artifactRef (function), nodeRef (function), inputNodeIds (function), dependenciesFor (function), terminalNodeIds (function), nodesById (function), topoLayers (function), countOperatorKind (function), nodeOutputRefs (function)
- `packages/kernel/src/graph-validation.ts`: GraphValidationIssue (type), GraphExplanation (type), validateOperatorGraph (function), validateSchedulerGraph (function), assertValidOperatorGraph (function), explainGraph (function)
- `packages/kernel/src/outcome.ts`: createRuntimeReplayRecord (function), runtimeReplayRecordJson (function), buildOutcome (function)
- `packages/kernel/src/runtime-artifacts.ts`: deepFreeze (function), createArtifact (function)
- `packages/kernel/src/scheduling.ts`: DirectFastPathScheduler (class), StaticDAGScheduler (class)
- `packages/kernel/src/streaming.ts`: RuntimeRunInput (type), streamRuntime (function)
- `packages/kernel/src/types.ts`: ArtifactVisibility (type), ArtifactLeakage (type), OperatorSideEffects (type), RuntimeStatus (type), TaskSpec (type), CostEstimate (type), BudgetUsage (type), SignalDimension (type), SignalCalibration (type), Observation (type), Signal (type), RecordObservationInput (type), RecordSignalInput (type), Provenance (type), Artifact (type), OperatorSpec (type), RetryPolicy (type), CreateArtifactInput (type), OperatorRunContext (type), ObservationFilter (type), SignalFilter (type), Operator (type), RuntimeEvent (type), StreamingOperator (type), ArtifactInputRef (type), OperatorGraphNode (type), OperatorGraph (type), BudgetPolicy (type), BudgetLedger (type), TraceEventType (type), TraceEventInput (type), TraceEvent (type), RuntimeState (type), OutcomeRecord (type), SchedulerRunResult (type), SchedulerExecutionContext (type), Scheduler (type), RuntimeExecutionResult (type), KernelTurnState (type), KernelSessionState (type), KernelStateStore (type), InMemoryKernelStateStore (class), RuntimeExecutionError (class), RuntimeReplayRecord (type), BudgetExceededError (class), OperatorGraphError (class), RuntimeCancelledError (class)
- `packages/kernel/src/visibility.ts`: isPrivateLeakage (function), schedulerVisibleArtifact (function), schedulerVisibleObservation (function), schedulerVisibleSignal (function), maxLeakage (function)
- `packages/kernel/src/wire-artifacts.ts`: WireResponseValue (type), WireArtifactTypes (const), captureWireResponse (function)

### `packages/model-gateway`

- `packages/model-gateway/src/acp-agent.ts`: ACP_PROTOCOL_VERSION (const), AcpRunnerInput (type), AcpRunnerResult (type), AcpRunner (type), AcpAgentOptions (type), runAcpAgent (function)
- `packages/model-gateway/src/acp-registry.ts`: ACP_REGISTRY_URL (const), AcpRegistryAgent (type), AcpRegistry (type), AcpRegistryFetcher (type), InstalledAcpAdapter (type), fetchAcpRegistry (function), InstallAcpAdaptersOptions (type), installAcpAdapters (function)
- `packages/model-gateway/src/adapters/anthropic.ts`: AnthropicRequest (type), AnthropicTranslationOptions (type), anthropicToChat (function), mapStopReason (function), chatToAnthropicMessage (function), openAiSseToAnthropic (function), countTokensEstimate (function), handleAnthropicMessages (function), handleCountTokens (function), CLAUDE_ALIAS_PREFIX (const), ClaudePickerModelRoute (type), claudeModelAlias (function), resolveClaudeModelAlias (function), anthropicModelsResponse (function)
- `packages/model-gateway/src/adapters/chat.ts`: withDefaultModel (function), isStream (function), effectiveModel (function)
- `packages/model-gateway/src/adapters/cursor.ts`: isCursorChatBody (function), translateCursorRequest (function)
- `packages/model-gateway/src/adapters/dropped.ts`: DialectName (type), DIALECT_DROPPED_ATTRIBUTE (const), DroppedFieldSpan (type), withDroppedFieldSpan (function), droppedField (function), resetDroppedFieldWarnings (function)
- `packages/model-gateway/src/adapters/openai-chat-wire.ts`: OpenAiToolCall (type), AnthropicReasoningDetail (type), anthropicReasoningDetailsOf (function), AnthropicThinkingConfig (type), AnthropicRequestMetadata (type), ANTHROPIC_REQUEST_METADATA (const), ANTHROPIC_MESSAGE_CONTENT (const), REASONING_SELECTION (const), REASONING_SELECTION_ERROR (const), attachReasoningSelection (function), attachReasoningSelectionError (function), reasoningSelectionErrorOf (function), reasoningSelectionOf (function), AnthropicNativeContentBlock (type), OpenAiDelta (type), OpenAiChoice (type)
- `packages/model-gateway/src/adapters/responses-stream.ts`: openAiSseToResponses (function)
- `packages/model-gateway/src/adapters/responses.ts`: ResponsesRequest (type), ResponsesToolKind (type), ResponsesToolEntry (type), ResponsesToolRegistry (type), WEB_SEARCH_TOOL_NAME (const), ResponsesTranslationOptions (type), responsesToolRegistry (function), customToolNames (function), responsesToChat (function), chatToResponses (function), handleResponses (function)
- `packages/model-gateway/src/adapters/server-tool-loop.ts`: SERVER_TOOL_MARKER_FIELD (const), ServerToolMarker (type), serverToolMarkerOf (function), ExecutedSearch (type), ServerToolLoopEvent (type), ServerToolLoopOptions (type), BufferedLoopOutcome (type), runBufferedServerToolLoop (function), composeServerToolStream (function)
- `packages/model-gateway/src/adapters/upstream-error.ts`: unwrapUpstreamError (function)
- `packages/model-gateway/src/adapters/validate.ts`: WireRejection (type), validateChatRequest (function), validateAnthropicRequest (function), validateCountTokensRequest (function), validateResponsesRequest (function)
- `packages/model-gateway/src/adapters/web-search.ts`: WebSearchCitation (type), WebSearchOutcome (type), WebSearchExecutor (type), WebSearchDialect (type), MAX_WEB_SEARCHES_PER_TURN (const), resolveWebSearchExecutor (function)
- `packages/model-gateway/src/auth.ts`: timingSafeStringEqual (function), verifyBearerToken (function), authorizedRequest (function)
- `packages/model-gateway/src/backend.ts`: BackendModelRoute (type), Backend (type), BackendRequestOptions (type), OpenAiBackendOptions (type), joinPath (function), OpenAiBackend (class), ModelRoutedBackendOptions (type), ModelRoutedBackend (class)
- `packages/model-gateway/src/capacity-pool.ts`: CapacityPoolStrategy (type), CapacityPoolMember (type), CapacityLease (type), CapacityPoolOptions (type), CapacityPool (class)
- `packages/model-gateway/src/cost.ts`: ModelPricing (type), TokenUsage (type), ProviderCostMetadata (type), CallCostRecord (type), DEFAULT_MODEL_PRICING (const), parseUsage (function), parseUsageFromSse (function), lookupPricing (function), estimateCost (function), meterCall (function), formatUsd (function)
- `packages/model-gateway/src/endpoint-health.ts`: UrlEndpointConfig (type), AccountEndpointConfig (type), ModelEndpointConfig (type), EndpointHealthProbe (type), EndpointHealthProbePlan (type), EndpointHealthResult (type), providerAuthHeaders (function), endpointHealthProbe (function), probeEndpointHealth (function)
- `packages/model-gateway/src/provenance.ts`: GatewayDialect (type), MODEL_CALL_ID_HEADER (const), UNKNOWN_GIT_SHA (const), resolveProducerGitSha (function), readProducerVersion (function), ModelGatewayCallContext (type), ModelGatewayCallResult (type), ModelCallRecord (type), ProvenanceSink (type), buildModelCallRecord (function), modelCallId (function), responseBodyHash (function)
- `packages/model-gateway/src/provider-backends.ts`: ProviderBackendOptions (type), ProviderTransport (type), AnthropicBackend (class), GoogleGenAiBackend (class), CodexResponsesBackend (class)
- `packages/model-gateway/src/provider-source.ts`: API_PROVIDER_IDS (const), SUBSCRIPTION_PROVIDER_IDS (const), PROVIDER_IDS (const), ApiProviderId (type), SubscriptionProviderId (type), ProviderId (type), DiscoveredModel (type), ProviderSource (type), ProviderSourceTransport (type), parseReasoningCapabilities (function), parseDiscoveredModels (function), ApiProviderSourceOptions (type), ApiProviderSource (class)
- `packages/model-gateway/src/router.ts`: UnknownModelError (class), routerConfigSchema (const), ProviderPolicy (type), RouterConfig (type), normalizeRouterConfigAliases (function), splitNamespacedModel (function), parseRouterConfig (function), CatalogBackendOptions (type), CatalogBackend (class), isSubscriptionProvider (function)
- `packages/model-gateway/src/server.ts`: GatewayOptions (type), ProviderRelayDialect (type), ProviderRelay (type), Gateway (type), startGateway (function)
- `packages/model-gateway/src/sse-wire.ts`: noticeChunk (function), errorEvent (function), finishChunk (function), reasoningChunk (function), sseResponse (function)
- `packages/model-gateway/src/sse/chat-assembler.ts`: AssembledToolCall (type), AssembledTurn (type), ChatStreamAssembler (class)
- `packages/model-gateway/src/sse/parse.ts`: SseEvent (interface), SseParseError (class), decodeBufferedSse (function), SseDecoder (class)
- `packages/model-gateway/src/switching-proxy.ts`: SwitchingGatewayProxy (type), startSwitchingGatewayProxy (function)

### `packages/protocol`

- `packages/protocol/src/api.ts`: RunRequest (type), RunRequestInput (type), PolicyDecision (type), DisclosureReport (type), ClaimResult (type), RunView (type), RunSummary (type), RunnerSummary (type)
- `packages/protocol/src/chain.ts`: appendEvent (function), ChainVerification (type), verifyChain (function)
- `packages/protocol/src/constants.ts`: PROTOCOL_VERSIONS (const), MODEL_FUSION_SCHEMA_NAMES (const), KEY_ID_HEX_LENGTH (const)
- `packages/protocol/src/contract.ts`: contractHash (function), signContract (function), KeyResolver (type), verifyContractSignature (function)
- `packages/protocol/src/execution.ts`: ExecutionEnv (type), ExecutionLogPolicy (type), ExecutionSpec (type), defaultExecutionSpec (function), executionFromRunRequest (function)
- `packages/protocol/src/fusion-wire.ts`: WireTrajectory (type), isWireTrajectory (function), assertWireTrajectory (function), normalizeWireTrajectories (function)
- `packages/protocol/src/generated/model-fusion-openapi.ts`: MODEL_FUSION_OPENAPI_SOURCE_HASH (const), MODEL_FUSION_HARNESS_EXECUTOR_PATH (const), ModelFusionOpenApiPersistedJsonRecord (type), ModelFusionOpenApiArtifactRef (type), ModelFusionOpenApiHarnessExecutionRequest (type), ModelFusionOpenApiHarnessExecutionResult (type), ModelFusionOpenApiErrorResponse (type), ExecuteHarnessTaskClientOptions (type), executeHarnessTask (function)
- `packages/protocol/src/generated/trace-conventions.ts`: FUSION_SPAN_NAMES (const), FusionSpanName (type), FUSION_EVENT_NAMES (const), FusionEventName (type), ATTR (const), FusionAttributeKey (type), EXPORTABLE_ATTRIBUTES (const), FUSION_SCOPES (const), FUSION_CONVENTIONS_VERSION (const)
- `packages/protocol/src/keys.ts`: KeyPairPem (type), generateEd25519KeyPair (function), keyIdFromPublicPem (function), signData (function), verifyData (function)
- `packages/protocol/src/model-fusion.ts`: MODEL_FUSION_SCHEMA_NAMES (const), MODEL_FUSION_SCHEMA_BUNDLE_HASH (const), ModelFusionSchemaName (type), ModelFusionStatus (type), ModelFusionSideEffects (type), ModelFusionHarnessKind (type), ModelFusionCapabilityStatus (type), ModelFusionArtifactKind (type), ModelFusionRedactionStatus (type), ModelFusionErrorKind (type), ModelFusionChatRole (type), BenchmarkTaskKind (type), BenchmarkSourceRepo (type), BenchmarkScorerKind (type), JudgeSynthesisDecision (type), ContractMetadataV1 (type), ModelFusionChatMessage (type), ModelFusionUsage (type), ModelFusionError (type), ArtifactRef (type), ArtifactRefV1 (type), ModelCallRecordV1 (type), HarnessRunRequestV1 (type), HarnessRunResultV1 (type), HarnessCandidateRecordV1 (type), JudgeSynthesisRecordV1 (type), BenchmarkScorer (type), BenchmarkTaskRecordV1 (type), ToolCallPlanV1 (type), ToolExecutionRecordV1 (type), EnsembleReceiptV1 (type), ModelFusionRecordV1 (type), assertArtifactRefV1 (function), assertModelCallRecordV1 (function), assertHarnessRunRequestV1 (function), assertHarnessRunResultV1 (function), assertHarnessCandidateRecordV1 (function), assertJudgeSynthesisRecordV1 (function), assertBenchmarkTaskRecordV1 (function), assertToolCallPlanV1 (function), assertToolExecutionRecordV1 (function), assertEnsembleReceiptV1 (function), assertModelFusionRecord (function)
- `packages/protocol/src/panel-k.ts`: PanelMode (type), isProposalK (function), isFiniteK (function), isLookaheadK (function), panelModeForK (function)
- `packages/protocol/src/receipt-story.ts`: EventSummary (type), ReceiptStory (type), summarizeRunEvent (function), buildReceiptStory (function)
- `packages/protocol/src/receipt.ts`: signReceipt (function), verifyReceiptSignature (function), BundleVerification (type), RunnerReceiptVerificationInput (type), verifyRunnerReceipt (function), verifyReceiptBundle (function)
- `packages/protocol/src/tool-executor.ts`: ToolSideEffectClass (type), ToolExecutorMode (type), ToolPolicyDecision (type), ToolDefinition (type), ToolExecutorLimits (type), ToolExecutorBudget (type), ToolExecutorContract (type), ToolExecutionRequest (type), ToolExecutionResult (type), toolArgumentsHash (function), toolCallKey (function), modelFusionSideEffects (function), toolSideEffectClassFromModelFusion (function), evaluateToolPolicy (function)
- `packages/protocol/src/types.ts`: RunStatus (type), FailureClass (type), DisclosureMode (type), CheckpointTier (type), AttestationTier (type), SessionIsolation (type), AgentKind (type), AgentSpec (type), TaskSpec (type), RunnerSelector (type), ActorRef (type), KeyRef (type), Signature (type), ManifestFile (type), WorkspaceManifest (type), SecretClaim (type), NetworkPolicy (type), BudgetSpec (type), RunContract (type), DataClassRule (type), SecretScopeRule (type), ConsentRule (type), RetentionPolicy (type), Policy (type), ArtifactKind (type), RunEvent (type), ChainedEvent (type), RunnerIdentity (type), SecretReleaseRecord (type), NetworkAccessRecord (type), ModelUsageRecord (type), DisclosureRecord (type), Receipt (type), SemanticState (type), ToolCallRecord (type), ToolJournal (type), Checkpoint (type), HandoffSource (type), HandoffTargetRef (type), HandoffEnvelope (type), ContinuationRef (type), ReceiptBundle (type), PolicyDeniedError (class)
- `packages/protocol/src/validators.ts`: SECRET_NAME_PATTERN (const), POOL_NAME_PATTERN (const), WORKSPACE_RELATIVE_PATH_PATTERN (const), parseSecretName (function), parsePoolName (function), parseHostAllowlistEntry (function), parseWorkspaceManifestPath (function)
- `packages/protocol/src/vocabulary.ts`: RUN_STATUSES (const), TERMINAL_RUN_STATUSES (const), AGENT_KINDS (const), SESSION_ISOLATIONS (const), DISCLOSURE_MODES (const), CHECKPOINT_TIERS (const), ACTOR_KINDS (const), RUN_EVENT_TYPES (const), HEX_HASH_PATTERN (const), isTerminalStatus (function), isAgentKind (function)

### `packages/registry`

- `packages/registry/src/generated/data.ts`: FUSION_REGISTRY (const)
- `packages/registry/src/index.ts`: FUSION_PANEL_MODEL (const), DEFAULT_ENSEMBLE_NAME (const), FUSION_MODEL_ID_PREFIX (const), fusionModelId (function), CURSOR_BRIDGE_MODEL_NAME (const), LOCAL_MODEL_LABEL (const), FUSION_MODEL_ALIASES (const), FUSION_DEFAULT_ALIAS (const), FUSION_PANEL_ALIAS (const), FUSION_GATEWAY_DEFAULT_BASE_URL (const), FUSION_GATEWAY_API_KEY_ENV (const), CatalogPanelMember (type), BenchmarkPanelPreset (type), DEFAULT_CLOUD_PANEL_MEMBERS (const), BENCHMARK_PANEL_PRESETS (const)

### `packages/routekit-cli`

- `packages/routekit-cli/src/accounts.ts`: parseAccountMode (function), AccountListEntry (type), listAccounts (function), addAccount (function), ManagedAccountLoginInvocation (type), ManagedLoginKeychain (type), ManagedAccountLoginOptions (type), claudeProfileKeychainService (function), loginAccount (function), captureLoginCredential (function), removeAccount (function), AccountsStatus (type), accountsStatus (function), serveAccounts (function), stopAccounts (function)
- `packages/routekit-cli/src/catalog.ts`: LiveModel (type), LiveCatalog (type), fetchLiveCatalog (function)
- `packages/routekit-cli/src/cli.ts`: routekitVersion (function), buildProgram (function)
- `packages/routekit-cli/src/client.ts`: daemonDataTokenPath (function), ensureDaemonDataToken (function), daemonStore (function), readDaemonRecord (function), controlClientForRecord (function), daemonRecordHealthy (function), canonicalConfigOrMigrationError (function), daemonServeArgs (function), ensureDaemon (function), routekitClient (function), daemonLogPath (function), daemonLifecycleLockPath (function)
- `packages/routekit-cli/src/commands/accounts.ts`: registerAccounts (function)
- `packages/routekit-cli/src/commands/config.ts`: registerConfig (function)
- `packages/routekit-cli/src/commands/context.ts`: configOverride (function), editableConfigPath (function), loaded (function), numberOption (function)
- `packages/routekit-cli/src/commands/daemon.ts`: registerDaemon (function)
- `packages/routekit-cli/src/commands/doctor.ts`: registerDoctor (function)
- `packages/routekit-cli/src/commands/gateway-service.ts`: daemonSupervisorController (function), platformSupervisor (function), registerGatewayService (function), registerLogs (function)
- `packages/routekit-cli/src/commands/gateway.ts`: registerGateway (function)
- `packages/routekit-cli/src/commands/index.ts`: registerCommands (function)
- `packages/routekit-cli/src/commands/install.ts`: registerCodexIntegration (function)
- `packages/routekit-cli/src/commands/launchers.ts`: registerLaunchers (function)
- `packages/routekit-cli/src/commands/models.ts`: registerModels (function)
- `packages/routekit-cli/src/commands/providers.ts`: registerProviders (function)
- `packages/routekit-cli/src/commands/serve-options.ts`: GatewayServeCliOptions (type), DEFAULT_DRAIN_GRACE_SECONDS (const), attachServeOptions (function), drainGraceMs (function), serveArgvFrom (function)
- `packages/routekit-cli/src/commands/serve.ts`: registerServe (function)
- `packages/routekit-cli/src/commands/start.ts`: registerStart (function), registerRestart (function)
- `packages/routekit-cli/src/commands/status.ts`: RouteKitOverview (type), routeKitOverview (function), renderOverviewLines (function), registerStatus (function)
- `packages/routekit-cli/src/commands/stop.ts`: registerStop (function)
- `packages/routekit-cli/src/commands/telemetry.ts`: registerTelemetry (function)
- `packages/routekit-cli/src/commands/upgrade.ts`: argsWithPort (function), registerUpgrade (function)
- `packages/routekit-cli/src/commands/usage.ts`: openSubscriptionUsageSource (function), fetchSubscriptionUsage (function), registerUsage (function)
- `packages/routekit-cli/src/completion.ts`: completionCandidates (function), registerDynamicCompletion (function)
- `packages/routekit-cli/src/config.ts`: MigrationAction (type), ConfigMigrationDiagnostic (type), LegacyConfigMigration (type), convertLegacyRouterConfig (function), migrateLegacyRouterConfig (function), migrateLegacyState (function)
- `packages/routekit-cli/src/daemon.ts`: ROUTEKIT_PRODUCT (const), cliEntryPath (function), gatewayDaemonSpec (function), gatewayLogPath (function), serviceEnvironment (function), serviceEnvFilePath (function), writeServiceEnvFile (function), removeServiceEnvFile (function), daemonUnitSpec (function), gatewayUnitSpec (function)
- `packages/routekit-cli/src/launch.ts`: buildToolLaunchSpec (function), launchToolWithIntegration (function), launchTool (function)
- `packages/routekit-cli/src/serve.ts`: RouterServeOptions (type), RunningRouter (type), startRouter (function), waitForShutdown (function)
- `packages/routekit-cli/src/state.ts`: ServiceKind (type), RouteKitServiceRecord (type), routekitVersion (function), writeStateSnapshot (function), readStateSnapshot (function), readServiceRecord (function), ServiceRegistration (type), registerService (function), StopServiceResult (type), stopService (function)
- `packages/routekit-cli/src/telemetry.ts`: telemetryPath (function), resolveTelemetry (const), enableTelemetry (const), disableTelemetry (const), TELEMETRY_FIELDS (const)
- `packages/routekit-cli/src/update-notifier.ts`: notifyIfUpdateAvailable (function)
- `packages/routekit-cli/src/usage-format.ts`: formatUtilizationBar (function), formatResetCountdown (function), formatRateLimitWindowName (function), renderUsageLines (function), limitsSummary (function)

### `packages/routekit-config`

- `packages/routekit-config/src/index.ts`: RouterConfigSource (type), LoadedRouterConfig (type), RouterConfigPaths (type), UpdateRouterConfigInput (type), configuredProviderIds (function), missingModelIds (function), assertModelsAvailable (function), resolveModelId (function), selectModelId (const), routekitHome (function), globalRouterConfigPath (function), projectRouterConfigPath (function), findProjectRouterConfig (function), routerConfigPaths (function), parseRouterConfigDocument (function), loadRouterConfig (function), writeRouterConfig (function), updateEffectiveRouterConfig (function), updateRouterConfig (function), DEFAULT_ROUTER_CONFIG (const)

### `packages/routekit-control`

- `packages/routekit-control/src/index.ts`: ROUTEKIT_CONTROL_CAPABILITY (const), RouteKitControlMethod (type), RouteKitControlParams (type), DaemonStatus (type), ConfigSnapshot (type), ModelInfo (type), LaunchPreparation (type), RouteKitControlResults (type), RouteKitMethodHandler (type), RouteKitControlHandlers (type), MUTATING_ROUTEKIT_METHODS (const), validateRouteKitParams (function), createRouteKitControlHandler (function), RouteKitControlClient (class)

### `packages/routekit-daemon`

- `packages/routekit-daemon/src/index.ts`: ROUTEKIT_DAEMON_KIND (const), ROUTEKIT_PRODUCT (const), RouteKitDaemonOptions (type), RunningRouteKitDaemon (type), startRouteKitDaemon (function)

### `packages/routekit-registry`

- `packages/routekit-registry/src/generated/data.ts`: REGISTRY (const)
- `packages/routekit-registry/src/index.ts`: ProviderAuthStyle (type), ProviderKeyProbe (type), ProviderDiscovery (type), ProviderDiscoveryResponseShape (type), ProviderWireProtocol (type), ProviderWire (type), ProviderInfo (type), PROVIDERS (const), providerDefaultBaseUrl (function), defaultKeyEnv (function), providerKeyProbe (function), providerDiscovery (function), SubscriptionMode (type), SubscriptionOAuthInfo (type), SubscriptionRateLimitInfo (type), SubscriptionAdminInfo (type), SubscriptionInfo (type), SUBSCRIPTIONS (const), subscriptionInfo (function), providerForAuthMode (function), DEFAULT_REASONING_MODEL (const), catalogDefaultModel (function), curatedModels (function), smokeModelForTool (function), samplingOverridesForModel (function), chatTemplateKwargsForModel (function), RegistryModelPricing (type), PRICING_ALIASES (const), DEFAULT_MODEL_PRICING (const), LocalModelRole (type), LocalCatalogModel (type), LOCAL_CATALOG_ENTRIES (const), PreferredLocalModel (type), PREFERRED_LOCAL_MODELS (const), GATEWAY_DEFAULT_MLX_MODEL (const), LOCAL_PROBE_MODEL (const)

### `packages/routekit-router`

- `packages/routekit-router/src/index.ts`: StartRouterOptions (type), RunningRouter (type), startRouter (function)

### `packages/routekit-tracing`

- `packages/routekit-tracing/src/carrier.ts`: TraceCarrier (type), newTraceId (function), newSpanId (function), sessionCarrier (function), newSessionCarrier (function), contextOf (function), carrierOf (function), traceIdOf (function), carrierFromHeaders (function), headersOf (function), envOf (function), carrierFromEnv (function), withBaggage (function), baggageOf (function)
- `packages/routekit-tracing/src/exportable.ts`: AttributePolicy (type), toExportableSpan (function), toExportableEvent (function), PolicySpanExporter (class), PolicyLogExporter (class), isLoopbackOtlpEndpoint (function)
- `packages/routekit-tracing/src/listener.ts`: SpanListener (type), EventListener (type), addSpanListener (const), removeSpanListener (const), hasSpanListeners (const), addEventListener (const), removeEventListener (const), hasEventListeners (const), listenerSpanProcessor (const), listenerLogRecordProcessor (const)
- `packages/routekit-tracing/src/provider.ts`: InitTracingOptions (type), isTraceExportConfigured (const), isEventExportConfigured (const), initTracing (function), tracingServiceName (const), isTracingActive (const), flushTracing (function), shutdownTracing (function), resetTracingForTest (function)
- `packages/routekit-tracing/src/readable.ts`: ReadableEvent (type), AttributeSource (type), spanTraceId (const), spanId (const), attrStr (const), attrNum (const), attrBool (const), attrJson (function), spanEndMs (function), eventNameOf (const), eventTraceId (const), eventSpanId (const), eventTimeMs (const)

### `packages/runtime-utils`

- `packages/runtime-utils/src/cleanup.ts`: extendCleanupGrace (function), registerCleanup (function), runCleanups (function)
- `packages/runtime-utils/src/environment.ts`: commandOnPath (function), definedEnv (function), BuildChildEnvInput (type), buildChildEnv (function), DEFAULT_BRIDGE_SCRUB_PREFIXES (const), scrubBridgeEnv (function)
- `packages/runtime-utils/src/index.ts`: DEFAULT_RUNTIME_TIMEOUTS (const), defineTimeouts (function), MANAGED_SERVER_DEFAULTS (const), CANDIDATE_ISOLATION_DEFAULTS (const), sleep (function), randomId (function), estimateTokens (function), withDeadline (function), formatDurationMs (function), withTimeout (function), captureWorktreeDiff (function), ensureRunOutputDir (function), writeFileAtomic (function), FileLock (type), tryAcquireFileLock (function), ReservedPort (type), reservePort (function), freePort (function), CliCaptureOptions (type), CliCaptureResult (type), runCliCapture (function), spawnTool (function), LoggedSpawnOptions (type), LoggedChild (type), spawnLogged (function), distillLog (function), waitForHttp (function), waitForOutput (function), terminate (function), escapeMarkdownCell (function), markdownTable (function)
- `packages/runtime-utils/src/portless.ts`: RouteMapping (type), RouteStoreLike (type), PortlessModule (type), PortlessOptions (type), DetectedProxy (type), SpawnedService (type), DiscoverOrSpawnInput (type), DiscoverOrSpawnResult (type), PortlessSession (type), detectPortlessProxy (function), createActivePortlessSession (function), createPortlessSession (function), reapPortlessService (function), reapPortlessProject (function)
- `packages/runtime-utils/src/process.ts`: ExitInfo (type), Spawned (interface), SuperviseSpawnOptions (type), terminateGroup (function), superviseSpawn (function)
- `packages/runtime-utils/src/service/authority.ts`: LifecycleLock (type), acquireLifecycleLock (function), nextServiceGeneration (function)
- `packages/runtime-utils/src/service/control.ts`: CONTROL_PROTOCOL_VERSION (const), CONTROL_BODY_LIMIT_BYTES (const), ControlErrorCode (type), ControlError (class), ControlRequest (type), ControlSuccess (type), ControlFailure (type), ControlResponse (type), ControlEvent (type), ControlHandlerContext (type), ControlHandler (type), RunningControlServer (type), generateControlToken (function), controlTokenMatches (function), startControlServer (function), ControlClientOptions (type), ControlClient (class)
- `packages/runtime-utils/src/service/daemon.ts`: ServiceDaemonSpec (type), StartDaemonOptions (type), StartDaemonResult (type), serviceLogPath (function), rotateLogFile (function), readLogTail (function), waitForProcessExit (function), waitForServiceReady (function), startDaemon (function), StopDaemonResult (type), stopDaemonProcess (function)
- `packages/runtime-utils/src/service/records.ts`: ServiceSupervisorKind (type), SERVICE_SUPERVISOR_ENV (const), supervisorFromEnv (function), ServiceRecord (type), ServiceRecordInput (type), ServiceRecordStore (type), processAlive (function), createServiceRecordStore (function)
- `packages/runtime-utils/src/service/supervisors.ts`: CommandRunner (type), ServiceUnitSpec (type), SupervisorStatus (type), SupervisorController (type), supervisorOperationTimeoutMs (function), systemdUnitName (function), systemdUnitPath (function), systemdServiceUnit (function), launchdLabel (function), launchdPlistPath (function), launchdAgentPlist (function), supervisorController (function), DetectSupervisorOptions (type), detectSupervisor (function)
- `packages/runtime-utils/src/service/upgrade.ts`: UpgradeStrategy (type), planUpgrade (function), UpgradeDaemonInput (type), UpgradeDaemonResult (type), upgradeDetachedDaemon (function)
- `packages/runtime-utils/src/url.ts`: trimTrailingSlashes (function), trimSurroundingSlashes (function), normalizeApiBaseUrl (function), isLoopbackHost (function), assertAuthenticatedBind (function)

### `packages/telemetry-core`

- `packages/telemetry-core/src/index.ts`: ConsentFile (type), ConsentDecision (type), ConsentOptions (type), CLI_COMMAND_TELEMETRY_FIELDS (const), TelemetryFieldMap (type), telemetryStatusMetadata (function), createConsentManager (function), durationBucket (function), allowlistedProperties (function), anonymousEventProperties (function), boundedShutdown (function)

### `packages/testkit`

- `packages/testkit/src/behaviors.ts`: SimToolCall (type), SimError (type), SimBehavior (type), SimDialect (type), SimJournalEntry (type), SimBehaviorInput (type), asBehavior (function), simErrors (const)
- `packages/testkit/src/clis.ts`: CliRunResult (type), cliAvailable (function), cliSkip (function), claudeCodeEnv (function), runClaudeCode (function), codexExecConfigToml (function), runCodexExec (function), openCodeInvocation (function), runOpenCode (function)
- `packages/testkit/src/doors.ts`: DoorToolCall (type), DoorToolExchange (type), DoorRequestInput (type), DoorProfile (type), DOOR_PROFILES (const), callDoor (function), doorFrames (function)
- `packages/testkit/src/engine.ts`: EngineHandle (type), startEngine (function)
- `packages/testkit/src/proc.ts`: SpawnedProcess (type), spawnCaptured (function), waitForHttpReady (function)
- `packages/testkit/src/provider-sim.ts`: SimCallFilter (type), ProviderSimHandle (type), startProviderSim (function)
- `packages/testkit/src/python.ts`: repoRoot (function), StackTooling (type), detectStackTooling (function), stackToolingSkip (function), uvRunArgv (function)
- `packages/testkit/src/router-config.ts`: CODEX_TEST_TOKEN_ENV (const), SimModelSpec (type), simSidecarConfigYaml (function)
- `packages/testkit/src/scenarios.ts`: judgeAnalysis (function), FusedTurnScript (type), scriptFusedTurn (function)
- `packages/testkit/src/sse.ts`: SseFrame (type), parseSse (function), sseText (function), sseReasoning (function), sseDone (function)

### `packages/tool-claude`

- `packages/tool-claude/src/driver.ts`: claudeDriverConfigSchema (const), ClaudeDriverConfig (type), ClaudeQueryFn (type), ClaudeDriverOptions (type), createClaudeDriver (function)
- `packages/tool-claude/src/index.ts`: claudeTool (const)
- `packages/tool-claude/src/launch.ts`: claudeEnv (function), claudeAgentsJson (function), claudeLaunchArgs (function), launchClaude (function)

### `packages/tool-codex`

- `packages/tool-codex/src/driver.ts`: codexDriverConfigSchema (const), CodexDriverConfig (type), createCodexDriver (function)
- `packages/tool-codex/src/index.ts`: codexTool (const)
- `packages/tool-codex/src/install.ts`: CodexInstallProfile (type), CodexInstallOwner (type), CodexInstallInput (type), CodexInstallResult (type), codexIntegrationBlock (function), installCodexIntegration (function), uninstallCodexIntegration (function)
- `packages/tool-codex/src/launch.ts`: CodexModelPreset (type), isCodexConfigFailure (function), tomlKey (function), readCodexModelsCache (function), readCodexCatalogTemplate (function), codexAuthPath (function), hasCodexLogin (function), codexListedStockSlugs (function), codexCatalogEntries (function), codexModelCatalogJson (function), codexProfileFileToml (function), codexProfileFiles (function), CodexAgentRole (type), codexAgentRoles (function), codexAgentRoleToml (function), codexLaunchConfigToml (function), launchCodex (function)

### `packages/tool-cursor`

- `packages/tool-cursor/src/acp.ts`: CursorAcpProducerInput (type), buildCursorAcpProducer (function)
- `packages/tool-cursor/src/bridge-config.ts`: CURSOR_AGENT_TOOL_POLICY (const), CURSOR_AGENT_TOOL_MAX_ITERATIONS (const), CURSOR_BRIDGE_SCRUB_PREFIXES (const), CURSOR_IDE_SCRUB_PREFIXES (const), CursorBridgeModelEnvInput (type), CursorBridgeEnvInput (type), CursorBridgeModelDescriptor (type), CursorIdeModelsInput (type), cursorBridgeBaseUrl (function), cursorBridgeModelEnv (function), cursorBridgeEnv (function), cursorIdeEnv (function), cursorIdeModelsJson (function)
- `packages/tool-cursor/src/bridge.ts`: startCursorBridge (function)
- `packages/tool-cursor/src/cursorkit-path.ts`: CursorkitCli (type), resolveCursorkitCli (function)
- `packages/tool-cursor/src/driver.ts`: cursorDriverConfigSchema (const), CursorDriverConfig (type), createCursorDriver (function)
- `packages/tool-cursor/src/index.ts`: cursorTool (const)
- `packages/tool-cursor/src/launch.ts`: cursorIdeInstructions (function), cursorInstructions (function), launchCursor (function)
- `packages/tool-cursor/src/subagents.ts`: CURSOR_AGENTS_DIRNAME (const), cursorSubagentMarkdown (function), scaffoldCursorSubagents (function)

### `packages/tool-opencode`

- `packages/tool-opencode/src/driver.ts`: opencodeDriverConfigSchema (const), OpencodeDriverConfig (type), OpencodeTurnPart (type), OpencodeTurnResult (type), OpencodeBackend (interface), OpencodeBackendFactory (type), OpencodeDriverOptions (type), createOpencodeDriver (function)
- `packages/tool-opencode/src/index.ts`: opencodeTool (const)
- `packages/tool-opencode/src/launch.ts`: opencodeModelArg (function), opencodeProviderConfig (function), opencodeConfig (function), launchOpencode (function)

### `packages/tool-registry`

- `packages/tool-registry/src/index.ts`: toolIntegrations (const), toolRegistry (const)

### `packages/tools`

- `packages/tools/src/launch-context.ts`: ToolDisposer (type), DisposerRunner (type), createDisposerRunner (function), CreateToolLaunchContextInput (type), ToolLaunchContextHandle (type), createToolLaunchContext (function)
- `packages/tools/src/registry.ts`: ToolRegistry (type), createToolRegistry (function), ToolCapabilityCell (type), createToolCapabilityMatrix (function)
- `packages/tools/src/types.ts`: ToolModelFeature (type), ToolCapabilityGrade (type), ToolModelFeatureStatus (type), ToolModel (type), AgentProfile (type), ToolLaunchSpec (type), ToolLaunchContext (type), ToolDriverRoute (type), ToolDriverMetadata (type), ToolCapabilityMetadata (type), ToolIntegration (type)

### `packages/tracing`

- `packages/tracing/src/exportable.ts`: TRACE_REDACTED_ATTRIBUTE (const), toExportable (const), toExportableEvent (const), AllowlistSpanExporterOptions (type), AllowlistSpanExporter (class), AllowlistLogExporterOptions (type), AllowlistLogExporter (class)
- `packages/tracing/src/provider.ts`: InitFusionTracingOptions (type), initFusionTracing (function), fusionTracingServiceName (const), isFusionTracingActive (const)
- `packages/tracing/src/spans.ts`: FusionScope (type), FusionTraceCarrier (type), FusionBaggage (type), withFusionBaggage (function), fusionBaggageOf (function), jsonAttr (function), appendSpanListAttribute (function), FusionAttributes (type), emitFusionEvent (function), FusionSpan (type), startFusionSpan (function)

### `packages/workspace`

- `packages/workspace/src/git.ts`: GIT_MAX_BUFFER_BYTES (const), GitOptions (type), gitText (function), gitBinary (function)
- `packages/workspace/src/paths.ts`: WorkspaceRoot (type), WorkspaceRelativePath (type), parseWorkspaceRoot (function), parseWorkspaceRelativePath (function), resolveInsideWorkspace (function)
- `packages/workspace/src/workspace.ts`: PULL_BRANCH_PREFIX (const), DEFAULT_PULL_COMMITTER (const), DELETED_FILE_HASH (const), DEFAULT_DENY_PATTERNS (const), matchesPattern (function), CapturedWorkspace (type), CaptureOptions (type), captureWorkspace (function), BlobFetcher (type), materializeWorkspace (function), WorkspaceOutput (type), collectOutput (function), PullResult (type), PullOptions (type), pullRun (function)

### `legacy/packages/adapter-compute`

- `legacy/packages/adapter-compute/src/sandbox.ts`: GovernedComputeConfig (type), CommandResult (type), SandboxRunRecord (type), GovernedCompute (type), SandboxBinding (type), GovernedSandbox (class), governedCompute (function), withCompute (function)

### `legacy/packages/handoff`

- `legacy/packages/handoff/src/agents.ts`: agents (const)
- `legacy/packages/handoff/src/checkpoint-manager.ts`: HandoffCheckpointManager (class)
- `legacy/packages/handoff/src/defaults.ts`: DEFAULT_POLL_INTERVAL_MS (const), DEFAULT_WAIT_TIMEOUT_MS (const), DEFAULT_STREAM_TIMEOUT_MS (const), DEFAULT_ACTOR_ID (const), BLOB_UPLOAD_CONCURRENCY (const)
- `legacy/packages/handoff/src/handoff.ts`: HandoffConfig (type), ContinueOptions (type), ParallelOptions (type), defineHandoffConfig (function), HandoffInit (type), HandoffTraceEvent (type), ModelDecision (type), HandoffSummary (type), HandoffStreamEvent (type), Handoff (class), handoff (function)
- `legacy/packages/handoff/src/isolation.ts`: IsolationStrategy (type), branch (function)
- `legacy/packages/handoff/src/model.ts`: EscalationReason (type), HandoffModelConfig (type), HandoffModel (class), handoffModel (function), attachModel (function), withModel (function)
- `legacy/packages/handoff/src/policy.ts`: ContinuationPolicy (type), LocalFirstOptions (type), DEFAULT_MAX_PARALLEL_RUNS (const), DEFAULT_DISCLOSURE (const), localFirst (function), PlanningDecision (type), PlanInput (type), planContinuation (function)
- `legacy/packages/handoff/src/remote-tools.ts`: RemoteToolsConfig (type), RemoteToolsContextConfig (type), ShellToolInput (type), ShellToolOutput (type), RemoteToolCallRecord (type), RemoteToolSet (type), RemoteTools (type), remoteTools (function)
- `legacy/packages/handoff/src/review.ts`: ReviewStrategy (type), reviewStrategies (const), Scorecard (type), ReviewedRun (type), ReviewResult (type), scorecardFor (function), reviewRuns (function)
- `legacy/packages/handoff/src/routed-model.ts`: RouterCard (type), loadRouterCard (function), RouteDecision (type), RoutedModelConfig (type), RoutedModel (class), routedModel (function), withRoutedModel (function)
- `legacy/packages/handoff/src/run-executor.ts`: CommandHarnessConfig (type), createCommandContext (function), GovernedCommandOptions (type), GovernedCommandResult (type), GovernedRunRecord (type), toGovernedRunRecord (function), executeGovernedCommand (function)
- `legacy/packages/handoff/src/run.ts`: WaitOptions (type), WaitOutcome (type), HandoffRun (class)
- `legacy/packages/handoff/src/swarm-tools.ts`: SwarmPlane (type), SwarmToolsConfig (type), SwarmToolsContextConfig (type), WorkerTaskInput (type), DispatchInput (type), DispatchOutput (type), StatusInput (type), StatusOutput (type), PullInput (type), PullOutput (type), EscalateInput (type), EscalateOutput (type), SwarmToolSet (type), SwarmRunRecord (type), SwarmTools (type), swarmTools (function)
- `legacy/packages/handoff/src/targets.ts`: RuntimeTarget (type), targets (const)
- `legacy/packages/handoff/src/tool-journal.ts`: HandoffToolJournal (class)
- `legacy/packages/handoff/src/tools.ts`: ToolLike (type), ToolCallObservation (type), wrapTools (function)
- `legacy/packages/handoff/src/trace-log.ts`: HandoffTraceLog (class)
- `legacy/packages/handoff/src/triggers.ts`: Trigger (type), triggers (const), TriggerState (type), FiredTrigger (type), evaluateTriggers (function)

### `legacy/packages/plane`

- `legacy/packages/plane/src/auth.ts`: Principal (type), hashToken (function), toPrincipal (function), Capability (type), principalCan (function)
- `legacy/packages/plane/src/claim-token-service.ts`: ClaimTokenPayload (type), VerifiedClaimToken (type), ClaimTokenServiceOptions (type), ClaimTokenService (class)
- `legacy/packages/plane/src/contract-service.ts`: ContractServiceOptions (type), ContractService (class)
- `legacy/packages/plane/src/domain-errors.ts`: PlaneErrorCode (type), PlaneDomainError (class), badRequest (function), unauthorized (function), forbidden (function), notFound (function), conflict (function), capabilityMismatch (function), isPlaneDomainError (function)
- `legacy/packages/plane/src/idp.ts`: IdpConfig (type), VerifiedApproval (type), IdpVerifier (class)
- `legacy/packages/plane/src/keys.ts`: MasterKey (type), DEFAULT_MASTER_KEY_ENV (const), generateMasterKeyHex (function), masterKeyFromMaterial (function), resolveMasterKey (function), SealedBlob (type), seal (function), open (function), sealToFile (function), openFromFile (function), OrgKeyPair (type), KeyProvider (interface), FileKeyProvider (class)
- `legacy/packages/plane/src/logging.ts`: createLogger (function), Metrics (class)
- `legacy/packages/plane/src/plane.ts`: PlaneConfig (type), PlaneTuning (type), DEFAULT_PLANE_TUNING (const), IssuedPrincipal (type), Plane (class)
- `legacy/packages/plane/src/policy.ts`: PolicyRequest (type), evaluatePolicy (function), defaultPolicy (function)
- `legacy/packages/plane/src/ratelimit.ts`: RateLimitConfig (type), DEFAULT_RATE_LIMIT (const), RateLimiter (class)
- `legacy/packages/plane/src/receipt-service.ts`: ReceiptServiceConfig (type), ReceiptService (class)
- `legacy/packages/plane/src/retention.ts`: collectReferencedBlobs (function), RetentionResult (type), RetentionSweeper (class)
- `legacy/packages/plane/src/run-lifecycle.ts`: assertRunTransition (function)
- `legacy/packages/plane/src/secrets.ts`: SecretStore (class)
- `legacy/packages/plane/src/server.ts`: DEFAULT_MAX_BODY_BYTES (const), PlaneServerOptions (type), startPlaneServer (function)
- `legacy/packages/plane/src/sqlite-store.ts`: SqliteStoreOptions (type), SqliteStore (class)
- `legacy/packages/plane/src/store.ts`: RunRecord (type), ApprovalRecord (type), RunnerRecord (type), PrincipalRole (type), PRINCIPAL_ROLES (const), isPrincipalRole (function), PrincipalRecord (type), EnrollTokenRecord (type), RunSummaryRow (type), PlaneStore (interface), ContinuationRefOrUndefined (type)
- `legacy/packages/plane/src/validation.ts`: runRequestSchema (const), createRunBodySchema (const), enrollBodySchema (const), claimBodySchema (const), approveBodySchema (const), cancelBodySchema (const), eventsBodySchema (const), completeBodySchema (const), issuePrincipalBodySchema (const), ValidationError (class), parseBody (function)

### `legacy/packages/runner`

- `legacy/packages/runner/src/agents.ts`: AgentCommand (type), AgentContext (type), buildAgentCommand (function)
- `legacy/packages/runner/src/backend.ts`: SessionExecution (type), SessionBackendResult (type), SessionBackend (type)
- `legacy/packages/runner/src/egress.ts`: EgressEvent (type), EgressProxy (type), parseConnectAuthority (function), startEgressProxy (function)
- `legacy/packages/runner/src/execution.ts`: PreparedExecution (type), BackendExecutionKind (type), PrepareExecutionInput (type), DEFAULT_TIMEOUT_MS (const), resolveSessionEnv (function), executionSpecFor (function), prepareExecution (function), executionHash (function), requireShellExecution (function)
- `legacy/packages/runner/src/process-backend.ts`: ProcessSessionBackend (class)
- `legacy/packages/runner/src/runner.ts`: RunnerOptions (type), Runner (class)
- `legacy/packages/runner/src/session.ts`: SessionResult (type), runSession (function), CapabilityMismatchError (class)

### `legacy/packages/sdk`

- `legacy/packages/sdk/src/client.ts`: PlaneClientError (class), PlaneClient (class)

### `legacy/packages/session-harness`

- `legacy/packages/session-harness/src/auth.ts`: claudeCodeAuthFromEnv (function), piAuthFromEnv (function)
- `legacy/packages/session-harness/src/backend.ts`: HarnessAdapter (type), HarnessSandboxProvider (type), CreateHarnessInput (type), CreateSandboxProviderInput (type), HarnessBinding (type), isAgentRunFor (function), AiSdkHarnessBackend (class), HarnessSessionRun (type), runHarnessSession (function), harnessBackend (function)
- `legacy/packages/session-harness/src/claude-code.ts`: ClaudeCodeBindingOptions (type), isClaudeCodeAgentRun (function), claudeCodeBinding (function), AiSdkHarnessBackendOptions (type), aiSdkHarnessBackend (function)
- `legacy/packages/session-harness/src/pi.ts`: PiBindingOptions (type), isPiAgentRun (function), piBinding (function), PiHarnessBackendOptions (type), piHarnessBackend (function)
- `legacy/packages/session-harness/src/transcript.ts`: TranscriptLine (type), TranscriptRecorder (class)

### `legacy/packages/session-hermetic`

- `legacy/packages/session-hermetic/src/index.ts`: toJustBashNetwork (function), HermeticSessionBackend (class), hermeticBackend (function)

### `legacy/packages/session-vercel-sandbox`

- `legacy/packages/session-vercel-sandbox/src/index.ts`: VercelSandboxSource (type), VercelSandboxResources (type), VercelSandboxCreateInput (type), VercelSandboxInstance (type), VercelSandboxFactory (type), VercelSandboxOptions (type), SANDBOX_IGNORED_DIRS (const), shellQuote (function), listWorkspaceFiles (function), writeMirroredFile (function), VERCEL_SANDBOX_CREDENTIAL_ENVS (const), vercelCredentialsFromEnv (function), toVercelNetwork (function), VercelSandboxBackend (class), vercelSandboxBackend (function)

### `legacy/packages/testkit`

- `legacy/packages/testkit/src/index.ts`: git (function), RepoFixtureOptions (type), makeRepo (function), StackOptions (type), Stack (type), uploadWorkspace (function), mockRunRequest (function), withStackAndRepo (function), startStack (function)

## Python top-level symbols

### `python/fusionkit-cli`

- `python/fusionkit-cli/src/fusionkit_cli/main.py`: _distribution_version (function, internal), _version_callback (function, internal), main (function, public), serve (function, public), prompts_dump (function, public)

### `python/fusionkit-core`

- `python/fusionkit-core/src/fusionkit_core/_generated/trace_conventions.py`: ATTR (class, public)
- `python/fusionkit-core/src/fusionkit_core/artifacts.py`: hash_bytes (function, public), hash_text (function, public), _path_component (function, internal), _validate_suffix (function, internal), LocalArtifactStore (class, public)
- `python/fusionkit-core/src/fusionkit_core/clients.py`: build_clients (function, public)
- `python/fusionkit-core/src/fusionkit_core/config.py`: RunBudget (class, public), ContextPolicy (class, public), SamplingConfig (class, public), merge_sampling (function, public), PromptOverrides (class, public), FusionConfig (class, public), load_config (function, public), _apply_prompt_file_overrides (function, internal)
- `python/fusionkit-core/src/fusionkit_core/context.py`: estimate_tokens (function, public), estimate_messages_tokens (function, public), ContextBudget (class, public), TrajectoryPack (class, public), PackReport (class, public), _Entry (class, internal), _trajectory_cost (function, internal), _elide_middle (function, internal), _drop_items (function, internal), _over_budget (function, internal), _by_cost_desc (function, internal), pack_trajectories (function, public)
- `python/fusionkit-core/src/fusionkit_core/contracts.py`: ContractBaseModel (class, public), ContractMetadata (class, public), ContractRecord (class, public), ContractChatMessage (class, public), ContractUsage (class, public), ContractError (class, public), ContractSampling (class, public), ArtifactRefV1 (class, public), ContractArtifactRef (class, public), ModelCallRecordV1 (class, public), FusionRunRequestV1 (class, public), FusionRecordV1 (class, public), HarnessRunRequestV1 (class, public), HarnessRunResultV1 (class, public), HarnessCandidateRecordV1 (class, public), TrajectoryItem (class, public), TrajectorySynthesis (class, public), TrajectoryV1 (class, public), BenchmarkScorer (class, public), BenchmarkTaskRecordV1 (class, public), ToolCallPlanV1 (class, public), ToolExecutionRecordV1 (class, public), EnsembleReceiptV1 (class, public), schema_bundle_hash (function, public), producer (function, public), producer_version (function, public), _is_git_sha (function, internal), producer_git_sha (function, public), contract_metadata (function, public), contract_model_for_schema (function, public), status_for_run_state (function, public), _find_schema_dir (function, internal), _checkout_root (function, internal), _load_json (function, internal)
- `python/fusionkit-core/src/fusionkit_core/fake_client.py`: FakeModelClient (class, public)
- `python/fusionkit-core/src/fusionkit_core/fusion.py`: FusionEngine (class, public), normalize_messages (function, public), _trajectory_metrics (function, internal), _optional_int (function, internal)
- `python/fusionkit-core/src/fusionkit_core/judge.py`: warn_malformed_tool_calls (function, public), FuseResult (class, public), _TurnDiagnostics (class, internal), _PreparedTurn (class, internal), judge_synthesizer_for (function, public), JudgeSynthesizer (class, public), _degraded_analysis (function, internal), _StreamAccumulator (class, internal), accumulate_tool_call (function, public), parse_analysis (function, public), _consolidated_trajectory (function, internal), _synthesis_metrics (function, internal), _best_trajectory (function, internal), _trajectory_id_for_reason (function, internal), _rationale (function, internal), _judge_parse_status (function, internal), _judge_parse_failed (function, internal), _judge_unavailable (function, internal), _reasoning_line (function, internal), analysis_reasoning_markdown (function, public), _synthesis_id (function, internal), _last_user_text (function, internal), _extract_json (function, internal), _emit_judge (function, internal), _start_fuse_span (function, internal), _end_fuse_span (function, internal), _usage_payload (function, internal), panel_usage_from_trajectories (function, public), sum_usages (function, public)
- `python/fusionkit-core/src/fusionkit_core/kernel.py`: FusionKernel (class, public)
- `python/fusionkit-core/src/fusionkit_core/metrics.py`: RunRecord (class, public), JsonlRunLogger (class, public)
- `python/fusionkit-core/src/fusionkit_core/model_client.py`: ChatClient (class, public)
- `python/fusionkit-core/src/fusionkit_core/producers.py`: _reasoning_item (function, internal), trajectory_from_response (function, public), failed_trajectory (function, public), PanelExhaustedError (class, public), trajectory_to_contract (function, public), trajectory_from_contract (function, public), ToolExecutor (class, public), TrajectoryProducer (class, public), ChatTrajectoryProducer (class, public), ExternalTrajectoryProducer (class, public), AgentTrajectoryProducer (class, public)
- `python/fusionkit-core/src/fusionkit_core/prompts.py`: FusionIdentity (class, public), _truncate (function, internal), _format_item (function, internal), candidate_fence (function, public), _fence_open (function, internal), _fence_close (function, internal), fence_instruction (function, public), format_trajectories (function, public), build_judge_prompt (function, public), build_identity_block (function, public), build_judge_system (function, public), build_fuse_system (function, public)
- `python/fusionkit-core/src/fusionkit_core/registry.py`: fusion_mode_for_model (function, public)
- `python/fusionkit-core/src/fusionkit_core/routekit_client.py`: _chat_url (function, internal), _messages (function, internal), _tools (function, internal), _tool_choice (function, internal), _usage (function, internal), _int_or_none (function, internal), _tool_calls (function, internal), _reasoning (function, internal), _sse_data (function, internal), RouteKitClient (class, public)
- `python/fusionkit-core/src/fusionkit_core/router.py`: RouterDecision (class, public), FusionModeRouter (class, public)
- `python/fusionkit-core/src/fusionkit_core/run.py`: _BudgetExceededSignal (class, internal), FusionRunManager (class, public), make_id (function, public), canonical_json (function, public), hash_json (function, public), _request_from_events (function, internal), _runtime_messages (function, internal), _sampling_from_request (function, internal), _call_window (function, internal), _model_call_record (function, internal), _response_call_record (function, internal), _pending_tool_actions_from_events (function, internal), _budget_error (function, internal), _validate_tool_policy (function, internal), _policy_cache_key (function, internal), _trajectory_id_for_source (function, internal), _run_metrics (function, internal)
- `python/fusionkit-core/src/fusionkit_core/run_models.py`: RunBaseModel (class, public), NativeRunError (class, public), ToolExecutionPolicy (class, public), ToolPausePlaceholder (class, public), ToolResultSubmission (class, public), FusionRunEvent (class, public), IdempotencyRecord (class, public), CreateRunResult (class, public), RunStateSummary (class, public), TrajectoryInspection (class, public), RunUsage (class, public), RunInspection (class, public), RunEventPage (class, public), RunStore (class, public), ArtifactWriter (class, public)
- `python/fusionkit-core/src/fusionkit_core/run_store.py`: FileSystemRunStore (class, public), _read_json (function, internal), _write_json (function, internal), _artifact_from_payload (function, internal), _optional_str (function, internal), _latest_pending_action (function, internal), _sum_call_usages (function, internal), _dedupe_artifacts (function, internal)
- `python/fusionkit-core/src/fusionkit_core/trace.py`: is_tracing_configured (function, public), setup_fusion_tracing (function, public), shutdown_fusion_tracing (function, public), _JsonOtlpSpanExporter (class, internal), _JsonOtlpLogExporter (class, internal), _parse_otlp_headers (function, internal), _tracer (function, internal), _logger (function, internal), context_from_headers (function, public), candidate_baggage_of (function, public), json_attr (function, public), _compact (function, internal), emit_event (function, public), fusion_span (function, public), context_of_span (function, public), start_fusion_span (function, public), end_fusion_span (function, public)
- `python/fusionkit-core/src/fusionkit_core/types.py`: ToolCall (class, public), ChatMessage (class, public), Usage (class, public), CallMetrics (class, public), ModelResponse (class, public), StreamChunk (class, public), TrajectorySynthesis (class, public), Trajectory (class, public), FusionAnalysis (class, public), FusionResult (class, public)

### `python/fusionkit-evals`

- `python/fusionkit-evals/src/fusionkit_evals/adapters/aider_polyglot_adapter.py`: log (function, public), _root (function, internal), _languages (function, internal), cache_dir (function, public), panel_signature (function, public), cache_path (function, public), load_cached_row (function, public), save_cached_row (function, public), evaluate_exercise (function, public), _terminal_row (function, internal), main (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/adapters/lcb_select_adapter.py`: log (function, public), _temps (function, internal), cache_dir (function, public), signature (function, public), cache_path (function, public), load_cached (function, public), save_cached (function, public), _public_score (function, internal), _private_pass (function, internal), evaluate_problem (function, public), _generate_all (function, internal), _score_problem (function, internal), _terminal (function, internal), _resolve_checker (function, internal), main (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/adapters/livecodebench_adapter.py`: log (function, public), cache_dir (function, public), panel_signature (function, public), cache_path (function, public), load_cached_row (function, public), save_cached_row (function, public), artifacts_dir (function, public), _write_artifacts (function, internal), evaluate_problem (function, public), _terminal_row (function, internal), _score_result (function, internal), main (function, public), _resolve_checker_mode (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/bench_history.py`: BenchRunRecord (class, public), BenchDrift (class, public), append_run (function, public), load_runs (function, public), previous_comparable (function, public), drift_vs_previous (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/bench_runtime.py`: is_transient (function, public), classify_exception (function, public), retry_async (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/bench_verify.py`: SolutionRun (class, public), verify_solution (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/benchmark.py`: BenchmarkRunner (class, public), load_jsonl_samples (function, public), write_jsonl_results (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/benchmark_panel.py`: BenchmarkPanelMember (class, public), BenchmarkPanel (class, public), PanelHeadroom (class, public), estimate_panel_headroom (function, public), _panel_from_registry (function, internal), get_benchmark_panel (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/candidate_bank.py`: _log (function, internal), PreparedTask (class, public), BankCandidate (class, public), BankTask (class, public), CandidateBank (class, public), bank_signature (function, public), panel_model_ids (function, public), build_candidate_bank (function, public), _verify_candidates (function, internal), save_bank (function, public), load_bank (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/checkers.py`: normalize_lines (function, public), exact_check (function, public), token_check (function, public), case_insensitive_check (function, public), float_check (function, public), check_output (function, public), _as_float (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/cli.py`: run_eval (function, public), pareto (function, public), tiny_bench (function, public), fusion_bench (function, public), fusion_bench_report (function, public), public_bench (function, public), _fmt_ci (function, internal), _optional_str (function, internal), public_bench_baselines (function, public), tune_prompts (function, public), fusion_hillclimb (function, public), fusion_hillclimb_polyglot (function, public), _format_hillclimb_report (function, internal), _fmt_num (function, internal), _format_tuning_report (function, internal), _resolve_public_suite (function, internal), _write_fusion_bench_reports (function, internal), register (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/cli_shared.py`: benchmark_kernel (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/code_extract.py`: ExtractedCode (class, public), extract_code (function, public), extract_code_str (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/dirty_dozen.py`: load_dirty_dozen_tasks (function, public), assert_dirty_dozen_manifest (function, public), _assert_task_policy (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/exec_select.py`: CandidateSample (class, public), select_index (function, public), selected_private_pass (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_bench.py`: FusionBenchTask (class, public), FusionBenchFailure (class, public), FusionBenchAttemptRow (class, public), FusionBenchTaskMetrics (class, public), FusionBenchAggregateMetrics (class, public), FusionBenchFailureCorrelation (class, public), FusionBenchParetoPoint (class, public), FusionBenchReproducibilityMetadata (class, public), FusionBenchReport (class, public), HandoffKitExecutorUnavailable (class, public), HandoffKitExecutorError (class, public), HandoffKitExecutor (class, public), CommandHandoffKitExecutor (class, public), FusionBenchRunner (class, public), load_benchmark_tasks (function, public), join_run_records (function, public), join_handoffkit_records (function, public), skip_row (function, public), write_fusion_bench_jsonl (function, public), load_fusion_bench_jsonl (function, public), build_fusion_bench_report (function, public), score_fusion_bench_row (function, public), parse_handoffkit_records (function, public), _coerce_record (function, internal), _validate_contract_payload (function, internal), _records_by_schema (function, internal), _first_record_by_schema (function, internal), _assert_joined_task_matches (function, internal), _artifact_records_from_contracts (function, internal), _contract_payloads (function, internal), _first_contract_payload (function, internal), _first_raw_payload (function, internal), _failure_from_inspection (function, internal), _failure_from_handoff_records (function, internal), _first_contract_error (function, internal), _error_code (function, internal), _error_message (function, internal), _error_retryable (function, internal), _judge_parse_failed (function, internal), _cost_from_model_call_metadata (function, internal), _latency_from_model_calls (function, internal), _model_call_metadata (function, internal), _model_ids_from_handoff_records (function, internal), _handoff_trace_id (function, internal), _handoff_output (function, internal), _optional_string (function, internal), _state_for_handoff_status (function, internal), _row_is_skipped (function, internal), _row_is_failed (function, internal), _harness_verification_outcome (function, internal), _score_by_task_record (function, internal), _candidate_scores (function, internal), _candidate_model_id (function, internal), _expected (function, internal), _json_key_score (function, internal), _tool_call_validity (function, internal), _regret (function, internal), _tool_success (function, internal), _candidate_failure_rate (function, internal), _aggregate_metrics (function, internal), _average_metric (function, internal), _average (function, internal), _failure_correlations (function, internal), _pearson (function, internal), _pareto_points (function, internal), _reproducibility_metadata (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_compound.py`: ModelRate (class, public), CompoundComparison (class, public), _is_pass (function, internal), _fused_pass (function, internal), _rate (function, internal), compare_compound_vs_individual (function, public), _oracle_regret (function, internal), format_compound_comparison_markdown (function, public), _fmt (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_hillclimb.py`: BestSingle (class, public), ClimbDiagnosis (class, public), TargetCheck (class, public), ClimbResult (class, public), best_single_baseline (function, public), diagnose_bank (function, public), check_target (function, public), run_climb (function, public), _mean_failure_correlation (function, internal), _pearson (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/fusion_reports.py`: write_fusion_bench_report_jsonl (function, public), write_fusion_bench_markdown_report (function, public), format_fusion_bench_markdown_report (function, public), write_fusion_bench_html_report (function, public), format_fusion_bench_html_report (function, public), _ensure_report (function, internal), _write_report_record (function, internal), _format_pareto_table (function, internal), _format_metric (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/gateway_target.py`: GatewayTarget (class, public), default_dialect_for_runner (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/hyperkit_plugin.py`: _free_port (function, internal), FusionKitGatewaySUT (class, public), factory (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/livecodebench_data.py`: _log (function, internal), load_manifest (function, public), load_problems (function, public), _select_from_manifest (function, internal), _select_recent (function, internal), decode_tests (function, public), decode_public_private (function, public), prepare_tasks (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/pareto.py`: ParetoPoint (class, public), find_pareto_front (function, public), load_points (function, public), write_pareto_report (function, public), format_pareto_markdown (function, public), _dominates (function, internal), _format_optional (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/polyglot.py`: LanguageSpec (class, public), PolyglotExercise (class, public), _read (function, internal), _instructions (function, internal), _primary_solution (function, internal), load_polyglot_exercises (function, public), build_prompt (function, public), _scrubbed_env (function, internal), PolyglotRun (class, public), run_polyglot (function, public), _bank_log (function, internal), _task_cache_path (function, internal), build_polyglot_bank (function, public), polyglot_verifier (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/prompt_tuning.py`: PromptVariant (class, public), TaskSplit (class, public), PerTaskResult (class, public), PromptEval (class, public), TrialRecord (class, public), TuningResult (class, public), select_decision_tasks (function, public), regression_guard_tasks (function, public), split_dev_val (function, public), TunerRuntime (class, public), replay_task (function, public), evaluate_variant (function, public), mcnemar (function, public), FailureExemplar (class, public), PromptProposer (class, public), StubProposer (class, public), LLMProposer (class, public), optimize (function, public), _collect_failures (function, internal), _optimizer_user_prompt (function, internal), _strip_fences (function, internal), _load_cached (function, internal), _save_cached (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/provenance.py`: package_versions (function, public), hash_text (function, public), build_provenance (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/public_bench.py`: PublishedBaseline (class, public), PublicBenchmarkInfo (class, public), ExternalBenchmarkRequest (class, public), ExternalBenchmarkTaskRow (class, public), ExternalBenchmarkRun (class, public), ExternalBenchmarkUnavailable (class, public), ExternalBenchmarkError (class, public), ExternalBenchmarkExecutor (class, public), CommandExternalBenchmarkExecutor (class, public), parse_external_run (function, public), run_public_benchmark (function, public), baselines_for (function, public), best_baseline (function, public), panel_member_published_scores (function, public), panel_headroom_for_suite (function, public), assert_public_benchmark_registry (function, public), _unavailable_run (function, internal), _parse_task_row (function, internal), _as_int (function, internal), _as_float (function, internal), _as_str (function, internal), write_external_runs_jsonl (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/public_bench_report.py`: ComparisonBaselineRow (class, public), FailureCorrelationRow (class, public), BenchmarkComparison (class, public), build_benchmark_comparison (function, public), format_benchmark_comparison_markdown (function, public), write_benchmark_comparison_markdown (function, public), _measured_oracle_regret (function, internal), _failure_correlations (function, internal), _pearson (function, internal), _row_score (function, internal), format_comparisons_markdown (function, public), _fmt (function, internal), _fmt_cost (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/public_smoke.py`: PublicSmokeSuiteInfo (class, public), load_public_smoke_tasks (function, public), assert_public_smoke_matrix (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/resources.py`: packaged_data_path (function, public), _as_path (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/sandbox.py`: SandboxResult (class, public), SandboxUnavailable (class, public), Sandbox (class, public), LocalSandbox (class, public), DockerSandbox (class, public), SandboxConfig (class, public), build_sandbox (function, public), _read_capped (function, internal), _bytes_to_docker (function, internal)
- `python/fusionkit-evals/src/fusionkit_evals/schema.py`: EvalSample (class, public), EvalResult (class, public)
- `python/fusionkit-evals/src/fusionkit_evals/scorers.py`: exact_match (function, public), contains_expected (function, public)
- `python/fusionkit-evals/src/fusionkit_evals/tiny.py`: TinyBenchmarkTask (class, public), TinyBenchmarkMetrics (class, public), TinyBenchmarkResult (class, public), load_tiny_tasks (function, public), assert_tiny_task_matrix (function, public), run_tiny_benchmark (function, public), score_tiny_output (function, public), write_tiny_jsonl (function, public), load_tiny_results (function, public), write_tiny_benchmark_report (function, public), format_tiny_benchmark_report (function, public), _score_by_task (function, internal), _expected (function, internal), _json_key_score (function, internal), _schema_validity (function, internal), _tool_call_validity (function, internal), _optional_run_id (function, internal), _average_metric (function, internal), _optional_float (function, internal), _format_metric (function, internal)

### `python/fusionkit-mlx`

- `python/fusionkit-mlx/src/fusionkit_mlx/launcher.py`: MlxServerCommand (class, public), build_mlx_lm_server_command (function, public)

### `python/fusionkit-server`

- `python/fusionkit-server/src/fusionkit_server/app.py`: TrajectoryItemInput (class, public), TrajectoryInput (class, public), FuseTrajectoriesRequest (class, public), _package_version (function, internal), create_app (function, public), _create_run_manager (function, internal), _create_run_payload (function, internal), _native_error_response (function, internal), _run_not_found_response (function, internal), _json_response (function, internal), _dump_optional (function, internal), _error_response (function, internal), _resolved_tool_name (function, internal), _normalize_tools (function, internal), _normalize_tool_choice (function, internal), _tool_calls_payload (function, internal), _usage_payload (function, internal), _fuse_step_usage (function, internal), _fusion_extension (function, internal), _step_response (function, internal), _fused_completion_sse (function, internal)

### `python/fusionkit-testkit`

- `python/fusionkit-testkit/src/fusionkit_testkit/behaviors.py`: SimToolCall (class, public), SimError (class, public), Behavior (class, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/cli.py`: main (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/endpoints.py`: SimModel (class, public), sim_model (function, public), panel_config (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/engine.py`: free_port (function, public), _engine_argv (function, internal), EngineProcessError (class, public), EngineProcess (class, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/pytest_plugin.py`: SimStackFactory (class, public), routekit_sim (function, public), sim_stack (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/scenarios.py`: as_behavior (function, public), judge_analysis (function, public), script_fused_turn (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/server.py`: _SimulatorState (class, internal), _last_user_text_openai (function, internal), _last_user_text_anthropic (function, internal), _Handler (class, internal), _SimulatorServer (class, internal), RouteKitSimulator (class, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/sse.py`: parse_sse (function, public), sse_text (function, public), sse_reasoning (function, public), sse_done (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/wire_anthropic.py`: error_body (function, public), _content_blocks (function, internal), _stop_reason (function, internal), message_body (function, public), _tokenize (function, internal), _argument_fragments (function, internal), stream_events (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/wire_google.py`: error_body (function, public), _usage_metadata (function, internal), _function_call (function, internal), _parts (function, internal), generate_content_body (function, public), _tokenize (function, internal), stream_frames (function, public), last_user_text (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/wire_openai.py`: _usage_json (function, internal), error_body (function, public), completion_body (function, public), _tokenize (function, internal), _argument_fragments (function, internal), stream_frames (function, public)
- `python/fusionkit-testkit/src/fusionkit_testkit/wire_responses.py`: error_body (function, public), _usage_json (function, internal), _output_items (function, internal), response_snapshot (function, public), _tokenize (function, internal), _argument_fragments (function, internal), stream_events (function, public), last_user_text (function, public)

### `python/hyperkit`

- `python/hyperkit/src/hyperkit/adapters/livecodebench.py`: _store_dir (function, internal), extract_code (function, public), _normalize (function, internal), decode_tests (function, public), _Sandbox (class, internal), run_tests (function, public), _Client (class, internal), LivecodebenchGrader (class, public), LivecodebenchAdapter (class, public), _fetch_problem_from_s3 (function, internal), _resolve_api_key (function, internal)
- `python/hyperkit/src/hyperkit/adapters/swebench.py`: SwebenchGrader (class, public), SwebenchAdapter (class, public), _factory (function, internal)
- `python/hyperkit/src/hyperkit/adapters/terminal_bench.py`: TerminalBenchGrader (class, public), TerminalBenchAdapter (class, public)
- `python/hyperkit/src/hyperkit/backends/aws_batch.py`: _default_batch_client (function, internal), _adapter_version (function, internal), AwsBatchComputeBackend (class, public), _number (function, internal), _job_name (function, internal), _EnvironmentAwsBatchBackend (class, internal), _backend_from_environment (function, internal), factory (function, public)
- `python/hyperkit/src/hyperkit/backends/local.py`: LocalComputeBackend (class, public), default_max_workers (function, public)
- `python/hyperkit/src/hyperkit/backends/s3.py`: parse_s3_uri (function, public), _default_s3_client (function, internal), S3ResultStore (class, public)
- `python/hyperkit/src/hyperkit/cli.py`: plan (function, public), extend (function, public), apply (function, public), resume (function, public), pull (function, public), status (function, public), collect (function, public), controller (function, public), local_controller (function, public), replay_swebench (function, public)
- `python/hyperkit/src/hyperkit/cloud/controller.py`: _required_env (function, internal), _boto3_client (function, internal), S3SweepRepository (class, public), HypergridController (class, public), _sweep_ids_from_message (function, internal), run_loop (function, public), _stop_handler (function, internal), main (function, public)
- `python/hyperkit/src/hyperkit/cloud/runner.py`: _required_env (function, internal), _array_index (function, internal), _store_prefix (function, internal), _load_entry (function, internal), _configure_otel (function, internal), main (function, public)
- `python/hyperkit/src/hyperkit/core/aggregate.py`: _is_solo (function, internal), aggregate (function, public), format_table (function, public)
- `python/hyperkit/src/hyperkit/core/contracts.py`: ManifestSource (class, public), Grader (class, public), BenchmarkAdapter (class, public), SystemUnderTest (class, public), ComputeBackend (class, public), ExperimentContext (class, public), Experiment (class, public)
- `python/hyperkit/src/hyperkit/core/experiments.py`: Experiment (class, public), experiment (function, public), load_experiment (function, public), _as_list (function, internal), CartesianExperiment (class, public)
- `python/hyperkit/src/hyperkit/core/ids.py`: canonical_json (function, public), hash_obj (function, public), spec_hash (function, public), hash_ids (function, public)
- `python/hyperkit/src/hyperkit/core/lock.py`: repo_sha (function, public), load_lock (function, public), save_lock (function, public), new_lock (function, public), extend_lock (function, public)
- `python/hyperkit/src/hyperkit/core/manifests.py`: TextManifest (class, public)
- `python/hyperkit/src/hyperkit/core/models.py`: _utcnow (function, internal), ResourceProfile (class, public), TopologySpec (class, public), SUTTarget (class, public), Cell (class, public), ShardStatus (class, public), ShardResult (class, public), Generation (class, public), SweepLock (class, public), RunResult (class, public)
- `python/hyperkit/src/hyperkit/core/orchestrator.py`: RunOrchestrator (class, public), _float_or_none (function, internal), _int_or_none (function, internal)
- `python/hyperkit/src/hyperkit/core/registry.py`: register_benchmark (function, public), register_sut (function, public), register_backend (function, public), _load_entry_points (function, internal), get_benchmark (function, public), get_sut (function, public), get_backend (function, public), known_benchmarks (function, public), EndpointRecord (class, public), ModelRegistry (class, public), load_model_registry (function, public), endpoint_identity_hash (function, public), lineage_conflicts (function, public)
- `python/hyperkit/src/hyperkit/core/snapshots.py`: CellSnapshot (class, public), build_cell_snapshots (function, public), _snapshot (function, internal), _axis (function, internal), _panel (function, internal), _percentile (function, internal), _is_pareto (function, internal)
- `python/hyperkit/src/hyperkit/core/store.py`: ResultStore (class, public)
- `python/hyperkit/src/hyperkit/core/sweep.py`: Shard (class, public), _Context (class, internal), _experiment_source_hash (function, internal), SweepEngine (class, public)
- `python/hyperkit/src/hyperkit/local_controller.py`: _stop_handler (function, internal), snapshot_workdir (function, public), write_snapshots (function, public), run_local_controller (function, public)
- `python/hyperkit/src/hyperkit/replay.py`: ReplayRow (class, public), replay_reports (function, public)
- `python/hyperkit/src/hyperkit/stats.py`: ProportionCI (class, public), wilson_interval (function, public), pass_at_k (function, public), SeedAggregate (class, public), aggregate_seeds (function, public), bootstrap_ci (function, public), clustered_bootstrap_ci (function, public), clustered_bootstrap_statistic (function, public), McNemarResult (class, public), mcnemar (function, public)
- `python/hyperkit/src/hyperkit/suts/solo.py`: SoloModelSUT (class, public)
- `python/hyperkit/src/hyperkit/telemetry.py`: _resource_attributes (function, internal), configure (function, public), shard_span (function, public), record_shard (function, public), record_running (function, public), set_cell_snapshots (function, public), record_snapshot_deltas (function, public), _create_cell_gauges (function, internal), _snapshot_callback (function, internal), _cell_total_callback (function, internal)

### `python/uniroute`

- `python/uniroute/src/uniroute/demo.py`: MethodResult (class, public), _summary (function, internal), _qnc_summary (function, internal), run_trial (function, public), main (function, public)
- `python/uniroute/src/uniroute/evaluate.py`: DeferralCurve (class, public), default_lambda_grid (function, public), pareto_clean (function, public), deferral_curve (function, public), zero_router_curve (function, public), area_under_curve (function, public), quality_neutral_cost (function, public), select_n_clusters (function, public)
- `python/uniroute/src/uniroute/kmeans.py`: KMeansResult (class, public), _squared_distances (function, internal), _kmeans_plus_plus (function, internal), kmeans (function, public), assign (function, public)
- `python/uniroute/src/uniroute/learned_map.py`: _augment (function, internal), _softmax (function, internal), _init_theta (function, internal), loss_and_grad (function, public), TrainingTrace (class, public), UniRouteLearnedMap (class, public)
- `python/uniroute/src/uniroute/routers.py`: route (function, public), cluster_error_embedding (function, public), UniRouteKMeans (class, public), KNNRouter (class, public), ZeroRouterPlan (class, public), ZeroRouter (class, public)
- `python/uniroute/src/uniroute/synthetic.py`: SyntheticBenchmark (class, public), make_benchmark (function, public)
- `python/uniroute/src/uniroute/trials.py`: synthetic_trial_curves (function, public)

### `python/uniroute-mlx`

- `python/uniroute-mlx/src/uniroute_mlx/card.py`: CardModel (class, public), RouteDecision (class, public), RouterCard (class, public), build_card (function, public), save_card (function, public), load_card (function, public)
- `python/uniroute-mlx/src/uniroute_mlx/cli.py`: load_prompts (function, public), _embed_in_batches (function, internal), cmd_evaluate (function, public), _parse_cost_overrides (function, internal), cmd_fit (function, public), cmd_route (function, public), build_parser (function, public), main (function, public)
- `python/uniroute-mlx/src/uniroute_mlx/client.py`: EndpointError (class, public), ChatResult (class, public), _normalise_base_url (function, internal), OpenAICompatibleClient (class, public)
- `python/uniroute-mlx/src/uniroute_mlx/evaluate.py`: Example (class, public), Evaluation (class, public), load_examples (function, public), score (function, public), evaluate_model (function, public), _eval_path (function, internal), save_evaluation (function, public), load_evaluations (function, public)

### `packages/protocol/generated/python`

- `packages/protocol/generated/python/velum_model_fusion_protocol/model_fusion_openapi.py`: PersistedJsonRecord (class, public), ArtifactRef (class, public), HarnessExecutionRequest (class, public), HarnessExecutionResult (class, public), ErrorResponse (class, public), execute_harness_task (function, public)

