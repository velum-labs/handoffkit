import { NextResponse } from "next/server";

import { ingestSpan } from "@/lib/db";
import { parseOtlpExport } from "@/lib/otlp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The OTLP/HTTP traces receiver. Fusion components point their standard OTLP
 * exporters at the `/api/ingest` base (`OTEL_EXPORTER_OTLP_ENDPOINT`), whose
 * exporters append the spec path `/v1/traces`. Accepts
 * `ExportTraceServiceRequest` JSON (spec-conformant hex-id encoding or the
 * protobuf-JSON mapping) and replies with the standard export response shape.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const spans = parseOtlpExport(body);
  let accepted = 0;
  for (const span of spans) {
    if (ingestSpan(span) !== undefined) accepted += 1;
  }
  // Standard OTLP success response; `accepted` is a collector-local extra.
  return NextResponse.json({ partialSuccess: {}, accepted });
}
