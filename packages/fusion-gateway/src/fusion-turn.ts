import { ATTR, isFiniteK, panelModeForK } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { headersOf, isFusionTracingActive, jsonAttr, startFusionSpan } from "@fusionkit/tracing";
import type { FusionSpan } from "@fusionkit/tracing";
import { FUSION_PANEL_MODEL } from "@fusionkit/registry";
import { withDeadline } from "@velum-labs/routekit-runtime";

import { parseUsage } from "./cost.js";
import { createTurnNarrator, proposalsAgree, renderProposal, terminalProposal } from "./frontdoor/narration.js";
import type { NarrationWriter, ProposedCall, TurnNarration } from "./frontdoor/narration.js";
import type { FrontdoorRequestValue } from "./frontdoor/types.js";
import type { FusionGatewayLogger } from "./logger.js";
import { FusionCostMeter, providerCostFromPayload, usageWithProviderCost } from "./fusion-cost-meter.js";
import type { ProviderCostMetadata } from "./cost.js";
import { hasUsableCandidates, type FusionSessionManager } from "./fusion-session.js";
import { sseResponse } from "@velum-labs/routekit-gateway";
import { ChatStreamAssembler } from "@velum-labs/routekit-gateway";
import type { AssembledToolCall } from "@velum-labs/routekit-gateway";
import { decodeBufferedSse } from "@velum-labs/routekit-gateway";
import type {
  FusedModelRoute,
  FuseStepRunner,
  FusionBackendKernelSessionState
} from "./fusion-types.js";

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "fusion_error" } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** Normalize a buffered response's OpenAI `message.tool_calls` to the assembler shape. */
function assembledFromMessageToolCalls(toolCalls: unknown): AssembledToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call): call is Record<string, unknown> => call !== null && typeof call === "object")
    .map((call) => {
      const fn = (call.function ?? {}) as { name?: unknown; arguments?: unknown };
      return {
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        ...(typeof fn.name === "string" ? { name: fn.name } : {}),
        arguments: typeof fn.arguments === "string" ? fn.arguments : ""
      };
    });
}

/** The committed step's tool calls as a proposal batch (for pick matching). */
function committedCallsAsProposal(toolCalls: readonly AssembledToolCall[] | undefined): ProposedCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call) => ({
    ...(call.name !== undefined ? { name: call.name } : {}),
    ...(call.arguments.length > 0 ? { arguments: call.arguments } : {})
  }));
}

function synthesisOf(fusion: unknown): unknown {
  if (fusion === null || typeof fusion !== "object") return undefined;
  const trajectory = (fusion as { trajectory?: unknown }).trajectory;
  if (trajectory === null || typeof trajectory !== "object") return undefined;
  return (trajectory as { synthesis?: unknown }).synthesis;
}

function isTerminalJudgeStep(toolCalls: unknown, finishReason?: string): boolean {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  return calls.length === 0 && finishReason !== "tool_calls";
}

