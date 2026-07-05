/**
 * Surface adapter: turn a runtime event stream into an OpenAI-style SSE
 * `Response`.
 *
 * The streaming front-door turn runs through `FusionRuntime.stream(...)`, whose
 * events this adapter serializes to the exact wire the harnesses expect: an
 * optional leading handoff notice (failover), `: keepalive` comments emitted on
 * an interval while the (slow) panel phase runs, the fuse step's SSE bytes piped
 * through verbatim as `sse.chunk` events, and a terminal error event (with
 * `finish_reason:"error"` + `[DONE]`) if the run fails.
 */

import type { RuntimeEvent } from "@fusionkit/kernel";

import { defaultFusionGatewayLogger } from "../logger.js";
import type { FusionGatewayLogger } from "../logger.js";
import { errorEvent, noticeChunk, reasoningChunk } from "../sse-wire.js";
import type { ReasoningDeltaEvent } from "./narration.js";

const KEEPALIVE_MS = 3000;

export type EventsToSseOptions = {
  /** A leading assistant content delta emitted before the panel phase (failover). */
  notice?: string;
  /** Called when the run fails, before the terminal error event is emitted. */
  onError?: (message: string) => void;
  /** Called after a clean completion (e.g. to record any post-stream state). */
  onComplete?: () => void;
  /** Logger for human-facing gateway diagnostics. */
  logger?: FusionGatewayLogger;
};

export function eventsToSseResponse(
  events: AsyncIterable<RuntimeEvent | ReasoningDeltaEvent>,
  options: EventsToSseOptions = {}
): Response {
  const logger = options.logger ?? defaultFusionGatewayLogger;
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      let alive = true;
      const keepalive = setInterval(() => {
        if (alive) {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            alive = false;
          }
        }
      }, KEEPALIVE_MS);
      if (options.notice !== undefined) {
        controller.enqueue(encoder.encode(noticeChunk(options.notice)));
      }
      try {
        for await (const event of events) {
          switch (event.type) {
            case "sse.chunk":
              controller.enqueue(encoder.encode(event.data));
              break;
            case "reasoning.delta":
              controller.enqueue(encoder.encode(reasoningChunk(event.text)));
              break;
            case "output.delta":
              controller.enqueue(encoder.encode(noticeChunk(event.content)));
              break;
            case "keepalive":
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              break;
            case "error": {
              const message = `fusion error: ${event.error.message}`;
              logger.error(`fusion: ${event.error.message}`);
              options.onError?.(event.error.message);
              controller.enqueue(encoder.encode(errorEvent(message)));
              break;
            }
            case "final":
              options.onComplete?.();
              break;
            default:
              // trace / tool_call.delta events are not part of the SSE wire.
              break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`fusion: ${message}`);
        options.onError?.(message);
        controller.enqueue(encoder.encode(errorEvent(`fusion error: ${message}`)));
      } finally {
        alive = false;
        clearInterval(keepalive);
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
