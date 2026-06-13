import type { ReceiptBundle } from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";

import { HandoffRun } from "./run.js";

/**
 * Typed review strategies for choosing among fan-out attempts.
 * Deterministic and explainable, like the planner.
 */
export type ReviewStrategy = {
  kind: "review-strategy";
  id: "smallest-diff" | "first-completed" | "tests-pass-smallest-diff";
};

export const reviewStrategies = {
  /** Prefer the completed attempt with the smallest output diff. */
  smallestDiff(): ReviewStrategy {
    return { kind: "review-strategy", id: "smallest-diff" };
  },
  /** Prefer the completed attempt that finished first. */
  firstCompleted(): ReviewStrategy {
    return { kind: "review-strategy", id: "first-completed" };
  },
  /**
   * The spec's flagship strategy: among attempts whose harness exited
   * cleanly (the "tests pass" signal at the session boundary), prefer the
   * smallest output diff.
   */
  testsPassSmallestDiff(): ReviewStrategy {
    return { kind: "review-strategy", id: "tests-pass-smallest-diff" };
  }
};

/** Deterministic, evidence-derived comparison data for one attempt. */
export type Scorecard = {
  status: ReceiptBundle["receipt"]["status"];
  exitCode?: number;
  diffBytes: number;
  filesChanged: number;
  durationMs: number;
  eventCount: number;
  blockedEgressAttempts: number;
  secretsReleased: number;
};

export type ReviewedRun = {
  run: HandoffRun;
  bundle: ReceiptBundle;
  scorecard: Scorecard;
  /** Kept for convenience; equals scorecard.diffBytes. */
  diffBytes: number;
  endedAt: string;
};

export type ReviewResult = {
  chosen: ReviewedRun;
  candidates: ReviewedRun[];
  strategy: ReviewStrategy;
  reason: string;
};

/**
 * Build the deterministic, evidence-derived scorecard for one run from its
 * receipt bundle and output diff size. Exposed so adapters that judge runs
 * outside the fan-out review path (e.g. the swarm tools, where a cloud model
 * judges each worker) consume the exact same deterministic evidence the
 * review strategies do, rather than reconstructing it.
 */
export function scorecardFor(bundle: ReceiptBundle, diffBytes: number): Scorecard {
  const { receipt, events } = bundle;
  // Distinct files, not raw event count: a file touched repeatedly during a
  // session still counts once. exitCode is the session's final command —
  // the run's overall outcome by harness convention; per-command results
  // remain available in the event chain.
  const changedPaths = new Set<string>();
  let exitCode: number | undefined;
  for (const entry of events) {
    if (entry.event.type === "file.changed") changedPaths.add(entry.event.path);
    if (entry.event.type === "command.executed") exitCode = entry.event.exitCode;
  }
  const filesChanged = changedPaths.size;
  return {
    status: receipt.status,
    ...(exitCode !== undefined ? { exitCode } : {}),
    diffBytes,
    filesChanged,
    durationMs:
      new Date(receipt.endedAt).getTime() - new Date(receipt.startedAt).getTime(),
    eventCount: receipt.eventCount,
    blockedEgressAttempts: receipt.networkAccessed.filter(
      (record) => record.decision === "blocked"
    ).length,
    secretsReleased: receipt.secretsReleased.length
  };
}

export async function reviewRuns(
  client: PlaneClient,
  runs: HandoffRun[],
  strategy: ReviewStrategy
): Promise<ReviewResult> {
  const candidates: ReviewedRun[] = [];
  const skipped: { runId: string; status: string }[] = [];
  for (const run of runs) {
    const status = await run.status();
    if (status !== "completed") {
      skipped.push({ runId: run.runId, status });
      continue;
    }
    const bundle = await run.receipt();
    const diffHash = bundle.receipt.workspaceOut.diffHash;
    const diffBytes = diffHash ? (await client.getBlob(diffHash)).length : 0;
    candidates.push({
      run,
      bundle,
      scorecard: scorecardFor(bundle, diffBytes),
      diffBytes,
      endedAt: bundle.receipt.endedAt
    });
  }
  if (candidates.length === 0) {
    const detail = skipped
      .map((entry) => `${entry.runId}: ${entry.status}`)
      .join(", ");
    throw new Error(
      `no completed runs to review${detail ? ` (${detail})` : ""}`
    );
  }

  let chosen: ReviewedRun;
  let reason: string;
  switch (strategy.id) {
    case "smallest-diff": {
      chosen = candidates.reduce((a, b) => (b.diffBytes < a.diffBytes ? b : a));
      reason = `smallest output diff (${chosen.diffBytes} bytes) among ${candidates.length} completed attempt(s)`;
      break;
    }
    case "first-completed": {
      chosen = candidates.reduce((a, b) =>
        new Date(b.endedAt).getTime() < new Date(a.endedAt).getTime() ? b : a
      );
      reason = `first attempt to complete (${chosen.endedAt}) among ${candidates.length} completed attempt(s)`;
      break;
    }
    case "tests-pass-smallest-diff": {
      // This strategy's definition of "tests pass" IS harness exit 0 — that
      // is the session-boundary signal the spec names. Agents with custom
      // success semantics (multiple commands, non-zero success codes) pick
      // their winner directly from candidates' scorecards/events instead.
      const passing = candidates.filter(
        (candidate) => candidate.scorecard.exitCode === 0
      );
      if (passing.length === 0) {
        throw new Error("no attempt passed (harness exit 0) to review");
      }
      chosen = passing.reduce((a, b) => (b.diffBytes < a.diffBytes ? b : a));
      reason = `harness exited 0 and smallest output diff (${chosen.diffBytes} bytes) among ${passing.length} passing attempt(s)`;
      break;
    }
    default: {
      const exhausted: never = strategy.id;
      throw new Error(`unknown review strategy: ${String(exhausted)}`);
    }
  }
  return { chosen, candidates, strategy, reason };
}