function synthesisField(synthesis: unknown, key: string): string | undefined {
  if (synthesis === null || typeof synthesis !== "object") return undefined;
  const value = (synthesis as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function usageTokens(usage: unknown): { input?: number; output?: number } | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const source = usage as Record<string, unknown>;
  const input = typeof source.prompt_tokens === "number" ? source.prompt_tokens : undefined;
  const output = typeof source.completion_tokens === "number" ? source.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}

export type FusionTurnAssemblerOptions = {
  stepUrl: string;
  runFuseStep: FuseStepRunner;
  stepTimeoutMs: number;
  defaultModel?: string;
  judgeModel?: string;
  costModel?: string;
  reasoningTraces: boolean;
  narrationWriter?: NarrationWriter;
  logger: FusionGatewayLogger;
  sessionManager: FusionSessionManager;
  costMeter: FusionCostMeter;
  routeFor: (req: FrontdoorRequestValue) => FusedModelRoute | undefined;
  signalFor: (req: FrontdoorRequestValue) => AbortSignal | undefined;
};

export class FusionTurnAssembler {
  readonly #stepUrl: string;
  readonly #runFuseStep: FuseStepRunner;
  readonly #stepTimeoutMs: number;
  readonly #defaultModel: string | undefined;
  readonly #judgeModel: string | undefined;
  readonly #costModel: string | undefined;
  readonly #reasoningTraces: boolean;
  readonly #narrationWriter: NarrationWriter | undefined;
  readonly #logger: FusionGatewayLogger;
  readonly #sessions: FusionSessionManager;
  readonly #cost: FusionCostMeter;
  readonly #routeFor: (req: FrontdoorRequestValue) => FusedModelRoute | undefined;
  readonly #signalFor: (req: FrontdoorRequestValue) => AbortSignal | undefined;
  /** Live judge span per front-door request (one judge phase per fused turn). */
  readonly #judgeSpans = new WeakMap<FrontdoorRequestValue, FusionSpan>();

  constructor(options: FusionTurnAssemblerOptions) {
    this.#stepUrl = options.stepUrl;
    this.#runFuseStep = options.runFuseStep;
    this.#stepTimeoutMs = options.stepTimeoutMs;
    this.#defaultModel = options.defaultModel;
    this.#judgeModel = options.judgeModel;
    this.#costModel = options.costModel;
    this.#reasoningTraces = options.reasoningTraces;
    this.#narrationWriter = options.narrationWriter;
    this.#logger = options.logger;
    this.#sessions = options.sessionManager;
    this.#cost = options.costMeter;
    this.#routeFor = options.routeFor;
    this.#signalFor = options.signalFor;
  }

  openTurnNarration(req: FrontdoorRequestValue): TurnNarration | undefined {
    if (!this.#reasoningTraces) return undefined;
    const session = this.#sessions.ensureSession(req.sessionKey);
    const judgeModel = this.#judgeModelNameFor(req);
    const k = this.#routeFor(req)?.k;
    return createTurnNarrator({
      traceId: session.traceId,
      trace: session.trace,
      turn: req.turn,
      round: this.#sessions.nextNarrationRound(req.sessionKey, req.turn),
      ...(judgeModel !== undefined ? { judgeModel } : {}),
      ...(session.lastJudgePick !== undefined ? { lastPick: session.lastJudgePick } : {}),
      ...(session.lastAgreedStep !== undefined ? { lastAgreed: session.lastAgreedStep } : {}),
      ...(k !== undefined ? { k } : {}),
      ...(this.#narrationWriter !== undefined ? { writer: this.#narrationWriter } : {})
    });
  }

  runFuseStepBuffered(req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]): Promise<Response> {
    const session = this.#sessions.ensureSession(req.sessionKey);
    this.#emitJudgeRequest(req, session, candidates);
    return this.#runFuseStep({
      stepUrl: this.#stepUrl,
      headers: this.#buildHeaders(req),
      body: this.#buildStepBody(req, candidates),
      signal: withDeadline(this.#signalFor(req), this.#stepTimeoutMs),
      streaming: false
    });
  }

  openFuseStream(req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]): Promise<Response> {
    const session = this.#sessions.ensureSession(req.sessionKey);
    this.#emitJudgeRequest(req, session, candidates);
    if (process.env.FUSION_DEBUG) {
      const messages = req.chat.messages ?? [];
      const toolNames = Array.isArray(req.chat.tools)
        ? req.chat.tools.map((t) => {
            const tool = t as { type?: string; name?: string; function?: { name?: string } };
            return tool.function?.name ?? tool.name ?? tool.type ?? "?";
          })
        : [];
      this.#logger.error(
        `[fusion-debug] step: messages=${messages.length} roles=${messages.map((m) => m.role).join(",")} ` +
          `candidates=${candidates.length} tools=[${toolNames.join(", ")}]`
      );
    }
    return this.#runFuseStep({
      stepUrl: this.#stepUrl,
      headers: this.#buildHeaders(req),
      body: this.#buildStepBody(req, candidates),
      signal: withDeadline(this.#signalFor(req), this.#stepTimeoutMs),
      streaming: true
    });
  }

  async finalizeFused(req: FrontdoorRequestValue, response: Response): Promise<Response> {
    const session = this.#sessions.ensureSession(req.sessionKey);
    const fusedCostModel = this.#fusedCostModel(req);
    if (req.notice !== undefined) {
      if (!response.ok) return response;
      let payload: Record<string, unknown>;
      try {
        payload = (await response.json()) as Record<string, unknown>;
      } catch {
        return jsonError(502, "fusion failover produced an unreadable response");
      }
      const choice = (Array.isArray(payload.choices) ? payload.choices[0] : undefined) as
        | { message?: { content?: unknown } }
        | undefined;
      if (choice?.message !== undefined) {
        const existing = typeof choice.message.content === "string" ? choice.message.content : "";
        const merged = `${req.notice}${existing}`;
        choice.message.content = merged;
        this.#emitJudgeFinal(req, session, { httpStatus: 200, content: merged });
      }
      const providerCost = providerCostFromPayload(payload);
      this.#cost.meterEntry(
        req.sessionKey,
        {
          model: fusedCostModel,
          usage: usageWithProviderCost(parseUsage(payload.usage), providerCost),
          stage: "judge_synth",
          turn: req.turn,
          ...(providerCost !== undefined ? { providerCost } : {})
        },
        session.trace
      );
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    this.#traceBufferedResponse(req, response, session);
    await this.#cost.meterResponseClone(
      response,
      req.sessionKey,
      fusedCostModel,
      session.trace,
      "judge_synth",
      req.turn
    );
    return response;
  }

  meterAndTraceStream(req: FrontdoorRequestValue, sseBuffer: string): void {
    const session = this.#sessions.ensureSession(req.sessionKey);
    // Single pass: decode the buffered fuse-step SSE once and fold every event
    // through one ChatStreamAssembler, extracting provider cost from the same
    // parsed chunks — instead of re-splitting the buffer three times (usage,
    // provider cost, content/tool-calls). The assembler's merge rules also fix
    // the old per-fragment tool-call mis-attribution: fragmented arguments are
    // merged by index/id rather than pushed as separate raw fragments.
    const assembler = new ChatStreamAssembler();
    let providerCost: ProviderCostMetadata | undefined;
    for (const event of decodeBufferedSse(sseBuffer)) {
      if (event.data.length === 0 || event.data === "[DONE]") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // Best-effort metering/tracing over a buffered stream: skip a non-JSON line.
        continue;
      }
      assembler.pushParsed(parsed);
      const candidate = providerCostFromPayload(parsed);
      if (candidate !== undefined) providerCost = candidate;
    }
    const turn = assembler.result();
    this.#cost.meterEntry(
      req.sessionKey,
      {
        model: this.#fusedCostModel(req),
        usage: usageWithProviderCost(parseUsage(turn.usage), providerCost),
        stage: "judge_synth",
        turn: req.turn,
        ...(providerCost !== undefined ? { providerCost } : {})
      },
      session.trace
    );
    this.#stashJudgePick(session, req.turn, turn.extensions.fusion, turn.toolCalls);
    if (!isFusionTracingActive()) return;
    if (isTerminalJudgeStep(turn.toolCalls, turn.finishReason)) {
      const synthesis = synthesisOf(turn.extensions.fusion);
      this.#emitJudgeFinal(req, session, {
        httpStatus: 200,
        ...(turn.content.length > 0 ? { content: turn.content } : {}),
        ...(synthesis !== undefined ? { synthesis } : {}),
        ...(turn.usage !== undefined ? { usage: turn.usage } : {})
      });
    } else {
      this.#emitJudgeStep(req, session, {
        ...(turn.content.length > 0 ? { content: turn.content } : {}),
        toolCalls: turn.toolCalls,
        ...(turn.usage !== undefined ? { usage: turn.usage } : {})
      });
    }
  }

  onFuseUpstreamError(req: FrontdoorRequestValue, status: number, detail: string): void {
    this.#emitJudgeFinal(req, this.#sessions.ensureSession(req.sessionKey), { httpStatus: status, error: detail });
  }

  onFuseException(req: FrontdoorRequestValue, message: string): void {
    this.#emitJudgeFinal(req, this.#sessions.ensureSession(req.sessionKey), { error: message });
  }

  #buildStepBody(req: FrontdoorRequestValue, candidates: readonly WireTrajectory[]): string {
    const stepBody: Record<string, unknown> = {
      model: req.chat.model ?? this.#defaultModel ?? FUSION_PANEL_MODEL,
      messages: req.chat.messages ?? [],
      trajectories: candidates,
      stream: req.streaming
    };
    if (req.chat.tools !== undefined) stepBody.tools = req.chat.tools;
    if (req.chat.tool_choice !== undefined) stepBody.tool_choice = req.chat.tool_choice;
    if (req.chat.reasoning_effort !== undefined) {
      stepBody.reasoning_effort = req.chat.reasoning_effort;
    }
    const route = this.#routeFor(req);
    // Finite k fuses receding-horizon step proposals (candidates end in a
    // proposed tool-call batch); the router selects step-mode judge/synth
    // prompts. Absent field = trajectory mode (back-compat).
    if (isFiniteK(route?.k)) stepBody.panel_mode = panelModeForK(route.k);
    const judgeModel = route?.judgeRoutekitModelId ?? this.#judgeModel;
    if (judgeModel !== undefined) stepBody.judge_model = judgeModel;
    if (route?.synthesizerRoutekitModelId !== undefined) {
      stepBody.synthesizer_model = route.synthesizerRoutekitModelId;
    }
    if (route?.prompts !== undefined && Object.keys(route.prompts).length > 0) stepBody.prompts = route.prompts;
    return JSON.stringify(stepBody);
  }

  #buildHeaders(req: FrontdoorRequestValue): Record<string, string> {
    const judgeSpan = this.#judgeSpans.get(req);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The Python fuse step continues this turn's judge span via traceparent.
      ...(judgeSpan !== undefined ? headersOf(judgeSpan.carrier) : {})
    };
    if (req.modelCallId) headers["x-velum-model-call-id"] = req.modelCallId;
    return headers;
  }

  #fusedCostModel(req?: FrontdoorRequestValue): string {
    const routeJudge = req !== undefined ? this.#routeFor(req)?.judgeModelName : undefined;
    return routeJudge ?? this.#costModel ?? this.#defaultModel ?? FUSION_PANEL_MODEL;
  }

  #judgeModelNameFor(req: FrontdoorRequestValue): string | undefined {
    return this.#routeFor(req)?.judgeModelName ?? this.#judgeModel;
  }

  /** The turn's judge span: opened at the first judge signal, ended at judge final. */
  #judgeSpan(req: FrontdoorRequestValue, session: FusionBackendKernelSessionState): FusionSpan {
    const existing = this.#judgeSpans.get(req);
    if (existing !== undefined) return existing;
    const judgeModel = this.#judgeModelNameFor(req);
    const span = startFusionSpan("judge", "fusion.judge", session.trace, {
      [ATTR.FUSION_TURN]: req.turn,
      [ATTR.FUSION_JUDGE_MODEL]: judgeModel,
      [ATTR.FUSION_SESSION_ID]: req.sessionKey
    });
    this.#judgeSpans.set(req, span);
    return span;
  }

  #emitJudgeRequest(
    req: FrontdoorRequestValue,
    session: FusionBackendKernelSessionState,
    candidates: readonly WireTrajectory[]
  ): void {
    if (!isFusionTracingActive()) return;
    const judgeModel = this.#judgeModelNameFor(req);
    this.#judgeSpan(req, session).event("judge", "fusion.judge.request", {
      [ATTR.FUSION_JUDGE_MODEL]: judgeModel,
      [ATTR.FUSION_TURN]: req.turn,
      [ATTR.FUSION_MESSAGES]: jsonAttr(req.chat.messages ?? []),
      [ATTR.FUSION_TRAJECTORIES]: jsonAttr([...candidates]),
      [ATTR.FUSION_TOOLS]: jsonAttr(req.chat.tools),
      [ATTR.FUSION_TRAJECTORY_IDS]: candidates.map((candidate) => String(candidate.trajectory_id))
    });
  }

  #emitJudgeFinal(
    req: FrontdoorRequestValue,
    session: FusionBackendKernelSessionState,
    input: {
      httpStatus?: number;
      content?: string;
      finalOutput?: string;
      synthesis?: unknown;
      usage?: unknown;
      error?: string;
    }
  ): void {
    if (this.#judgeSpans.get(req) === undefined && !isFusionTracingActive()) return;
    const span = this.#judgeSpan(req, session);
    const usage = usageTokens(input.usage);
    const finalOutput = input.finalOutput ?? input.content;
    span.end({
      status: input.error !== undefined ? "failed" : "succeeded",
      ...(input.error !== undefined ? { error: input.error } : {}),
      attributes: {
        [ATTR.FUSION_TURN]: req.turn,
        [ATTR.FUSION_FINAL_OUTPUT]: finalOutput,
        [ATTR.FUSION_CONTENT]: input.content,
        [ATTR.FUSION_SYNTHESIS]: jsonAttr(input.synthesis),
        [ATTR.FUSION_DECISION]: synthesisField(input.synthesis, "decision"),
        [ATTR.FUSION_SELECTED_TRAJECTORY_ID]: synthesisField(input.synthesis, "selected_trajectory_id"),
        [ATTR.FUSION_RATIONALE]: synthesisField(input.synthesis, "rationale"),
        [ATTR.FUSION_USAGE]: jsonAttr(input.usage),
        [ATTR.GEN_AI_USAGE_INPUT_TOKENS]: usage?.input,
        [ATTR.GEN_AI_USAGE_OUTPUT_TOKENS]: usage?.output,
        "http.response.status_code": input.httpStatus
      }
    });
    this.#judgeSpans.delete(req);
  }

  #emitJudgeStep(
    req: FrontdoorRequestValue,
    session: FusionBackendKernelSessionState,
    input: { content?: string; toolCalls?: unknown[]; usage?: unknown }
  ): void {
    if (this.#judgeSpans.get(req) === undefined && !isFusionTracingActive()) return;
    const toolCallCount = input.toolCalls?.length ?? 0;
    const rawAnalysis =
      input.content !== undefined && input.content.length > 0
        ? input.content
        : `judge requested ${toolCallCount} tool call(s)`;
    this.#judgeSpan(req, session).event("judge", "fusion.judge.thinking", {
      [ATTR.FUSION_TURN]: req.turn,
      [ATTR.FUSION_RAW_ANALYSIS]: rawAnalysis,
      [ATTR.FUSION_CONTENT]: input.content,
      [ATTR.FUSION_TERMINAL]: false,
      [ATTR.FUSION_TOOL_CALLS]: jsonAttr(input.toolCalls),
      [ATTR.FUSION_USAGE]: jsonAttr(input.usage)
    });
  }

  #traceBufferedResponse(
    req: FrontdoorRequestValue,
    response: Response,
    session: FusionBackendKernelSessionState
  ): void {
    if (!isFusionTracingActive()) return;
    const clone = response.clone();
    void (async () => {
      try {
        if (!clone.ok) {
          this.#emitJudgeFinal(req, session, {
            httpStatus: clone.status,
            error: (await clone.text()).slice(0, 2000)
          });
          return;
        }
        const judged = (await clone.json()) as {
          choices?: Array<{ message?: { content?: string; tool_calls?: unknown }; finish_reason?: string }>;
          usage?: unknown;
          fusion?: unknown;
        };
        const choice = judged.choices?.[0];
        const message = choice?.message;
        const content = typeof message?.content === "string" ? message.content : undefined;
        const toolCalls = assembledFromMessageToolCalls(message?.tool_calls);
        // Remember the adopted candidate for the next round's narration opener
        // (the streaming path stashes from its assembled SSE; buffered turns
        // stash here so mixed sessions never lose the pick).
        this.#stashJudgePick(session, req.turn, judged.fusion, toolCalls);
        if (isTerminalJudgeStep(toolCalls, choice?.finish_reason)) {
          const synthesis = synthesisOf(judged.fusion);
          this.#emitJudgeFinal(req, session, {
            httpStatus: clone.status,
            ...(content !== undefined ? { content } : {}),
            ...(synthesis !== undefined ? { synthesis } : {}),
            ...(judged.usage !== undefined ? { usage: judged.usage } : {})
          });
        } else {
          this.#emitJudgeStep(req, session, {
            ...(content !== undefined ? { content } : {}),
            toolCalls,
            ...(judged.usage !== undefined ? { usage: judged.usage } : {})
          });
        }
      } catch {
        // best-effort judge.final
      }
    })();
  }

  /**
   * Remember which candidate the fuse adopted, for the next round's narration
   * opener. Terminal responses carry it as the synthesis's selected
   * trajectory; non-terminal step responses carry the judge's
   * `analysis.best_trajectory` (the adopted proposal's candidate). When the
   * judge named no candidate (a tie: several proposed the same step), the
   * committed batch itself identifies the adopted proposal — fall back to
   * matching it against the candidates' terminal proposals. A unique match is
   * a pick; several matches mean the panel agreed on the step, which is its
   * own honest opener (`lastAgreedStep`) rather than an arbitrary attribution.
   */
  #stashJudgePick(
    session: FusionBackendKernelSessionState,
    turn: number,
    fusion: unknown,
    committedToolCalls?: readonly AssembledToolCall[]
  ): void {
    const extension = (fusion !== null && typeof fusion === "object" ? fusion : {}) as {
      trajectory?: { synthesis?: { selected_trajectory_id?: unknown } | null };
      analysis?: { best_trajectory?: unknown };
    };
    const selected =
      extension.trajectory?.synthesis?.selected_trajectory_id ?? extension.analysis?.best_trajectory;
    const selectedId = typeof selected === "string" && selected.length > 0 ? selected : undefined;
    const committed = committedCallsAsProposal(committedToolCalls);
    if (selectedId === undefined && committed.length === 0) return;
    const candidates = session.turns.get(turn);
    if (candidates === undefined) return;
    void candidates.then(
      (resolved) => {
        session.lastJudgePick = undefined;
        session.lastAgreedStep = undefined;
        let match = selectedId !== undefined
          ? resolved.find((candidate) => candidate.trajectory_id === selectedId)
          : undefined;
        if (match === undefined && committed.length > 0) {
          const proposers = resolved.filter((candidate) =>
            proposalsAgree(terminalProposal(candidate), committed)
          );
          if (proposers.length === 1) match = proposers[0];
          else if (proposers.length > 1) {
            session.lastAgreedStep = renderProposal(committed);
            return;
          }
        }
        if (match !== undefined && typeof match.model_id === "string" && match.model_id.length > 0) {
          session.lastJudgePick = match.model_id;
        }
      },
      () => undefined
    );
  }
}
