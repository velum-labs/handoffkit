import type { WireTrajectory } from "@fusionkit/protocol";
import type { FusionTraceCarrier } from "@fusionkit/tracing";

import type { NarrationWriter } from "./frontdoor/narration.js";
import type { FusionGatewayLogger } from "./logger.js";
import type {
  LocalComputePricing,
  ModelPricing,
  SessionCost
} from "./cost.js";
import type { SessionStore } from "./session-store.js";

export type { WireTrajectory } from "@fusionkit/protocol";

export type PassthroughModel = {
  modelId: string;
  endpointId: string;
  endpointUrl: string;
};

export type FusedModelRoute = {
  modelId: string;
  name: string;
  memberEndpointIds: readonly string[];
  judgeEndpointId?: string;
  judgeModelName?: string;
  synthesizerEndpointId?: string;
  /**
   * Step boundaries per panel member before aggregation: 1 = single-completion
   * proposers over the caller's messages+tools; finite > 1 = bounded managed
   * rollout (lookahead); unset = unbounded rollout (today's behavior).
   */
  k?: number;
  prompts?: Readonly<Record<string, string>>;
};

export type ChatMessageLike = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

export type ChatBody = {
  model?: string;
  messages?: ChatMessageLike[];
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
};

export type PanelRunInput = {
  task: string;
  messages: ChatMessageLike[];
  /** Session trace carrier; panel candidate spans parent onto it. */
  trace: FusionTraceCarrier;
  sessionKey: string;
  turn: number;
  ensembleModelId?: string;
  excludeModelIds?: readonly string[];
  panelDepth?: number;
  /**
   * The caller's tool definitions / tool_choice, verbatim — always present
   * when the caller sent them (lossless projection). Which panels consume
   * them is the panel runner's decision: k=1 members propose against the
   * caller's real toolset (B7); rollout members act through their managed
   * harness's own tools and never see them (B20).
   */
  tools?: unknown;
  toolChoice?: unknown;
  /** Step boundaries per member (see {@link FusedModelRoute.k}). */
  k?: number;
  signal?: AbortSignal;
};

export type PanelRunner = (input: PanelRunInput) => Promise<WireTrajectory[]>;

export type FuseStepRunInput = {
  stepUrl: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
  streaming: boolean;
};

export type FuseStepRunner = (input: FuseStepRunInput) => Promise<Response>;

export type OnRateLimitPolicy = "fusion" | "passthrough" | "fail";

export type FailoverCategory =
  | "transient"
  | "quota_exhausted"
  | "auth_permanent"
  | "context_overflow"
  | "unknown";

export type ProxyFailure = {
  category: FailoverCategory;
  status?: number;
  retryAfter?: number;
  provider?: string;
  message: string;
};

export type FailoverDecision = "failover" | "fail-fast" | "fail-error";

export type SessionMetaInput = {
  tool?: string;
  repo?: string;
  models?: Array<{ id: string; model: string }>;
  judgeModel?: string;
};

export type FusionBackendOptions = {
  stepUrl: string;
  runPanels: PanelRunner;
  runFuseStep?: FuseStepRunner;
  defaultModel?: string;
  judgeModel?: string;
  sessionTtlMs?: number;
  panelTimeoutMs?: number;
  stepTimeoutMs?: number;
  mintTraceId?: () => string;
  fusedModels?: readonly FusedModelRoute[];
  passthrough?: readonly PassthroughModel[];
  onRateLimit?: OnRateLimitPolicy;
  store?: SessionStore;
  resumeId?: string;
  sessionMeta?: SessionMetaInput;
  budgetUsd?: number;
  pricing?: Readonly<Record<string, ModelPricing>>;
  localCompute?: Readonly<Record<string, LocalComputePricing>>;
  localModels?: readonly string[];
  costModel?: string;
  kernelStateStore?: FusionBackendKernelStateStore;
  reasoningTraces?: boolean;
  narrationWriter?: NarrationWriter;
  logger?: FusionGatewayLogger;
};

export type FusionBackendKernelSessionState = {
  id: string;
  traceId: string;
  sessionSpan: string;
  /** Virtual session root carrier every turn's spans parent onto. */
  trace: FusionTraceCarrier;
  turns: Map<number, Promise<WireTrajectory[]>>;
  turnAborts: Map<number, AbortController>;
  meteredPanelTurns: Set<number>;
  createdAt: number;
  lastJudgePick?: string;
  /** Rendered step the whole panel proposed and the fuse committed (no single pick). */
  lastAgreedStep?: string;
};

export type FusionBackendKernelStateStore = {
  get(sessionKey: string): FusionBackendKernelSessionState | undefined;
  set(sessionKey: string, state: FusionBackendKernelSessionState): void;
  delete(sessionKey: string): void;
  entries(): IterableIterator<[string, FusionBackendKernelSessionState]>;
  getCost(sessionKey: string): SessionCost | undefined;
  setCost(sessionKey: string, cost: SessionCost): void;
};
