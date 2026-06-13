import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { isTerminalStatus } from "@warrant/protocol";
import type { ReceiptBundle } from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";

import { makeRepo, mockRunRequest, startStack, uploadWorkspace } from "../index.js";
import type { Stack, StackOptions } from "../index.js";

/**
 * The execution window of one run, taken from boundary evidence: the
 * workspace materializes when the runner starts executing, and the final
 * command.executed event marks the session end. Receipt startedAt cannot
 * serve here — it is the first chain event (run.created), which predates
 * claiming for every queued run.
 */
function executionWindow(bundle: ReceiptBundle): { start: number; end: number } {
  let start: number | undefined;
  let end: number | undefined;
  for (const entry of bundle.events) {
    if (entry.event.type === "workspace.materialized") start = Date.parse(entry.ts);
    if (entry.event.type === "command.executed") end = Date.parse(entry.ts);
  }
  if (start === undefined || end === undefined) {
    throw new Error("run bundle is missing execution boundary events");
  }
  return { start, end };
}

async function waitForTerminal(
  client: PlaneClient,
  runIds: string[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const views = await Promise.all(runIds.map((id) => client.getRun(id)));
    if (views.every((view) => isTerminalStatus(view.status))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `runs did not reach a terminal status: ${views
          .map((view) => `${view.runId}=${view.status}`)
          .join(", ")}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Submit `count` governed sleep commands and return each run's execution
 * window once all runs are terminal.
 */
async function runSleeps(
  options: StackOptions,
  count: number
): Promise<{ windows: { start: number; end: number }[] }> {
  const stack: Stack = await startStack({ ...options, startRunner: true });
  const repo = makeRepo();
  try {
    const captured = await uploadWorkspace(stack.client, repo);
    const runIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const created = await stack.client.requestRun(
        mockRunRequest({
          prompt: "sleep 0.5",
          pool: stack.pool,
          workspace: captured.manifest,
          agentKind: "command"
        })
      );
      runIds.push(created.runId);
    }
    await waitForTerminal(stack.client, runIds, 30_000);
    const bundles = await Promise.all(
      runIds.map((id) => stack.client.getBundle(id))
    );
    for (const bundle of bundles) {
      assert.equal(bundle.receipt.status, "completed");
    }
    return { windows: bundles.map(executionWindow) };
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

test("a concurrent runner executes claimed runs simultaneously", async () => {
  const { windows } = await runSleeps({ concurrency: 3 }, 3);
  // All three 500ms sessions must be in flight at once: the latest start
  // strictly precedes the earliest end.
  const latestStart = Math.max(...windows.map((w) => w.start));
  const earliestEnd = Math.min(...windows.map((w) => w.end));
  assert.ok(
    latestStart < earliestEnd,
    `expected overlapping execution windows, got ${JSON.stringify(windows)}`
  );
});

test("the default runner stays strictly sequential", async () => {
  const { windows } = await runSleeps({}, 2);
  // Sort by start; with concurrency 1 the second session cannot
  // materialize its workspace before the first session's command ends.
  windows.sort((a, b) => a.start - b.start);
  const [first, second] = windows;
  assert.ok(first && second);
  assert.ok(
    second.start >= first.end,
    `expected sequential execution windows, got ${JSON.stringify(windows)}`
  );
});
