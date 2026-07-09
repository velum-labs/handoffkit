/**
 * Chaos / lifecycle behavior through the full stack: hard panel timeouts,
 * straggler abandonment after a fast survivor, and caller cancellation. Each
 * test proves the gateway remains healthy afterwards — failures must be
 * bounded and isolated, never wedge the server or leak into the next turn.
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { judgeAnalysis, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

const MEMBERS = [
  { id: "fast", model: "chaos-fast", provider: "openai" },
  { id: "slow", model: "chaos-slow", provider: "openai" },
  { id: "judge", model: "chaos-judge", provider: "openai" }
] as const;

type ChatBody = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; type?: string };
};

async function withStack(
  options: Parameters<typeof startSimFusionStack>[0],
  body: (stack: SimFusionStack) => Promise<void>
): Promise<void> {
  const stack = await startSimFusionStack(options);
  try {
    await body(stack);
  } finally {
    await stack.close();
  }
}

async function queueHealthyTurn(stack: SimFusionStack, answer: string): Promise<void> {
  await stack.sim.queue("chaos-fast", ["fast candidate"]);
  await stack.sim.queue("chaos-slow", ["slow candidate"]);
  await stack.sim.queue("chaos-judge", [
    { reply: judgeAnalysis() },
    { reply: answer }
  ]);
}

test(
  "straggler grace aborts a slow sibling and fuses the fast survivor without waiting for it",
  { skip: SKIP },
  async () => {
    await withStack(
      {
        members: [...MEMBERS],
        judgeId: "judge",
        panelTimeoutMs: 5_000,
        stragglerGraceMs: 100
      },
      async (stack) => {
        await stack.sim.queue("chaos-fast", ["fast surviving candidate"]);
        await stack.sim.queue("chaos-slow", [
          { reply: "too late", delay_s: 3 }
        ]);
        await stack.sim.queue("chaos-judge", [
          { reply: judgeAnalysis() },
          { reply: "fused from the fast survivor" }
        ]);

        const started = performance.now();
        const response = await stack.door.chat({
          model: "fusion-panel",
          messages: [{ role: "user", content: "do not wait for the straggler" }]
        });
        const elapsedMs = performance.now() - started;
        assert.equal(response.status, 200, await stack.sim.describeJournal());
        const body = (await response.json()) as ChatBody;
        assert.match(body.choices?.[0]?.message?.content ?? "", /fast survivor/);
        assert.ok(
          elapsedMs < 1_500,
          `straggler grace must bound tail latency (elapsed ${elapsedMs.toFixed(0)}ms)`
        );
        assert.equal((await stack.sim.calls({ model: "chaos-judge" })).length, 2);
      }
    );
  }
);

test(
  "panel timeout fails a turn within its bound, never judges partial work, and gateway recovers",
  { skip: SKIP },
  async () => {
    await withStack(
      {
        members: [...MEMBERS],
        judgeId: "judge",
        panelTimeoutMs: 200,
        stragglerGraceMs: 0
      },
      async (stack) => {
        await stack.sim.queue("chaos-fast", [{ reply: "late fast", delay_s: 3 }]);
        await stack.sim.queue("chaos-slow", [{ reply: "late slow", delay_s: 3 }]);
        const started = performance.now();
        const failed = await stack.door.chat({
          model: "fusion-panel",
          messages: [{ role: "user", content: "this panel must time out" }]
        });
        const elapsedMs = performance.now() - started;
        assert.ok(failed.status >= 500, `expected panel failure, got ${failed.status}`);
        assert.ok(elapsedMs < 1_500, `panel timeout overran: ${elapsedMs.toFixed(0)}ms`);
        assert.equal(
          (await stack.sim.calls({ model: "chaos-judge" })).length,
          0,
          "timed-out candidate sets must never reach the judge"
        );

        // The failed turn is isolated. A subsequent healthy turn on the same
        // gateway must work normally.
        await stack.sim.reset();
        await queueHealthyTurn(stack, "healthy after the timeout");
        const recovered = await stack.door.chat({
          model: "fusion-panel",
          messages: [{ role: "user", content: "recover now" }]
        });
        assert.equal(recovered.status, 200);
        assert.match(
          ((await recovered.json()) as ChatBody).choices?.[0]?.message?.content ?? "",
          /healthy after the timeout/
        );
      }
    );
  }
);

test(
  "caller abort cancels the in-flight turn before judging and does not poison the next request",
  { skip: SKIP },
  async () => {
    await withStack(
      {
        members: [...MEMBERS],
        judgeId: "judge",
        panelTimeoutMs: 10_000
      },
      async (stack) => {
        await stack.sim.queue("chaos-fast", [{ reply: "late", delay_s: 1 }]);
        await stack.sim.queue("chaos-slow", [{ reply: "late", delay_s: 1 }]);
        const controller = new AbortController();
        const pending = fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "fusion-panel",
            messages: [{ role: "user", content: "cancel this request" }]
          }),
          signal: controller.signal
        });
        setTimeout(() => controller.abort(), 100);
        await assert.rejects(pending, /abort/i);
        // Wait past the provider delay, not just past the client abort: this
        // proves the abandoned turn never advances into judging later.
        await delay(1_300);
        assert.equal(
          (await stack.sim.calls({ model: "chaos-judge" })).length,
          0,
          "an abandoned client turn must not continue into paid judging"
        );

        await stack.sim.reset();
        await queueHealthyTurn(stack, "healthy after caller cancellation");
        const recovered = await stack.door.chat({
          model: "fusion-panel",
          messages: [{ role: "user", content: "new request" }]
        });
        assert.equal(recovered.status, 200);
        assert.match(
          ((await recovered.json()) as ChatBody).choices?.[0]?.message?.content ?? "",
          /healthy after caller cancellation/
        );
      }
    );
  }
);
