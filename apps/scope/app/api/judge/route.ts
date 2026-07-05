import { NextResponse } from "next/server";

import { eventsByType } from "@/lib/db";
import { rollupJudge } from "@/lib/rollups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const events = eventsByType([
    "harness.candidate.started",
    "judge.synthesis",
    "judge.final"
  ]);
  return NextResponse.json({ judge: rollupJudge(events) });
}
