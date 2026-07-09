import { NextResponse } from "next/server";

import { ingestEvent } from "@/lib/db";
import { parseOtlpLogsExport } from "@/lib/otlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The OTLP/HTTP logs receiver: fusion events arrive here as log records with
 * `eventName` plus trace/span correlation. Accepts `ExportLogsServiceRequest`
 * JSON (spec-conformant hex-id encoding or the protobuf-JSON mapping) and
 * replies with the standard export response shape.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const events = parseOtlpLogsExport(body);
  for (const event of events) ingestEvent(event);
  // Standard OTLP success response; `accepted` is a collector-local extra.
  return NextResponse.json({ partialSuccess: {}, accepted: events.length });
}
