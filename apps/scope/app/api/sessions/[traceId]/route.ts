import { NextResponse } from "next/server";

import { getEvents, getSession } from "@/lib/db";
import { deriveSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ traceId: string }> }
): Promise<NextResponse> {
  const { traceId } = await context.params;
  const row = getSession(traceId);
  const events = getEvents(traceId);
  if (row === undefined && events.length === 0) {
    return NextResponse.json({ error: "session not found" }, { status: 404 });
  }
  const detail = deriveSession(traceId, events);
  // Prefer the persisted session row's final output (full) when present.
  if (row?.final_output) detail.finalOutput = row.final_output;
  if (row?.status) detail.status = row.status;
  return NextResponse.json({ session: detail });
}
