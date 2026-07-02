import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    identity: process.env.SCOPEKIT_DASHBOARD_ID ?? "scope-dashboard:dev",
    mode: process.env.NODE_ENV ?? "unknown"
  });
}
