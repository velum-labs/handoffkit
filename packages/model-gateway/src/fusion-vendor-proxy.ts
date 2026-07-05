import { emitTrace, getTraceEmitter, newSpanId } from "@fusionkit/protocol";
import { FUSION_PANEL_MODEL } from "@fusionkit/registry";

import { joinPath } from "./backend.js";
import type { FrontdoorRequestValue, VendorProxyOutcome } from "./frontdoor/types.js";
import type { FusionGatewayLogger } from "./logger.js";
import { errorEvent, finishChunk, noticeChunk, sseResponse } from "./sse-wire.js";
import { parseUsageFromSse } from "./cost.js";
import { FusionCostMeter, providerCostFromSse, usageWithProviderCost } from "./fusion-cost-meter.js";
import {
  failoverNotice,
  failureFromErrorObject,
  firstSseSignal,
  isFailoverWorthy,
  normalizeFailoverCategory,
  rebuildErrorResponse,
  resumeNotice,
  sseEventError
} from "./fusion-failover.js";
import { errorText } from "./fusion-session.js";
import type {
  FailoverCategory,
  FailoverDecision,
  OnRateLimitPolicy,
  PassthroughModel,
  ProxyFailure
} from "./fusion-types.js";

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "fusion_error" } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

export type FusionVendorProxyOptions = {
  defaultModel?: string;
  onRateLimit: OnRateLimitPolicy;
  mintTraceId: () => string;
  logger: FusionGatewayLogger;
  costMeter: FusionCostMeter;
  passthroughFor: (requested: string | undefined) => PassthroughModel | undefined;
  signalFor: (req: FrontdoorRequestValue) => AbortSignal | undefined;
};

export class FusionVendorProxy {
  readonly #defaultModel: string | undefined;
  readonly #onRateLimit: OnRateLimitPolicy;
  readonly #mintTraceId: () => string;
  readonly #logger: FusionGatewayLogger;
  readonly #cost: FusionCostMeter;
  readonly #passthroughFor: (requested: string | undefined) => PassthroughModel | undefined;
  readonly #signalFor: (req: FrontdoorRequestValue) => AbortSignal | undefined;

  constructor(options: FusionVendorProxyOptions) {
    this.#defaultModel = options.defaultModel;
    this.#onRateLimit = options.onRateLimit;
    this.#mintTraceId = options.mintTraceId;
    this.#logger = options.logger;
    this.#cost = options.costMeter;
    this.#passthroughFor = options.passthroughFor;
    this.#signalFor = options.signalFor;
  }

  async proxy(req: FrontdoorRequestValue): Promise<VendorProxyOutcome> {
    const target = this.#passthroughFor(req.chat.model);
    if (target === undefined) throw new Error("vendor proxy invoked without a native model");
    const chat = req.chat;
    const signal = this.#signalFor(req);
    const traceId = this.#mintTraceId();
    const spanId = newSpanId();
    const costSessionId = req.sessionKey;
    const traceEnabled = getTraceEmitter().isEnabled();
    if (traceEnabled) {
      emitTrace({
        component: "gateway",
        event_type: "session.started",
        traceId,
        spanId,
        payload: { dialect: "native-passthrough", model: target.modelId, endpoint_id: target.endpointId }
      });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (req.modelCallId) headers["x-velum-model-call-id"] = req.modelCallId;
    const body = JSON.stringify({ ...chat, model: target.endpointId });
    const response = await fetch(joinPath(target.endpointUrl, "/v1/chat/completions"), {
      method: "POST",
      headers,
      body,
      ...(signal ? { signal } : {})
    });
    if (traceEnabled) {
      emitTrace({
        component: "gateway",
        event_type: "session.finished",
        traceId,
        spanId,
        payload: {
          status: response.ok ? "succeeded" : "failed",
          model: target.modelId,
          endpoint_id: target.endpointId,
          http_status: response.status
        }
      });
    }

    if (this.#onRateLimit === "passthrough") {
      await this.#cost.meterResponseClone(response, costSessionId, target.modelId, traceId, spanId);
      return { kind: "response", response };
    }

    if (!response.ok) {
      const { failure, bodyText } = await this.#readErrorBody(response);
      return this.#classifyPreStreamFailure(target, failure, req.streaming, () =>
        rebuildErrorResponse(response.status, response.headers.get("content-type"), bodyText)
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (chat.stream === true && contentType.includes("text/event-stream") && response.body !== null) {
      return this.#proxyVendorStream(response.body, target, req, costSessionId);
    }
    await this.#cost.meterResponseClone(response, costSessionId, target.modelId, traceId, spanId);
    return { kind: "response", response };
  }

  async #readErrorBody(response: Response): Promise<{ failure: ProxyFailure; bodyText: string }> {
    const bodyText = await response.text();
    try {
      const json = JSON.parse(bodyText) as Record<string, unknown>;
      const err =
        json.error !== null && typeof json.error === "object"
          ? (json.error as Record<string, unknown>)
          : json;
      return { failure: failureFromErrorObject(err, response.status), bodyText };
    } catch {
      return {
        failure: {
          category: normalizeFailoverCategory(undefined, response.status),
          status: response.status,
          message: bodyText.slice(0, 300)
        },
        bodyText
      };
    }
  }

  #decideFailover(category: FailoverCategory): FailoverDecision {
    if (!isFailoverWorthy(category)) return "fail-fast";
    return this.#onRateLimit === "fail" ? "fail-error" : "failover";
  }

