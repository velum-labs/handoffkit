import { NextRequest, NextResponse } from "next/server";

import { DEMO_IP_LIMIT, DEMO_IP_WINDOW_MS, DEMO_PTY_START } from "@/lib/demo/constants";
import {
  DemoCapacityError,
  DemoTemplateMissingError,
  createDemoSession,
  isDemoConfigured,
  stopDemoSession
} from "@/lib/demo/session";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Best-effort per-IP limiter. In-memory state survives while the function
 * instance stays warm (Fluid compute); the sandbox concurrency cap is the
 * authoritative guard.
 */
const ipHits = new Map<string, number[]>();

function ipAllowed(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < DEMO_IP_WINDOW_MS);
  if (hits.length >= DEMO_IP_LIMIT) {
    ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return true;
}

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function POST(request: NextRequest) {
  // Dev/test escape hatch: point the terminal at a locally-running PTY server
  // that speaks the same protocol, bypassing Vercel Sandbox entirely.
  const localPty = process.env.DEMO_LOCAL_PTY_URL;
  if (localPty !== undefined) {
    return NextResponse.json({
      url: localPty,
      token: "local",
      sandboxName: "local",
      expiresAt: Date.now() + 10 * 60 * 1000,
      start: DEMO_PTY_START
    });
  }

  if (!isDemoConfigured()) {
    return NextResponse.json({ fallback: true, reason: "unconfigured" }, { status: 503 });
  }
  if (!ipAllowed(clientIp(request))) {
    return NextResponse.json({ busy: true, reason: "rate-limited" }, { status: 429 });
  }

  try {
    const session = await createDemoSession();
    return NextResponse.json({ ...session, start: DEMO_PTY_START });
  } catch (error) {
    if (error instanceof DemoCapacityError) {
      return NextResponse.json({ busy: true, reason: "capacity" }, { status: 423 });
    }
    if (error instanceof DemoTemplateMissingError) {
      console.error("[demo] template missing:", error.message);
      return NextResponse.json({ fallback: true, reason: "template-missing" }, { status: 503 });
    }
    console.error("[demo] session creation failed:", error);
    return NextResponse.json({ fallback: true, reason: "error" }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const sandboxName = new URL(request.url).searchParams.get("sandbox");
  if (sandboxName === null || sandboxName === "local") {
    return NextResponse.json({ ok: true });
  }
  try {
    await stopDemoSession(sandboxName);
  } catch {
    // Already stopped / expired — nothing to do.
  }
  return NextResponse.json({ ok: true });
}
