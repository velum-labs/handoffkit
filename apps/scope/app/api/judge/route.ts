import { NextResponse } from "next/server";

import { spansByName } from "@/lib/db";
import { rollupJudge } from "@/lib/rollups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const spans = spansByName([
    "fusion.candidate.started",
    "fusion.candidate",
    "fusion.judge.synthesis",
    "fusion.judge",
    "fusion.fuse"
  ]);
  return NextResponse.json({ judge: rollupJudge(spans) });
}
