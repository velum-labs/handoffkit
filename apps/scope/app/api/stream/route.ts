import { bus } from "@/lib/db";
import type { FusionTraceEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream of newly ingested trace events. Clients use this
 * to live-update the sessions list and an open session detail without polling.
 */
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const emitter = bus();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: FusionTraceEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const onEvent = (event: FusionTraceEvent): void => send(event);
      emitter.on("event", onEvent);

      controller.enqueue(encoder.encode(`: connected\n\n`));
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          closed = true;
        }
      }, 15_000);

      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        emitter.off("event", onEvent);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", close);
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}
