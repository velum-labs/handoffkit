import { NextResponse } from "next/server";

import { ingestEvent } from "@/lib/db";
import { isFusionTraceEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IngestBody = { events?: unknown } | unknown[] | unknown;

/** Accept a single event, an array of events, or { events: [...] }. */
function extractEvents(body: IngestBody): unknown[] {
  if (Array.isArray(body)) return body;
  if (typeof body === "object" && body !== null && Array.isArray((body as { events?: unknown }).events)) {
    return (body as { events: unknown[] }).events;
  }
  if (typeof body === "object" && body !== null) return [body];
  return [];
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: IngestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  let accepted = 0;
  let rejected = 0;
  for (const candidate of extractEvents(body)) {
    if (isFusionTraceEvent(candidate)) {
      ingestEvent(candidate);
      accepted += 1;
    } else {
      rejected += 1;
    }
  }
  return NextResponse.json({ accepted, rejected });
}
