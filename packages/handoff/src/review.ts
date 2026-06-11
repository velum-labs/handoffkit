import type { ReceiptBundle } from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";

import { HandoffRun } from "./run.js";

/**
 * Typed review strategies for choosing among fan-out attempts.
 * Deterministic and explainable, like the planner.
 */
export type ReviewStrategy = {
  kind: "review-strategy";
  id: "smallest-diff" | "first-completed";
};

export const reviewStrategies = {
  /** Prefer the completed attempt with the smallest output diff. */
  smallestDiff(): ReviewStrategy {
    return { kind: "review-strategy", id: "smallest-diff" };
  },
  /** Prefer the completed attempt that finished first. */
  firstCompleted(): ReviewStrategy {
    return { kind: "review-strategy", id: "first-completed" };
  }
};

export type ReviewedRun = {
  run: HandoffRun;
  bundle: ReceiptBundle;
  diffBytes: number;
  endedAt: string;
};

export type ReviewResult = {
  chosen: ReviewedRun;
  candidates: ReviewedRun[];
  strategy: ReviewStrategy;
  reason: string;
};

export async function reviewRuns(
  client: PlaneClient,
  runs: HandoffRun[],
  strategy: ReviewStrategy
): Promise<ReviewResult> {
  const candidates: ReviewedRun[] = [];
  for (const run of runs) {
    const status = await run.status();
    if (status !== "completed") continue;
    const bundle = await run.receipt();
    const diffHash = bundle.receipt.workspaceOut.diffHash;
    const diffBytes = diffHash ? (await client.getBlob(diffHash)).length : 0;
    candidates.push({
      run,
      bundle,
      diffBytes,
      endedAt: bundle.receipt.endedAt
    });
  }
  if (candidates.length === 0) {
    throw new Error("no completed runs to review");
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
      chosen = candidates.reduce((a, b) => (b.endedAt < a.endedAt ? b : a));
      reason = `first attempt to complete (${chosen.endedAt}) among ${candidates.length} completed attempt(s)`;
      break;
    }
    default: {
      const exhausted: never = strategy.id;
      throw new Error(`unknown review strategy: ${String(exhausted)}`);
    }
  }
  return { chosen, candidates, strategy, reason };
}
