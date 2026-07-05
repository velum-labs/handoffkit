/**
 * Seed a running scope collector with demo sessions, so the dashboard can be
 * developed and reviewed without a live FusionKit run:
 *
 *   pnpm dev          # in one shell (collector + UI)
 *   pnpm seed         # in another; then open the dashboard
 *
 * Posts four sessions derived from the shared test fixture — succeeded,
 * failed, still running, and one where the judge selects a candidate verbatim
 * — with recent timestamps so relative times read naturally. Each invocation
 * uses fresh trace ids, so re-seeding adds new sessions instead of corrupting
 * earlier ones.
 *
 * Usage: pnpm seed [--url http://127.0.0.1:4317]
 */

import { syntheticSession } from "../test/fixture";
import type { FusionTraceEvent } from "../lib/types";

const DEFAULT_URL = "http://127.0.0.1:4317";

function targetUrl(): string {
  const flagIndex = process.argv.indexOf("--url");
  if (flagIndex !== -1 && process.argv[flagIndex + 1] !== undefined) {
    return process.argv[flagIndex + 1].replace(/\/$/, "");
  }
  return (process.env.SCOPE_URL ?? DEFAULT_URL).replace(/\/$/, "");
}

/** Shift all timestamps so the session's last event lands `endedAgoMs` ago. */
function retime(events: FusionTraceEvent[], endedAgoMs: number): FusionTraceEvent[] {
  const lastTs = Math.max(...events.map((event) => event.ts));
  const delta = Date.now() - endedAgoMs - lastTs;
  return events.map((event) => ({ ...event, ts: event.ts + delta }));
}

function succeededSession(traceId: string): FusionTraceEvent[] {
  return retime(syntheticSession(traceId), 8 * 60_000);
}

/** The fixture with the opus candidate and the whole session marked failed. */
function failedSession(traceId: string): FusionTraceEvent[] {
  const events = syntheticSession(traceId).map((event): FusionTraceEvent => {
    if (event.event_type === "harness.candidate.finished" && event.candidate_id === "cand_opus") {
      return {
        ...event,
        payload: {
          ...event.payload,
          status: "failed",
          verification_status: "failed",
          error: "npm test: 1 failing — regression test asserts the old behavior"
        }
      };
    }
    if (event.event_type === "session.finished") {
      return {
        ...event,
        payload: {
          status: "failed",
          final_output_preview: "Fusion aborted: verification failed on the fused output."
        }
      };
    }
    return event;
  });
  return retime(events, 25 * 60_000);
}

/**
 * A still-running session: everything up to (excluding) the judge's terminal
 * events, ending seconds ago so the dashboard shows it as live.
 */
function runningSession(traceId: string): FusionTraceEvent[] {
  const terminal = new Set(["judge.synthesis", "judge.final", "session.finished"]);
  const events = syntheticSession(traceId).filter((event) => !terminal.has(event.event_type));
  return retime(events, 5_000);
}

/**
 * A session where the judge selects the opus candidate verbatim instead of
 * synthesizing: no judge.synthesis event, and judge.final carries the
 * select_trajectory decision (exercises the Judge page standings).
 */
function selectSession(traceId: string): FusionTraceEvent[] {
  const events = syntheticSession(traceId)
    .filter((event) => event.event_type !== "judge.synthesis")
    .map((event): FusionTraceEvent => {
      if (event.event_type !== "judge.final") return event;
      return {
        ...event,
        payload: {
          decision: "select_trajectory",
          selected_trajectory_id: "cand_opus",
          rationale:
            "The opus candidate already includes the regression test; use its answer verbatim.",
          final_output: "export const add = (left, right) => left + right; // + regression test",
          usage: { total_tokens: 480 }
        }
      };
    });
  return retime(events, 55 * 60_000);
}

async function ingest(url: string, events: FusionTraceEvent[]): Promise<void> {
  const traceId = events[0].trace_id;
  const response = await fetch(`${url}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events })
  });
  const body = (await response.json().catch(() => ({}))) as {
    accepted?: number;
    rejected?: number;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(`${traceId}: HTTP ${response.status} ${body.error ?? ""}`.trim());
  }
  console.log(`${traceId}: accepted ${body.accepted ?? 0}, rejected ${body.rejected ?? 0}`);
}

async function main(): Promise<void> {
  const url = targetUrl();
  const runId = Date.now().toString(36);
  const sessions = [
    succeededSession(`trace_demo_${runId}_ok`),
    failedSession(`trace_demo_${runId}_fail`),
    runningSession(`trace_demo_${runId}_live`),
    selectSession(`trace_demo_${runId}_select`)
  ];
  try {
    for (const events of sessions) await ingest(url, events);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Seeding failed against ${url}: ${message}`);
    console.error("Is the dashboard running? Start it with `pnpm dev` and retry.");
    process.exitCode = 1;
    return;
  }
  console.log(`Seeded ${sessions.length} demo sessions. Open ${url} to explore them.`);
}

void main();
