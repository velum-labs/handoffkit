import { NextResponse } from "next/server";

import { eventsByType } from "@/lib/db";
import { rollupModels } from "@/lib/rollups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const events = eventsByType(["model.call.started", "model.call.finished"]);
  return NextResponse.json({ models: rollupModels(events) });
}
