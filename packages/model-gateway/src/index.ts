/**
 * @fusionkit/model-gateway is the Fusion Harness Gateway entry point.
 *
 * It fronts OpenAI-compatible Chat Completions backends, local MLX servers, and
 * fused panel routes, then exposes the wire dialects each agent harness needs.
 * A local or fused model can back opencode, Claude Code, Codex, Cursor, and raw
 * HTTP callers without changing their workflow.
 *
 * Public exports include server startup, backend implementations, frontdoor
 * workflows, session stores, cost metering, rate-limit failover, dialect
 * adapters, ACP helpers, provenance records, and trajectory capture.
 */
export { startGateway } from "./server.js";
export type { Gateway, GatewayOptions } from "./server.js";
export { joinPath, OpenAiBackend } from "./backend.js";
export type { Backend, BackendRequestOptions, OpenAiBackendOptions } from "./backend.js";
export { FusionBackend } from "./fusion-backend.js";
export { InMemoryFusionBackendKernelStateStore } from "./fusion-backend.js";
export {
  FrontdoorArtifactTypes,
  FrontdoorFuseError,
  FrontdoorOperatorKinds,
  FrontdoorPanelError,
  frontdoorBudgetGateOperator,
  frontdoorBudgetStopOperator,
  frontdoorFinalizeOperator,
  frontdoorFuseOperator,
  frontdoorPanelOperator,
  frontdoorResolveModelOperator,
  frontdoorStreamingFuseOperator,
  frontdoorVendorProxyOperator
} from "./frontdoor/operators.js";
export type {
  BudgetValue,
  CandidateSetValue,
  FailoverValue,
  RouteValue
} from "./frontdoor/operators.js";
export {
  FUSION_FRONTDOOR_TURN_WORKFLOW,
  frontdoorRequestArtifact,
  runFusionFrontdoorTurn,
  streamFusionFrontdoorTurn
} from "./frontdoor/workflow.js";
export type { FrontdoorTurnOutcome } from "./frontdoor/workflow.js";
export {
  FUSION_FRONTDOOR_REQUEST_WORKFLOW,
  FrontdoorRequestScheduler,
  runFrontdoorRequest
} from "./frontdoor/request.js";
export { eventsToSseResponse } from "./frontdoor/sse.js";
export type { EventsToSseOptions } from "./frontdoor/sse.js";
export { createTurnNarrator, mergeEventsWithNarration } from "./frontdoor/narration.js";
export type { NarrationWriter, ReasoningDeltaEvent, TurnNarration, TurnNarratorInput } from "./frontdoor/narration.js";
export { createChatNarrationWriter } from "./frontdoor/narration-writer.js";
export type { ChatFn, ChatNarrationWriterOptions } from "./frontdoor/narration-writer.js";
export { FRONTDOOR_SIGNAL } from "./frontdoor/types.js";
export type {
  FrontdoorChatBody,
  FrontdoorRequestValue,
  FrontdoorRoute,
  FrontdoorServices,
  VendorProxyOutcome
} from "./frontdoor/types.js";
export type {
  ChatMessageLike,
  FuseStepRunInput,
  FuseStepRunner,
  FusionBackendKernelSessionState,
  FusionBackendKernelStateStore,
  FusionBackendOptions,
  OnRateLimitPolicy,
  PanelRunInput,
  PanelRunner,
  PassthroughModel,
  SessionMetaInput
} from "./fusion-backend.js";
export type { WireTrajectory } from "@fusionkit/protocol";
export {
  defaultSessionsDir,
  FileSystemSessionStore,
  InMemorySessionStore
} from "./session-store.js";
export type {
  PersistedSession,
  SessionMeta,
  SessionStore,
  SessionSummary,
  SessionTurnRecord
} from "./session-store.js";
export {
  addTurnCost,
  DEFAULT_MODEL_PRICING,
  emptySessionCost,
  estimateCost,
  formatUsd,
  lookupPricing,
  meterTurn,
  parseUsage,
  parseUsageFromSse,
  turnCostLine
} from "./cost.js";
export type { ModelPricing, SessionCost, TokenUsage, TurnCost } from "./cost.js";
export { MlxBackend } from "./mlx-backend.js";
export type { MlxBackendOptions } from "./mlx-backend.js";
export { createBackend, DEFAULT_MLX_MODEL, resolveBackendConfig } from "./config.js";
export type { BackendConfig } from "./config.js";
export { effectiveModel, isStream, withDefaultModel } from "./adapters/chat.js";
export {
  anthropicModelsResponse,
  anthropicToChat,
  chatToAnthropicMessage,
  claudeModelAlias,
  countTokensEstimate,
  handleAnthropicMessages,
  handleCountTokens,
  mapStopReason,
  openAiSseToAnthropic
} from "./adapters/anthropic.js";
export type { AnthropicRequest } from "./adapters/anthropic.js";
export {
  chatToResponses,
  handleResponses,
  openAiSseToResponses,
  responsesToChat
} from "./adapters/responses.js";
export type { ResponsesRequest } from "./adapters/responses.js";
export {
  FUSION_EVIDENCE_HEADER,
  FUSION_REPORT_HEADER,
  FUSION_RUN_ID_HEADER,
  FUSION_STATUS_HEADER,
  formatAnthropic,
  formatChat,
  formatResponses,
  promptFromAnthropic,
  promptFromChat,
  promptFromResponses,
  startFusionGateway
} from "./fusion-gateway.js";
export type {
  ChatRequest,
  FrontDoorDialect,
  FrontDoorRunner,
  FrontDoorRunnerInput,
  FrontDoorRunnerResult,
  FusionGateway,
  FusionGatewayOptions
} from "./fusion-gateway.js";
export { ACP_PROTOCOL_VERSION, runAcpAgent } from "./acp-agent.js";
export type {
  AcpAgentOptions,
  AcpRunner,
  AcpRunnerInput,
  AcpRunnerResult
} from "./acp-agent.js";
export { runFrontDoorAcceptance } from "./front-door-acceptance.js";
export type {
  FrontDoorAcceptanceOptions,
  FrontDoorAcceptanceReport,
  FrontDoorOutcome,
  FrontDoorOutcomeProducer,
  FrontDoorStatus
} from "./front-door-acceptance.js";
export {
  ACP_REGISTRY_URL,
  fetchAcpRegistry,
  installAcpAdapters
} from "./acp-registry.js";
export type {
  AcpRegistry,
  AcpRegistryAgent,
  AcpRegistryFetcher,
  InstallAcpAdaptersOptions,
  InstalledAcpAdapter
} from "./acp-registry.js";
export {
  buildModelCallRecord,
  MODEL_CALL_ID_HEADER,
  modelCallId,
  readProducerVersion,
  resolveProducerGitSha,
  responseBodyHash,
  UNKNOWN_GIT_SHA
} from "./provenance.js";
export type {
  GatewayDialect,
  ModelCallRecord,
  ModelGatewayCallContext,
  ModelGatewayCallResult,
  ProvenanceSink
} from "./provenance.js";
export { createTrajectoryCapture, reconstructTrajectory } from "./trajectory-capture.js";
export type { CapturedStep, CapturedTrajectory, TrajectoryCapture } from "./trajectory-capture.js";
