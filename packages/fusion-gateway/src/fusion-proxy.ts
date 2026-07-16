import { isFiniteK } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { newSpanId, newTraceId } from "@fusionkit/tracing";
import { FUSION_PANEL_MODEL } from "@fusionkit/registry";
import { withTimeout } from "@routekit/runtime";

import { CLAUDE_ALIAS_PREFIX } from "@routekit/gateway";
import type { Backend, BackendRequestOptions } from "@routekit/gateway";
import type { FrontdoorRequestValue, FrontdoorServices } from "./frontdoor/types.js";
import { FRONTDOOR_SIGNAL } from "./frontdoor/types.js";
import { runFrontdoorRequest } from "./frontdoor/request.js";
import {
  DEFAULT_PANEL_TIMEOUT_MS,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  FusionSessionManager,
  hasUsableCandidates,
  InMemoryFusionBackendKernelStateStore,
  isHarnessNotification,
  PendingSessionWrites
} from "./fusion-session.js";
import { FusionCostMeter } from "./fusion-cost-meter.js";
import { FusionTurnAssembler } from "./fusion-turn.js";
import { FusionVendorProxy } from "./fusion-vendor-proxy.js";
import type {
  ChatBody,
  ChatMessageLike,
  FusedModelRoute,
  FusionBackendOptions,
  PassthroughModel
} from "./fusion-types.js";
import { defaultFusionGatewayLogger } from "./logger.js";
import { panelDepthFromRequest } from "./request-context.js";

