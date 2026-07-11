import { NextResponse } from "next/server";

import { eventsByName, spansByName } from "@/lib/db";
import { rollupCost, rollupModels } from "@/lib/rollups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const chatSpans = spansByName(["chat"]);
  const startEvents = eventsByName(["fusion.model_call.started"]);
  const costEvents = eventsByName(["fusion.cost"]);
  return NextResponse.json({
    models: rollupModels(chatSpans, startEvents),
    costs: rollupCost(costEvents)
  });
}
