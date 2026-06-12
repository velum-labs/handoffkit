import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agents, handoff, localFirst, targets } from "@warrant/handoff";
import { PlaneClient } from "@warrant/sdk";
import { makeRepo } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

export type SeedOptions = {
  planeUrl: string;
  adminToken: string;
  pool: string;
  /** Wait for seeded runs to be picked up by a runner. Default true. */
  waitForRunner?: boolean;
};

export type SeedResult = {
  runIds: string[];
};

async function waitTerminal(
  client: PlaneClient,
  runId: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await client.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(view.status)) return;
    if (Date.now() >= deadline) return;
    // TODO(hardcoded): poll 300ms
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * Seed a plane with a representative mix of runs so the control panel has
 * something real to show: a handoff continuation, a plain governed run, a
 * failing run, and a cancelled one. Requires a polling runner on the pool
 * (unless waitForRunner is false).
 */
export async function seedShowcase(options: SeedOptions): Promise<SeedResult> {
  const client = new PlaneClient(options.planeUrl, options.adminToken);
  const wait = options.waitForRunner ?? true;
  const repo = makeRepo({
    files: {
      "README.md": "# checkout-service\n",
      "src/cart.ts": "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n"
    }
  });
  const runIds: string[] = [];

  try {
    // 1. A continuation: local work handed off with a transcript.
    writeFileSync(
      join(repo, "src/cart.ts"),
      "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0); // WIP rounding\n"
    );
    const h = handoff({
      workspace: repo,
      plane: client,
      actor: { kind: "human", id: "dana@example.com" },
      agent: agents.mock(),
      policy: localFirst({ allowPools: [options.pool] })
    });
    const continuation = await h.continueIn(targets.pool(options.pool), {
      task: "finish the rounding fix in cart totals and run the tests",
      reason: "laptop going offline before the team demo",
      transcript: "user: totals drift by a cent\nagent: switching to integer cents, continuing remotely"
    });
    runIds.push(continuation.runId);

    // 2. A plain governed run.
    const captured = captureWorkspace(repo);
    await client.putBlob(captured.bundle);
    if (captured.dirtyDiff) await client.putBlob(captured.dirtyDiff);
    const base = {
      requestedBy: { kind: "human" as const, id: "sam@example.com" },
      agentKind: "mock",
      pool: options.pool,
      secretNames: [],
      workspace: captured.manifest,
      network: { defaultDeny: true, allowHosts: [] },
      budget: {},
      disclosure: "minimal-context" as const
    };
    const plain = await client.requestRun({
      ...base,
      prompt: "add input validation to the checkout endpoint"
    });
    runIds.push(plain.runId);

    // 3. A run that fails inside the session (the mock agent honors "fail").
    const failing = await client.requestRun({
      ...base,
      prompt: "this migration is expected to fail loudly"
    });
    runIds.push(failing.runId);

    // 4. A run cancelled before any runner claims it.
    const doomed = await client.requestRun({
      ...base,
      prompt: "experiment we changed our mind about"
    });
    try {
      await client.cancel(doomed.runId, { kind: "human", id: "sam@example.com" });
    } catch {
      // TODO(brittle): cancel race swallowed silently
      // A racing runner may have claimed it first; the run is then governed
      // to completion, which is also a fine thing to show.
    }
    runIds.push(doomed.runId);

    if (wait) {
      for (const runId of runIds) {
        // TODO(hardcoded): terminal wait 60s
        await waitTerminal(client, runId, 60_000);
      }
    }
    return { runIds };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
