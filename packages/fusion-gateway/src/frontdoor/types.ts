/**
 * Data contracts for the fusion front-door graphs.
 *
 * The front-door request/turn is fully data-driven: every per-turn input travels
 * as a {@link FrontdoorRequestValue} artifact, and every side-effecting phase is a
 * method on a stable {@link FrontdoorServices} object (built once, keyed by the
 * request data + the kernel state store). Operators therefore capture no per-turn
 * closures — they read the request artifact and invoke stable services.
 */

import type { WireTrajectory } from "@fusionkit/protocol";

import type { ChatMessageLike } from "../fusion-types.js";
import type { FusionGatewayLogger } from "../logger.js";
import type { TurnNarration } from "./narration.js";

/** The parsed OpenAI Chat Completions body the front door reads (data only). */
export type FrontdoorChatBody = {
  model?: string;
  messages?: ChatMessageLike[];
  tools?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
};

/**
 * The client `AbortSignal` is a per-request runtime handle, not serializable
 * data, so it rides the request value under a `Symbol` key. The runtime's
 * `deepFreeze` only walks string-keyed values, so it never freezes or clones the
 * signal, and object spread preserves it across a failover-augmented request.
 */
export const FRONTDOOR_SIGNAL: unique symbol = Symbol("frontdoor.signal");

/**
 * All per-turn inputs, as a typed artifact value (data), plus the request's
 * abort signal under {@link FRONTDOOR_SIGNAL}.
 */
export type FrontdoorRequestValue = {
  /** Correlates the turn across trace events. */
  requestId: string;
  /** The parsed request body forwarded to the vendor / used to build the fuse step. */
  chat: FrontdoorChatBody;
  /** Stable conversation key (system + first user message hash). */
  sessionKey: string;
  /** 1-based user-turn index (a follow-up user message is a new turn). */
  turn: number;
  /** Whether the client asked for a streamed (SSE) response. */
  streaming: boolean;
  /**
   * Fusion panel depth of the caller (0 = user request; >= 1 = issued from
   * inside a panel member, e.g. a member's fused sub-agent turn). Panel runs
   * for depth >= 1 requests do not re-provision fused sub-agent access.
   */
  panelDepth?: number;
  /** Panel members to exclude this turn (WS5 failover drops the throttled vendor). */
  excludeModelIds?: readonly string[];
  /** A leading assistant content-delta notice (failover handoff). */
  notice?: string;
  /** Optional model-call id header forwarded downstream. */
  modelCallId?: string;
  /**
   * The caller will translate the streamed response to another dialect
   * (Anthropic / Responses) with its own keepalive, so the chat-layer
   * `: keepalive` comments are suppressed to avoid a redundant second keepalive.
   */
  suppressChatKeepalive?: boolean;
  /** The client abort signal (runtime handle, not data). */
  [FRONTDOOR_SIGNAL]?: AbortSignal;
};

/**
 * The classified result of proxying a turn to a native vendor model. The
 * failover *control* is a scheduler decision over this value; the SSE peeking /
 * resume-notice byte logic is the service's transport implementation.
 */
export type FrontdoorRoute = "fusion" | "passthrough";

export type VendorProxyOutcome =
  | { kind: "response"; response: Response }
  | { kind: "failover"; excludeModelIds: readonly string[]; notice: string };

/**
 * Stable, side-effecting implementations the front-door operators invoke. Built
 * once (not per turn); every method takes the request as data and derives session
 * identity, spans, headers, and cost from the request + the kernel state store.
 */
export type FrontdoorServices = {
  /** Logger for human-facing gateway diagnostics. */
  readonly logger: FusionGatewayLogger;
  /** The configured USD budget cap, if any. */
  readonly budgetUsd: number | undefined;
  /** The conversation's accrued gateway-observed cost (USD). */
  costTotalUsd: (sessionKey: string) => number;
  /** The clear stop response when a turn is refused for exceeding the budget. */
  budgetStopResponse: (req: FrontdoorRequestValue) => Response;
  /** Whether the requested model is a native passthrough (vs the fused model). */
  isNativeModel: (model: string | undefined) => boolean;
  /** Resolve the turn's candidate trajectories (panel phase). */
  resolvePanelCandidates: (req: FrontdoorRequestValue) => Promise<readonly WireTrajectory[]>;
  /** Emit judge.request and POST the buffered fuse step; returns its response. */
  runFuseStep: (req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]) => Promise<Response>;
  /** Emit judge.request and POST the streaming fuse step; returns its response. */
  openFuseStream: (req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]) => Promise<Response>;
  /** Meter cost, emit judge.final/thinking, persist the turn, apply any notice. */
  finalizeFused: (req: FrontdoorRequestValue, response: Response) => Promise<Response>;
  /** Streamed completion: meter cost + emit judge.final/thinking from the SSE tail. */
  meterAndTraceStream: (req: FrontdoorRequestValue, sseBuffer: string) => void;
  /** Non-2xx / bodyless fuse reply: emit judge.final error before failing. */
  onFuseUpstreamError: (req: FrontdoorRequestValue, status: number, detail: string) => void;
  /** An exception mid-stream (e.g. an aborted fetch): emit judge.final error. */
  onFuseException: (req: FrontdoorRequestValue, message: string) => void;
  /** Proxy the turn to the native vendor; returns a classified outcome. */
  proxyVendor: (req: FrontdoorRequestValue) => Promise<VendorProxyOutcome>;
  /** Evict a turn's cached candidates so a retry re-runs the panel. */
  evictTurn: (req: FrontdoorRequestValue) => void;
  /**
   * Open the live narration channel for a streaming fused turn (reasoning
   * traces). Returns undefined when narration is disabled.
   */
  openTurnNarration?: (req: FrontdoorRequestValue) => TurnNarration | undefined;
};
