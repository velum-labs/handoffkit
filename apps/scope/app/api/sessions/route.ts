import { NextResponse } from "next/server";

import { listSessions } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const sessions = listSessions().map((session) => ({
    traceId: session.trace_id,
    startedAt: session.started_at,
    lastTs: session.last_ts,
    status: session.status,
    dialect: session.dialect,
    repo: session.repo,
    environment: session.environment !== null ? JSON.parse(session.environment) : null,
    finalOutput: session.final_output,
    eventCount: session.event_count,
    durationMs: Math.max(0, session.last_ts - session.started_at)
  }));
  return NextResponse.json({ sessions });
}
