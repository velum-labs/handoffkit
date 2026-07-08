/**
 * Seed the running dev collector with demo sessions so the dashboard has
 * something to show: a succeeded fused turn, a failed one, a still-running
 * one, and a judge-selects-verbatim one (with cost entries throughout).
 *
 * Usage:
 *   pnpm seed                              # defaults to http://127.0.0.1:4317
 *   pnpm seed --url http://127.0.0.1:4317
 *
 * Every invocation uses fresh trace ids, so re-seeding adds new sessions
 * instead of corrupting earlier ones. Spans post to the OTLP traces path and
 * events to the logs path, exactly like real emitters.
 */
import { randomBytes } from "node:crypto";

import { syntheticSession, toOtlpExport, toOtlpLogsExport } from "../test/fixture";
import type { SyntheticSession } from "../test/fixture";
import type { IncomingEvent, IncomingSpan } from "../lib/types";

function freshTraceId(): string {
  return randomBytes(16).toString("hex");
}

function retime(session: SyntheticSession, endedAgoMs: number): SyntheticSession {
  const lastTs = Math.max(
    ...session.spans.map((span) => span.end_ms),
    ...session.events.map((event) => event.ts_ms)
  );
  const delta = Date.now() - endedAgoMs - lastTs;
  return {
    spans: session.spans.map(
      (span): IncomingSpan => ({ ...span, start_ms: span.start_ms + delta, end_ms: span.end_ms + delta })
    ),
    events: session.events.map((event): IncomingEvent => ({ ...event, ts_ms: event.ts_ms + delta }))
  };
}

function succeededSession(traceId: string): SyntheticSession {
  return retime(syntheticSession(traceId), 8 * 60_000);
}

/** A failed session: the opus candidate fails and the run reports failed. */
function failedSession(traceId: string): SyntheticSession {
  const session = syntheticSession(traceId);
  const spans = session.spans.map((span): IncomingSpan => {
    if (span.name === "fusion.candidate" && span.attributes["fusion.candidate.id"] === "cand_opus") {
      return {
        ...span,
        status: "error",
        attributes: {
          ...span.attributes,
          "fusion.status": "failed",
          "fusion.finish_reason": "error",
          "fusion.final_output_preview": "npm test: 1 failing — regression test asserts the old behavior"
        }
      };
    }
    if (span.name === "fusion.run") {
      return {
        ...span,
        status: "error",
        attributes: { ...span.attributes, "fusion.status": "failed" }
      };
    }
    return span;
  });
  return retime({ spans, events: session.events }, 25 * 60_000);
}

/**
 * A live session: everything up to (but excluding) the terminal spans,
 * ending seconds ago so the dashboard shows it as running.
 */
function runningSession(traceId: string): SyntheticSession {
  const terminal = new Set(["fusion.run", "fusion.judge", "fusion.fuse"]);
  const session = syntheticSession(traceId);
  return retime(
    { spans: session.spans.filter((span) => !terminal.has(span.name)), events: session.events },
    5_000
  );
}

/** A judge-selects-verbatim session (no synthesis event, select decision). */
function selectSession(traceId: string): SyntheticSession {
  const session = syntheticSession(traceId);
  const spans = session.spans.map((span): IncomingSpan => {
    if (span.name === "fusion.judge" || span.name === "fusion.fuse") {
      return {
        ...span,
        attributes: {
          ...span.attributes,
          "fusion.decision": "select_trajectory",
          "fusion.selected.trajectory_id": "cand_gpt",
          "fusion.rationale": "gpt's patch is verified verbatim; no synthesis needed.",
          "fusion.final_output": "Fixed add() to use left + right."
        }
      };
    }
    return span;
  });
  const events = session.events.filter((event) => event.name !== "fusion.judge.synthesis");
  return retime({ spans, events }, 55 * 60_000);
}

async function post(url: string, body: Record<string, unknown>): Promise<{ accepted?: number; error?: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as { accepted?: number; error?: string };
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${payload.error ?? ""}`.trim());
  }
  return payload;
}

async function ingest(url: string, session: SyntheticSession): Promise<void> {
  const traceId = session.spans[0].trace_id;
  const traces = await post(`${url}/api/ingest/v1/traces`, toOtlpExport(session.spans));
  const logs = await post(`${url}/api/ingest/v1/logs`, toOtlpLogsExport(session.events));
  console.log(`${traceId}: accepted ${traces.accepted ?? 0} spans + ${logs.accepted ?? 0} events`);
}

async function main(): Promise<void> {
  const urlFlag = process.argv.indexOf("--url");
  const url = urlFlag !== -1 ? process.argv[urlFlag + 1] : "http://127.0.0.1:4317";
  const sessions = [
    succeededSession(freshTraceId()),
    failedSession(freshTraceId()),
    runningSession(freshTraceId()),
    selectSession(freshTraceId())
  ];
  for (const session of sessions) await ingest(url, session);
  console.log(`seeded ${sessions.length} sessions into ${url}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
