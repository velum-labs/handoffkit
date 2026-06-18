import { NextResponse } from "next/server";

import { listSessions } from "@/lib/db";
import { rollupEnvironments } from "@/lib/rollups";
import type { RawEnvironment } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const rows = listSessions().map((session) => ({
    environment:
      session.environment !== null ? (JSON.parse(session.environment) as RawEnvironment) : null,
    lastTs: session.last_ts
  }));
  return NextResponse.json({ environments: rollupEnvironments(rows) });
}
