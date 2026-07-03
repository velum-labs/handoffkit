import assert from "node:assert/strict";
import { test } from "node:test";

import { FusionBackend } from "../fusion-backend.js";

const UNREACHABLE_STEP = "http://127.0.0.1:1/v1/fusion/trajectory:step";
const userTurn = { messages: [{ role: "user", content: "do the task" }] };

test("panel timeout aborts the in-flight panel run instead of detaching it", async () => {
  let panelSignal: AbortSignal | undefined;
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    panelTimeoutMs: 100,
    runPanels: async ({ signal }) => {
      panelSignal = signal;
      // Model a stuck panel: only settles when the caller cancels it.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw signal?.reason ?? new Error("aborted");
    }
  });
  const res = await backend.chat({ ...userTurn, stream: false });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error?: { message?: string } };
  assert.match(
    body.error?.message ?? "",
    /fusion panel timed out after 100ms/,
    "the timeout error carries a human-readable duration"
  );
  assert.equal(panelSignal?.aborted, true, "the panel's abort signal fired on timeout");
});

test("a completed panel never sees its abort signal fire", async () => {
  let panelSignal: AbortSignal | undefined;
  const backend = new FusionBackend({
    stepUrl: UNREACHABLE_STEP,
    panelTimeoutMs: 5_000,
    runPanels: async ({ signal }) => {
      panelSignal = signal;
      return [{ trajectory_id: "t_a", model_id: "a", status: "succeeded", final_output: "ok" }];
    }
  });
  // The step URL is unreachable, so the turn fails downstream of the panel —
  // the panel itself completed and must not be aborted.
  await backend.chat({ ...userTurn, stream: false }).catch(() => undefined);
  assert.equal(panelSignal?.aborted, false);
});
