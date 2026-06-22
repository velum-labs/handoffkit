import { NextResponse } from "next/server";

import {
  onRoutingDecision,
  recentRoutingDecisions,
  tryPublishRoutingDecision
} from "@/lib/routing/decisions";
import type { RoutingDecisionEvent } from "@/lib/routing/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Server-Sent Events stream of live `RoutingDecision` events (`event: routing.decision`).
 * Replays the in-process ring buffer on connect, then tails new decisions.
 */
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (name: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEncode(name, data)));
        } catch {
          closed = true;
        }
      };

      for (const event of recentRoutingDecisions()) {
        send("routing.decision", event);
      }

      const unsubscribe = onRoutingDecision((event: RoutingDecisionEvent) => {
        send("routing.decision", event);
      });

      controller.enqueue(encoder.encode(": connected\n\n"));

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);

      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
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

/**
 * Publish a routing decision into the live stream (integration seam for the
 * Claude router process until trace events carry structured decisions).
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const decision = tryPublishRoutingDecision(body);
  if (decision === undefined) {
    return NextResponse.json({ error: "body must be a RoutingDecision" }, { status: 400 });
  }

  return NextResponse.json({ published: decision });
}