  #classifyPreStreamFailure(
    target: PassthroughModel,
    failure: ProxyFailure,
    streaming: boolean,
    verbatim: () => Response
  ): VendorProxyOutcome {
    const decision = this.#decideFailover(failure.category);
    switch (decision) {
      case "fail-fast":
        this.#logger.error(
          `fusion: ${target.modelId} failed (${failure.category}); not failing over to the ensemble.`
        );
        return { kind: "response", response: verbatim() };
      case "fail-error": {
        const message =
          `${target.modelId} ${failure.category} (${failure.message}); ` +
          `failover disabled by --on-rate-limit fail`;
        this.#logger.error(`fusion: ${message}`);
        return {
          kind: "response",
          response: streaming
            ? sseResponse(errorEvent(`fusion error: ${message}`))
            : jsonError(failure.status ?? 429, message)
        };
      }
      case "failover":
        this.#logger.error(
          `fusion: ${target.modelId} ${failure.category}; handing the turn off to the ensemble.`
        );
        return {
          kind: "failover",
          excludeModelIds: [target.endpointId],
          notice: failoverNotice(target.modelId, failure)
        };
      default: {
        const unreachable: never = decision;
        throw new Error(`unhandled failover decision: ${String(unreachable)}`);
      }
    }
  }

  async #proxyVendorStream(
    upstream: ReadableStream<Uint8Array>,
    target: PassthroughModel,
    req: FrontdoorRequestValue,
    sessionId: string
  ): Promise<VendorProxyOutcome> {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let signalKind: "content" | "error" | "none" = "none";
    let preFailure: ProxyFailure | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) buffered += decoder.decode(value, { stream: true });
      const signalSeen = firstSseSignal(buffered);
      if (signalSeen.kind === "error") {
        signalKind = "error";
        preFailure = signalSeen.error;
        break;
      }
      if (signalSeen.kind === "content") {
        signalKind = "content";
        break;
      }
    }

    if (signalKind === "error" && preFailure !== undefined) {
      const decision = this.#decideFailover(preFailure.category);
      if (decision === "failover") {
        void reader.cancel().catch(() => undefined);
        return this.#classifyPreStreamFailure(target, preFailure, req.streaming, () => sseResponse(buffered));
      }
      if (decision === "fail-error") {
        const captured = buffered;
        void reader.cancel().catch(() => undefined);
        return this.#classifyPreStreamFailure(target, preFailure, req.streaming, () => sseResponse(captured));
      }
      return {
        kind: "response",
        response: this.#reconstructStream(buffered, reader, decoder, target, "verbatim", sessionId)
      };
    }

    return {
      kind: "response",
      response: this.#reconstructStream(buffered, reader, decoder, target, "resume-notice", sessionId)
    };
  }

  #reconstructStream(
    buffered: string,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: InstanceType<typeof TextDecoder>,
    target: PassthroughModel,
    onError: "verbatim" | "resume-notice",
    sessionId: string
  ): Response {
    const encoder = new TextEncoder();
    const fusedModel = this.#defaultModel ?? FUSION_PANEL_MODEL;
    const meter = (text: string): void => {
      const providerCost = providerCostFromSse(text);
      this.#cost.meterEntry(sessionId, {
        model: target.modelId,
        usage: usageWithProviderCost(parseUsageFromSse(text), providerCost),
        stage: "passthrough",
        ...(providerCost !== undefined ? { providerCost } : {})
      });
    };
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let pending = buffered;
        let meteredText = buffered;
        let terminated = false;
        const flush = (final: boolean): void => {
          for (;;) {
            const idx = pending.indexOf("\n\n");
            if (idx === -1) break;
            const event = pending.slice(0, idx + 2);
            pending = pending.slice(idx + 2);
            if (onError === "resume-notice" && sseEventError(event) !== undefined) {
              controller.enqueue(encoder.encode(noticeChunk(resumeNotice(target.modelId, fusedModel))));
              controller.enqueue(encoder.encode(finishChunk("stop")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              terminated = true;
              return;
            }
            controller.enqueue(encoder.encode(event));
          }
          if (final && pending.length > 0) {
            controller.enqueue(encoder.encode(pending));
            pending = "";
          }
        };
        try {
          flush(false);
          while (!terminated) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value !== undefined) {
              const decoded = decoder.decode(value, { stream: true });
              pending += decoded;
              meteredText += decoded;
            }
            flush(false);
          }
          if (!terminated) flush(true);
        } catch (error) {
          controller.enqueue(encoder.encode(errorEvent(`fusion error: ${errorText(error)}`)));
        } finally {
          meter(meteredText);
          void reader.cancel().catch(() => undefined);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    });
    return new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }
}
