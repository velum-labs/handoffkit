import { NextResponse } from "next/server";

import { eventsByName, spansByName } from "@/lib/db";
import { rollupJudge } from "@/lib/rollups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const spans = spansByName(["fusion.candidate", "fusion.judge", "fusion.fuse"]);
  const events = eventsByName(["fusion.candidate.started", "fusion.judge.synthesis"]);
  return NextResponse.json({ judge: rollupJudge(spans, events) });
}
