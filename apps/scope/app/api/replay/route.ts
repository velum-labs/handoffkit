import { NextResponse } from "next/server";

import { defaultTraceDir, replayFromDir } from "@/lib/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  let dir: string | undefined;
  try {
    const body = (await request.json()) as { dir?: string };
    dir = body.dir;
  } catch {
    dir = undefined;
  }
  const target = dir ?? defaultTraceDir();
  if (target === undefined) {
    return NextResponse.json(
      { error: "no trace dir: pass { dir } or set FUSION_TRACE_DIR" },
      { status: 400 }
    );
  }
  const result = replayFromDir(target);
  return NextResponse.json({ dir: target, ...result });
}