function invalidRequest(message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error", code: "invalid_request" } }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

export { InMemoryFusionBackendKernelStateStore, PendingSessionWrites } from "./fusion-session.js";
export type {
  ChatMessageLike,
  FusedModelRoute,
  FuseStepRunInput,
  FuseStepRunner,
  FusionBackendKernelSessionState,
  FusionBackendKernelStateStore,
  FusionBackendOptions,
  OnRateLimitPolicy,
  PanelRunInput,
  PanelRunner,
  PassthroughModel,
  SessionMetaInput,
  WireTrajectory
} from "./fusion-types.js";

/**
 * The fused panel as a model — the SDK's central contract.
 *
 * `FusionBackend` implements the exact same {@link Backend} interface as a
 * single-model backend (`OpenAiBackend`, `MlxBackend`): the closure property
 * of fusion. Anything that drives a `Backend` — the gateway server, dialect
 * adapters, capture gateways, tests — drives a fused ensemble unchanged and
 * cannot tell the difference. Panel fanout, judging, synthesis, sessions,
 * budgets, and rate-limit failover all happen behind one `chat()` call.
 *
 * Per-request behavior is selected by the requested model id (fused routes vs
 * native passthrough) and each fused route's `k` (see `@fusionkit/protocol`
 * panel-k for the k algebra).
 */
export class FusionBackend implements Backend {
  readonly defaultModel: string | undefined;

  readonly #fusedRoutes: readonly FusedModelRoute[];
  readonly #passthrough: readonly PassthroughModel[];
  readonly #panelTimeoutMs: number;
  readonly #sessions: FusionSessionManager;
  readonly #cost: FusionCostMeter;
  readonly #turns: FusionTurnAssembler;
  readonly #vendor: FusionVendorProxy;
  readonly #services: FrontdoorServices;
  readonly #pendingWrites = new PendingSessionWrites();

  constructor(options: FusionBackendOptions) {
    this.defaultModel = options.defaultModel;
    this.#fusedRoutes = options.fusedModels ?? [];
    this.#passthrough = options.passthrough ?? [];
    this.#panelTimeoutMs = options.panelTimeoutMs ?? DEFAULT_PANEL_TIMEOUT_MS;
    const logger = options.logger ?? defaultFusionGatewayLogger;
    const mintTraceId = options.mintTraceId ?? newTraceId;
    const kernelStateStore = options.kernelStateStore ?? new InMemoryFusionBackendKernelStateStore();
    const runFuseStep =
      options.runFuseStep ??
      ((request) =>
        fetch(request.stepUrl, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          ...(request.signal ? { signal: request.signal } : {})
        }));
    this.#sessions = new FusionSessionManager({
      ttlMs: options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      runPanels: options.runPanels,
      mintTraceId,
      kernelStateStore,
      store: options.store,
      resumeId: options.resumeId,
      sessionMeta: options.sessionMeta ?? {},
      defaultModel: this.defaultModel,
      logger,
      pendingWrites: this.#pendingWrites
    });
    this.#cost = new FusionCostMeter({
      budgetUsd: options.budgetUsd,
      pricing: options.pricing ?? {},
      localCompute: options.localCompute ?? {},
      localModels: new Set(options.localModels ?? []),
      kernelStateStore,
      store: options.store,
      logger,
      pendingWrites: this.#pendingWrites
    });
    this.#turns = new FusionTurnAssembler({
      stepUrl: options.stepUrl,
      runFuseStep,
      stepTimeoutMs: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      defaultModel: this.defaultModel,
      judgeModel: options.judgeModel,
      costModel: options.costModel,
      reasoningTraces: options.reasoningTraces ?? true,
      narrationWriter: options.narrationWriter,
      logger,
      sessionManager: this.#sessions,
      costMeter: this.#cost,
      routeFor: (req) => this.#routeFor(req),
      signalFor: (req) => this.#signalFor(req)
    });
    this.#vendor = new FusionVendorProxy({
      defaultModel: this.defaultModel,
      onRateLimit: options.onRateLimit ?? "fusion",
      logger,
      costMeter: this.#cost,
      passthroughFor: (model) => this.#passthroughFor(model),
      signalFor: (req) => this.#signalFor(req)
    });
    this.#services = this.#buildServices(logger);
  }

  /**
   * Await every session/turn/cost write still in flight. Persistence is
   * detached from the request path, so hosts must call this on shutdown or
   * the tail of the session store is silently dropped.
   */
  flush(): Promise<void> {
    return this.#pendingWrites.flush();
  }

  listModelIds(): readonly string[] {
    const fusion = this.defaultModel ?? this.#defaultRoute()?.modelId ?? FUSION_PANEL_MODEL;
    const ids = [fusion];
    for (const route of this.#fusedRoutes) {
      if (!ids.includes(route.modelId)) ids.push(route.modelId);
    }
    for (const entry of this.#passthrough) {
      if (!ids.includes(entry.modelId)) ids.push(entry.modelId);
    }
    return ids;
  }

  resolveModel(requested: string | undefined): string | undefined {
    const fused = this.#fusedFor(requested);
    if (fused !== undefined) return fused.modelId;
    const native = this.#passthroughFor(requested);
    if (native !== undefined) return native.modelId;
    return this.defaultModel;
  }

  /** Exact-id serve check: a fused route or a registered passthrough (no default fold). */
  servesModel(model: string): boolean {
    if (this.#fusedFor(model) !== undefined || this.#passthroughFor(model) !== undefined) return true;
    // Single/implicit-ensemble configs register no explicit fused routes; the
    // advertised default fused id (and its Claude alias) is still served here.
    const fusionDefault = this.defaultModel ?? this.#defaultRoute()?.modelId ?? FUSION_PANEL_MODEL;
    return model === fusionDefault || model === `${CLAUDE_ALIAS_PREFIX}${fusionDefault}`;
  }

  async chat(body: unknown, signal?: AbortSignal, options: BackendRequestOptions = {}): Promise<Response> {
    const chat = (body ?? {}) as ChatBody;
    // `FusionBackend` is public SDK surface, so it guards its own boundary in
    // addition to the HTTP doors: a non-string `model` used to reach route
    // resolution and explode as a 502 TypeError ("requested.startsWith is not
    // a function"), and an empty fused turn leaked panel internals ("proposal
    // mode (k=1) needs the caller's `messages`") as a 502. Both are caller
    // errors and must answer 400 without any panel fanout.
    if (chat.model !== undefined && typeof (chat.model as unknown) !== "string") {
      return invalidRequest("`model` must be a string");
    }
    if (!Array.isArray(chat.messages)) {
      return invalidRequest("`messages` is required and must be an array");
    }
    const messages = chat.messages;
    if (messages.length === 0) {
      return invalidRequest("the request contains no messages");
    }
    const req: FrontdoorRequestValue = {
      requestId: newSpanId(),
      chat,
      sessionKey: this.#sessions.resolveSessionId(messages, this.#sessionScope(chat.model)),
      turn: messages.filter(
        (message: ChatMessageLike) => message.role === "user" && !isHarnessNotification(message)
      ).length,
      streaming: chat.stream === true,
      ...(panelDepthFromRequest(options) > 0
        ? { panelDepth: panelDepthFromRequest(options) }
        : {}),
      ...(options.modelCallId !== undefined ? { modelCallId: options.modelCallId } : {}),
      ...(options.translated === true ? { suppressChatKeepalive: true } : {}),
      ...(signal !== undefined ? { [FRONTDOOR_SIGNAL]: signal } : {})
    };
    return runFrontdoorRequest(this.#services, req);
  }

  models(): Promise<Response> {
    const data = this.listModelIds().map((id) => ({
      id,
      object: "model",
      owned_by: "fusion-gateway"
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ object: "list", data }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
  }

  embeddings(): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "embeddings are not supported by the fusion gateway" } }), {
        status: 501,
        headers: { "content-type": "application/json" }
      })
    );
  }

  #buildServices(logger: FrontdoorServices["logger"]): FrontdoorServices {
    return {
      logger,
      budgetUsd: this.#cost.budgetUsd,
      costTotalUsd: (sessionKey) => this.#cost.costFor(sessionKey).totalUsd,
      budgetStopResponse: (req) => this.#cost.budgetStop(req.streaming, req.sessionKey),
      isNativeModel: (model) => this.#passthroughFor(model) !== undefined,
      resolvePanelCandidates: (req) => this.#resolvePanelCandidates(req),
      runFuseStep: (req, candidates) => this.#turns.runFuseStepBuffered(req, candidates),
      openFuseStream: (req, candidates) => this.#turns.openFuseStream(req, candidates),
      finalizeFused: (req, response) => this.#turns.finalizeFused(req, response),
      meterAndTraceStream: (req, buffer) => this.#turns.meterAndTraceStream(req, buffer),
      onFuseUpstreamError: (req, status, detail) => this.#turns.onFuseUpstreamError(req, status, detail),
      onFuseException: (req, message) => this.#turns.onFuseException(req, message),
      proxyVendor: (req) => this.#vendor.proxy(req),
      evictTurn: (req) => this.#sessions.evictTurnFor(req.sessionKey, req.turn),
      openTurnNarration: (req) => this.#turns.openTurnNarration(req)
    };
  }

  async #resolvePanelCandidates(req: FrontdoorRequestValue): Promise<readonly WireTrajectory[]> {
    const session = this.#sessions.ensureSession(req.sessionKey);
    const route = this.#routeFor(req);
    const signal = this.#signalFor(req);
    const turnCandidates = this.#sessions.ensureTurnCandidates({
      session,
      sessionKey: req.sessionKey,
      turn: req.turn,
      messages: req.chat.messages ?? [],
      ensembleModelId: route?.modelId,
      excludeModelIds: req.excludeModelIds,
      panelDepth: req.panelDepth,
      // Lossless projection: the panel input always describes the full
      // situation (tools, tool_choice, k). What consumes what is the panel
      // runner's single decision (k=1 members propose against the caller's
      // toolset, B7; rollout members never see it, B20) — enforced in
      // `runPanelRound`, not re-encoded here.
      ...(req.chat.tools !== undefined ? { tools: req.chat.tools } : {}),
      ...(req.chat.tool_choice !== undefined ? { toolChoice: req.chat.tool_choice } : {}),
      ...(req.chat.temperature !== undefined ? { temperature: req.chat.temperature } : {}),
      ...(req.chat.top_p !== undefined ? { topP: req.chat.top_p } : {}),
      ...(req.chat.max_tokens !== undefined ? { maxTokens: req.chat.max_tokens } : {}),
      ...(req.chat.max_completion_tokens !== undefined
        ? { maxCompletionTokens: req.chat.max_completion_tokens }
        : {}),
      ...(req.chat.seed !== undefined ? { seed: req.chat.seed } : {}),
      ...(req.chat.reasoning !== undefined ? { reasoning: req.chat.reasoning } : {}),
      ...(req.chat.provider !== undefined ? { provider: req.chat.provider } : {}),
      ...(req.chat.usage !== undefined ? { usage: req.chat.usage } : {}),
      ...(req.chat.parallel_tool_calls !== undefined
        ? { parallelToolCalls: req.chat.parallel_tool_calls }
        : {}),
      ...(isFiniteK(route?.k) ? { k: route.k } : {}),
      ...(signal !== undefined ? { signal } : {})
    });
    const candidates = await withTimeout(
      turnCandidates.candidates,
      this.#panelTimeoutMs,
      "fusion panel",
      (error) => turnCandidates.abort(error)
    );
    // Finite-k rounds run a fresh panel per request, so each round's candidate
    // cost is new; drop the per-turn metering latch that exists to avoid
    // double-metering a cached panel.
    if (isFiniteK(route?.k)) session.meteredPanelTurns.delete(req.turn);
    this.#cost.meterPanelCandidates({
      sessionId: session.id,
      turn: req.turn,
      trace: session.trace,
      meteredPanelTurns: session.meteredPanelTurns,
      candidates
    });
    if (!hasUsableCandidates(candidates)) {
      if (candidates.length === 0) throw new Error("fusion panel produced no candidates");
      const breakdown = candidates
        .map((candidate) => `${candidate.model_id || candidate.trajectory_id}: ${candidate.status}`)
        .join(", ");
      throw new Error(`fusion panel produced no usable candidates (every model failed) — ${breakdown}`);
    }
    return candidates;
  }

  #signalFor(req: FrontdoorRequestValue): AbortSignal | undefined {
    return req[FRONTDOOR_SIGNAL];
  }

  #fusedFor(requested: string | undefined): FusedModelRoute | undefined {
    if (requested === undefined || requested.length === 0) return undefined;
    const direct = this.#fusedRoutes.find((route) => route.modelId === requested);
    if (direct !== undefined) return direct;
    if (requested.startsWith(CLAUDE_ALIAS_PREFIX)) {
      const stripped = requested.slice(CLAUDE_ALIAS_PREFIX.length);
      return this.#fusedRoutes.find((route) => route.modelId === stripped);
    }
    return undefined;
  }

  #defaultRoute(): FusedModelRoute | undefined {
    if (this.#fusedRoutes.length === 0) return undefined;
    return this.#fusedRoutes.find((route) => route.modelId === this.defaultModel) ?? this.#fusedRoutes[0];
  }

  #routeFor(req: FrontdoorRequestValue): FusedModelRoute | undefined {
    return this.#fusedFor(req.chat.model) ?? this.#defaultRoute();
  }

  #passthroughFor(requested: string | undefined): PassthroughModel | undefined {
    if (requested === undefined || requested.length === 0) return undefined;
    if (this.#fusedFor(requested) !== undefined) return undefined;
    const direct = this.#passthrough.find(
      (entry) => entry.modelId === requested || entry.endpointId === requested
    );
    if (direct !== undefined) return direct;
    if (requested.startsWith(CLAUDE_ALIAS_PREFIX)) {
      const stripped = requested.slice(CLAUDE_ALIAS_PREFIX.length);
      return this.#passthrough.find(
        (entry) => entry.modelId === stripped || entry.endpointId === stripped
      );
    }
    return undefined;
  }

  #sessionScope(model: string | undefined): string | undefined {
    if (this.#fusedRoutes.length <= 1) return undefined;
    if (this.#passthroughFor(model) !== undefined) return undefined;
    return (this.#fusedFor(model) ?? this.#defaultRoute())?.modelId;
  }
}
