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
 * instead of corrupting earlier ones.
 */
import { randomBytes } from "node:crypto";

import { syntheticSession, toOtlpExport } from "../test/fixture";
import type { IncomingSpan } from "../lib/types";

function freshTraceId(): string {
  return randomBytes(16).toString("hex");
}

function retime(spans: IncomingSpan[], endedAgoMs: number): IncomingSpan[] {
  const lastTs = Math.max(...spans.map((span) => span.end_ms));
  const delta = Date.now() - endedAgoMs - lastTs;
  return spans.map((span) => ({ ...span, start_ms: span.start_ms + delta, end_ms: span.end_ms + delta }));
}

function succeededSession(traceId: string): IncomingSpan[] {
  return retime(syntheticSession(traceId), 8 * 60_000);
}

/** A failed session: the opus candidate fails and the run reports failed. */
function failedSession(traceId: string): IncomingSpan[] {
  const spans = syntheticSession(traceId).map((span): IncomingSpan => {
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
  return retime(spans, 25 * 60_000);
}

/**
 * A live session: everything up to (but excluding) the terminal spans,
 * ending seconds ago so the dashboard shows it as running.
 */
function runningSession(traceId: string): IncomingSpan[] {
  const terminal = new Set(["fusion.run", "fusion.judge", "fusion.fuse"]);
  const spans = syntheticSession(traceId).filter((span) => !terminal.has(span.name));
  return retime(spans, 5_000);
}

/** A judge-selects-verbatim session (no synthesis marker, select decision). */
function selectSession(traceId: string): IncomingSpan[] {
  const spans = syntheticSession(traceId)
    .filter((span) => span.name !== "fusion.judge.synthesis")
    .map((span): IncomingSpan => {
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
  return retime(spans, 55 * 60_000);
}

async function ingest(url: string, spans: IncomingSpan[]): Promise<void> {
  const traceId = spans[0].trace_id;
  const response = await fetch(`${url}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toOtlpExport(spans))
  });
  const body = (await response.json().catch(() => ({}))) as { accepted?: number; error?: string };
  if (!response.ok) {
    throw new Error(`${traceId}: HTTP ${response.status} ${body.error ?? ""}`.trim());
  }
  console.log(`${traceId}: accepted ${body.accepted ?? 0} spans`);
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
  for (const spans of sessions) await ingest(url, spans);
  console.log(`seeded ${sessions.length} sessions into ${url}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
