import { ATTR } from "@fusionkit/protocol";
import { startFusionSpan } from "@fusionkit/tracing";
import { FUSION_PANEL_MODEL } from "@fusionkit/registry";

import { joinPath } from "@velum-labs/routekit-gateway";
import type { FrontdoorRequestValue, VendorProxyOutcome } from "./frontdoor/types.js";
import type { FusionGatewayLogger } from "./logger.js";
import { errorEvent, finishChunk, noticeChunk, sseResponse } from "@velum-labs/routekit-gateway";
import { parseUsageFromSse } from "./cost.js";
import { FusionCostMeter, providerCostFromSse, usageWithProviderCost } from "./fusion-cost-meter.js";
import {
  failoverNotice,
  failureFromErrorObject,
  isFailoverWorthy,
  normalizeFailoverCategory,
  rebuildErrorResponse,
  resumeNotice,
  sseEventError,
  sseObjectError,
  sseObjectHasContent
} from "./fusion-failover.js";
import { SseDecoder } from "@velum-labs/routekit-gateway";
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
  logger: FusionGatewayLogger;
  costMeter: FusionCostMeter;
  passthroughFor: (requested: string | undefined) => PassthroughModel | undefined;
  signalFor: (req: FrontdoorRequestValue) => AbortSignal | undefined;
};

export class FusionVendorProxy {
  readonly #defaultModel: string | undefined;
  readonly #onRateLimit: OnRateLimitPolicy;
  readonly #logger: FusionGatewayLogger;
  readonly #cost: FusionCostMeter;
  readonly #passthroughFor: (requested: string | undefined) => PassthroughModel | undefined;
  readonly #signalFor: (req: FrontdoorRequestValue) => AbortSignal | undefined;

  constructor(options: FusionVendorProxyOptions) {
    this.#defaultModel = options.defaultModel;
    this.#onRateLimit = options.onRateLimit;
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
    const costSessionId = req.sessionKey;
    // A passthrough request is its own tiny trace: one root span per proxy call.
    const span = startFusionSpan("gateway", "fusion.passthrough", undefined, {
      [ATTR.FUSION_DIALECT]: "native-passthrough",
      [ATTR.GEN_AI_REQUEST_MODEL]: target.routekitModelId,
      [ATTR.FUSION_MODEL_ID]: target.routekitModelId,
      [ATTR.FUSION_ROUTEKIT_MODEL_ID]: target.routekitModelId,
      [ATTR.FUSION_SESSION_ID]: req.sessionKey
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (req.modelCallId) headers["x-velum-model-call-id"] = req.modelCallId;
    const body = JSON.stringify({ ...chat, model: target.routekitModelId });
    const response = await fetch(joinPath(target.routekitUrl, "/v1/chat/completions"), {
      method: "POST",
      headers,
      body,
      ...(signal ? { signal } : {})
    });
    span.end({
      status: response.ok ? "succeeded" : "failed",
      attributes: { "http.response.status_code": response.status }
    });

    if (this.#onRateLimit === "passthrough") {
      await this.#cost.meterResponseClone(response, costSessionId, target.routekitModelId, span.carrier);
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
    await this.#cost.meterResponseClone(response, costSessionId, target.routekitModelId, span.carrier);
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
          `fusion: ${target.routekitModelId} failed (${failure.category}); not failing over to the ensemble.`
        );
        return { kind: "response", response: verbatim() };
      case "fail-error": {
        const message =
          `${target.routekitModelId} ${failure.category} (${failure.message}); ` +
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
          `fusion: ${target.routekitModelId} ${failure.category}; handing the turn off to the ensemble.`
        );
        return {
          kind: "failover",
          excludeModelIds: [target.routekitModelId],
          notice: failoverNotice(target.routekitModelId, failure)
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
    // Detect the first content/error signal incrementally: feed only each new
    // chunk to a single SseDecoder rather than re-scanning the whole accumulated
    // buffer per chunk (the old `firstSseSignal(buffered)` call was O(n^2)).
    const signalDecoder = new SseDecoder();
    let buffered = "";
    let signalKind: "content" | "error" | "none" = "none";
    let preFailure: ProxyFailure | undefined;
    let signalSeen = false;
    while (!signalSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = decoder.decode(value, { stream: true });
      buffered += chunk;
      for (const event of signalDecoder.feed(chunk)) {
        if (event.data.length === 0 || event.data === "[DONE]") continue;
        let object: Record<string, unknown> | undefined;
        try {
          const json = JSON.parse(event.data) as unknown;
          object = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : undefined;
        } catch {
          // Best-effort pre-stream signal detection: skip a non-JSON payload.
          object = undefined;
        }
        if (object === undefined) continue;
        const failure = sseObjectError(object);
        if (failure !== undefined) {
          signalKind = "error";
          preFailure = failure;
          signalSeen = true;
          break;
        }
        if (sseObjectHasContent(object)) {
          signalKind = "content";
          signalSeen = true;
          break;
        }
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
        model: target.routekitModelId,
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
              controller.enqueue(encoder.encode(noticeChunk(resumeNotice(target.routekitModelId, fusedModel))));
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
