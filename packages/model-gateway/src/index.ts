/**
 * @fusionkit/model-gateway — a native local-model gateway.
 *
 * It fronts a single OpenAI Chat Completions backend (the owned
 * `velum-labs/mlx-lm` fork by default — "mlx_lm.server first") and exposes the
 * wire dialects each agent harness needs so a local model can transparently
 * back them with no change to the user's workflow:
 *
 *  - OpenAI Chat Completions (`/v1/chat/completions`) — opencode, Cursor IDE
 *    plan panel. Implemented (M1).
 *  - Anthropic Messages (`/v1/messages`) — Claude Code. Planned (M2).
 *  - OpenAI Responses (`/v1/responses`) — Codex. Planned (M3).
 *
 * See spec/2026-06-13-local-model-harness-bridge-spec.md.
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
  frontdoorFinalizeOperator,
  frontdoorFuseOperator,
  frontdoorPanelOperator,
  frontdoorStreamingFuseOperator
} from "./frontdoor/operators.js";
export type {
  CandidateSetValue,
  FrontdoorFusionStreamTurn,
  FrontdoorFusionTurn
} from "./frontdoor/operators.js";
export {
  FUSION_FRONTDOOR_TURN_WORKFLOW,
  runFusionFrontdoorTurn,
  streamFusionFrontdoorTurn
} from "./frontdoor/workflow.js";
export type { FrontdoorTurnOutcome } from "./frontdoor/workflow.js";
export { eventsToSseResponse } from "./frontdoor/sse.js";
export type { EventsToSseOptions } from "./frontdoor/sse.js";
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
