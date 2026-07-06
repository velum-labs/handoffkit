import { NextResponse } from "next/server";

import { spansByName } from "@/lib/db";
import { rollupCost, rollupModels } from "@/lib/rollups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const spans = spansByName(["fusion.model_call.started", "chat"]);
  const costSpans = spansByName(["fusion.cost"]);
  return NextResponse.json({ models: rollupModels(spans), costs: rollupCost(costSpans) });
}
