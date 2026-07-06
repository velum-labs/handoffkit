import { ATTR } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { headersOf, isFusionTracingActive, jsonAttr, startFusionSpan } from "@fusionkit/tracing";
import type { FusionSpan } from "@fusionkit/tracing";
import { FUSION_PANEL_MODEL } from "@fusionkit/registry";
import { withDeadline } from "@fusionkit/runtime-utils";

import { parseUsage, parseUsageFromSse } from "./cost.js";
import { createTurnNarrator } from "./frontdoor/narration.js";
import type { NarrationWriter, TurnNarration } from "./frontdoor/narration.js";
import type { FrontdoorRequestValue } from "./frontdoor/types.js";
import type { FusionGatewayLogger } from "./logger.js";
import { FusionCostMeter, providerCostFromPayload, providerCostFromSse, usageWithProviderCost } from "./fusion-cost-meter.js";
import { hasUsableCandidates, type FusionSessionManager } from "./fusion-session.js";
import { sseResponse } from "./sse-wire.js";
import type {
  FusedModelRoute,
  FuseStepRunner,
  FusionBackendKernelSessionState
} from "./fusion-types.js";

type AssembledStep = {
  content: string;
  usage?: unknown;
  toolCalls: unknown[];
  finishReason?: string;
  fusion?: unknown;
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "fusion_error" } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function assembleSseContent(buffer: string): AssembledStep {
  let content = "";
  let usage: unknown;
  let finishReason: string | undefined;
  let fusion: unknown;
  const toolCalls: unknown[] = [];
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
        usage?: unknown;
        fusion?: unknown;
      };
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string") content += delta;
      if (Array.isArray(choice?.delta?.tool_calls)) toolCalls.push(...choice.delta.tool_calls);
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
      if (json.usage !== undefined && json.usage !== null) usage = json.usage;
      if (json.fusion !== undefined && json.fusion !== null) fusion = json.fusion;
    } catch {
      // ignore partial/non-JSON lines
    }
  }
  return {
    content,
    toolCalls,
    ...(usage !== undefined ? { usage } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(fusion !== undefined ? { fusion } : {})
  };
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
    return createTurnNarrator({
      traceId: session.traceId,
      trace: session.trace,
      turn: req.turn,
      ...(judgeModel !== undefined ? { judgeModel } : {}),
      ...(session.lastJudgePick !== undefined ? { lastPick: session.lastJudgePick } : {}),
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
    const providerCost = providerCostFromSse(sseBuffer);
    this.#cost.meterEntry(
      req.sessionKey,
      {
        model: this.#fusedCostModel(req),
        usage: usageWithProviderCost(parseUsageFromSse(sseBuffer), providerCost),
        stage: "judge_synth",
        turn: req.turn,
        ...(providerCost !== undefined ? { providerCost } : {})
      },
      session.trace
    );
    const assembled = assembleSseContent(sseBuffer);
    this.#stashJudgePick(session, req.turn, synthesisOf(assembled.fusion));
    if (!isFusionTracingActive()) return;
    if (isTerminalJudgeStep(assembled.toolCalls, assembled.finishReason)) {
      const synthesis = synthesisOf(assembled.fusion);
      this.#emitJudgeFinal(req, session, {
        httpStatus: 200,
        ...(assembled.content.length > 0 ? { content: assembled.content } : {}),
        ...(synthesis !== undefined ? { synthesis } : {}),
        ...(assembled.usage !== undefined ? { usage: assembled.usage } : {})
      });
    } else {
      this.#emitJudgeStep(req, session, {
        ...(assembled.content.length > 0 ? { content: assembled.content } : {}),
        toolCalls: assembled.toolCalls,
        ...(assembled.usage !== undefined ? { usage: assembled.usage } : {})
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
    const route = this.#routeFor(req);
    const judgeModel = route?.judgeEndpointId ?? this.#judgeModel;
    if (judgeModel !== undefined) stepBody.judge_model = judgeModel;
    if (route?.synthesizerEndpointId !== undefined) stepBody.synthesizer_model = route.synthesizerEndpointId;
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
    this.#judgeSpan(req, session).marker("judge", "fusion.judge.request", {
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
    this.#judgeSpan(req, session).marker("judge", "fusion.judge.thinking", {
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
        const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
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

  #stashJudgePick(session: FusionBackendKernelSessionState, turn: number, synthesis: unknown): void {
    if (synthesis === null || typeof synthesis !== "object") return;
    const selected = (synthesis as { selected_trajectory_id?: unknown }).selected_trajectory_id;
    if (typeof selected !== "string" || selected.length === 0) return;
    const candidates = session.turns.get(turn);
    if (candidates === undefined) return;
    void candidates.then(
      (resolved) => {
        const match = resolved.find((candidate) => candidate.trajectory_id === selected);
        if (match !== undefined && typeof match.model_id === "string" && match.model_id.length > 0) {
          session.lastJudgePick = match.model_id;
        }
      },
      () => undefined
    );
  }
}
