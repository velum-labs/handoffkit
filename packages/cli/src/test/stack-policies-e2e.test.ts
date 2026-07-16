/**
 * Gateway policy suite through the whole real stack: WS5 rate-limit /
 * failover policies, WS7 budget caps, and WS4 session turn-caching — each on
 * its own configured stack (Node RouteKit/Fusion gateways -> Python sidecar -> scripted
 * provider), asserted through responses, the wire journal, and the durable
 * session store.
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { InMemorySessionStore } from "@fusionkit/gateway";
import { judgeAnalysis, simErrors, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

const MEMBERS = [
  { id: "alpha", model: "gpt-panel-a", provider: "openai" },
  { id: "beta", model: "claude-panel-b", provider: "anthropic" },
  { id: "judge", model: "gpt-judge", provider: "openai" }
] as const;

type ChatBody = { choices: Array<{ message: { content: string } }> };

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

/** Queue enough 429s to cover every configured RouteKit endpoint attempt. */
async function queueRateLimitStorm(stack: SimFusionStack, model: string): Promise<void> {
  await stack.sim.queue(
    model,
    Array.from({ length: 12 }, () => ({ error: simErrors.rateLimited(0) }))
  );
}

// --- WS5: rate-limit failover policies ------------------------------------------------

test("onRateLimit=fusion: a throttled vendor passthrough fails over to the fused panel", { skip: SKIP }, async () => {
  await withStack({ members: [...MEMBERS], judgeId: "judge", onRateLimit: "fusion" }, async (stack) => {
    // The vendor (alpha's provider model) is persistently rate-limited; the
    // surviving members + judge serve the failover fusion.
    await queueRateLimitStorm(stack, "gpt-panel-a");
    await stack.sim.queue("claude-panel-b", ["the healthy candidate"]);
    await stack.sim.queue("gpt-judge", [
      { reply: judgeAnalysis() },
      { reply: "FUSION_FAILOVER: fused answer instead of a vendor 429" }
    ]);

    const response = await stack.door.chat({
      model: "alpha",
      messages: [{ role: "user", content: "vendor turn that gets throttled" }]
    });
    assert.equal(response.status, 200, await stack.sim.describeJournal());
    const body = (await response.json()) as ChatBody;
    assert.match(body.choices[0]?.message.content ?? "", /FUSION_FAILOVER/);

    // The wire shows the storm on the throttled vendor, and the failover
    // panel excluded it (WS5): only the healthy member fanned out.
    const throttled = await stack.sim.calls({ model: "gpt-panel-a", status: 429 });
    assert.ok(throttled.length >= 1, "RouteKit reached the throttled endpoint before failover");
    assert.equal((await stack.sim.calls({ model: "gpt-panel-a", status: 200 })).length, 0);
    assert.equal((await stack.sim.calls({ model: "claude-panel-b" })).length, 1);
    assert.equal((await stack.sim.calls({ model: "gpt-judge" })).length, 2);
  });
});

test("onRateLimit=passthrough: RouteKit's native endpoint failure surfaces verbatim", { skip: SKIP }, async () => {
  await withStack({ members: [...MEMBERS], judgeId: "judge", onRateLimit: "passthrough" }, async (stack) => {
    await queueRateLimitStorm(stack, "gpt-panel-a");
    const response = await stack.door.chat({
      model: "alpha",
      messages: [{ role: "user", content: "vendor turn that gets throttled" }]
    });
    assert.equal(response.status, 429, await stack.sim.describeJournal());
    const body = (await response.json()) as {
      error?: { code?: string; type?: string };
    };
    assert.equal(body.error?.code, "rate_limit_exceeded");
    assert.equal(body.error?.type, "rate_limit_error");
    assert.equal(
      (await stack.sim.calls({ model: "gpt-panel-a", status: 429 })).length,
      1,
      "the single RouteKit endpoint instance is attempted once"
    );
    assert.equal((await stack.sim.calls({ model: "gpt-judge" })).length, 0);
  });
});

test(
  "onRateLimit=fail: a throttled vendor fails explicitly and never invokes fusion",
  { skip: SKIP },
  async () => {
    await withStack(
      { members: [...MEMBERS], judgeId: "judge", onRateLimit: "fail" },
      async (stack) => {
        await queueRateLimitStorm(stack, "gpt-panel-a");
        const response = await stack.door.chat({
          model: "alpha",
          messages: [{ role: "user", content: "fail instead of failing over" }]
        });
        assert.equal(response.status, 429, await stack.sim.describeJournal());
        const body = (await response.json()) as { error?: { message?: string } };
        assert.match(body.error?.message ?? "", /failover disabled/i);
        assert.equal(
          (await stack.sim.calls({ model: "gpt-judge" })).length,
          0,
          "fail policy must never invoke the ensemble"
        );
      }
    );
  }
);

test("fused-turn member throttling degrades to the surviving members (no failover needed)", { skip: SKIP }, async () => {
  await withStack({ members: [...MEMBERS], judgeId: "judge", onRateLimit: "fusion" }, async (stack) => {
    await queueRateLimitStorm(stack, "gpt-panel-a");
    await stack.sim.queue("claude-panel-b", ["the survivor's candidate"]);
    await stack.sim.queue("gpt-judge", [
      { reply: judgeAnalysis() },
      { reply: "fused from the survivor under throttling" }
    ]);
    const response = await stack.door.chat({
      model: "fusion-panel",
      messages: [{ role: "user", content: "fuse under member throttling" }]
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as ChatBody;
    assert.match(body.choices[0]?.message.content ?? "", /fused from the survivor/);
  });
});

// --- WS7: budget caps ---------------------------------------------------------------

test("budgetUsd: an exhausted budget is refused before any RouteKit endpoint call", { skip: SKIP }, async () => {
  await withStack(
    {
      members: [...MEMBERS],
      judgeId: "judge",
      budgetUsd: 0
    },
    async (stack) => {
      const response = await stack.door.chat({
        model: "fusion-panel",
        messages: [{ role: "user", content: "must be refused" }]
      });
      assert.equal(response.status, 402);
      const refusal = (await response.json()) as {
        error?: { message?: string; type?: string };
      };
      assert.match(refusal.error?.message ?? "", /budget cap reached/i);
      assert.equal(refusal.error?.type, "fusion_error");
      assert.equal((await stack.sim.journal()).length, 0, await stack.sim.describeJournal());
    }
  );
});

// --- WS4: session semantics for finite-k rounds -----------------------------------------

test("finite-k rounds are memoryless: a replayed turn re-runs the panel (documented contract)", { skip: SKIP }, async () => {
  // The per-user-turn candidate cache applies to unbounded rollouts only
  // (members already rolled out to completion); k=1 proposal rounds are
  // receding-horizon and MUST re-fan out on every request — including
  // tool-result continuations — over the updated messages.
  const store = new InMemorySessionStore();
  await withStack(
    { members: [...MEMBERS], judgeId: "judge", sessionStore: store },
    async (stack) => {
      const turn = {
        model: "fusion-panel",
        messages: [{ role: "user", content: "the exact same turn" }]
      };
      await stack.scriptFusedTurn({
        candidates: { "gpt-panel-a": "candidate one", "claude-panel-b": "candidate two" },
        answer: "first fused answer"
      });
      const first = await stack.door.chat(turn);
      assert.equal(first.status, 200);
      assert.equal((await stack.sim.calls({ model: "gpt-panel-a" })).length, 1);

      await stack.sim.queue("gpt-panel-a", ["candidate one again"]);
      await stack.sim.queue("claude-panel-b", ["candidate two again"]);
      await stack.sim.queue("gpt-judge", [
        { reply: judgeAnalysis() },
        { reply: "second fused answer from a fresh round" }
      ]);
      const second = await stack.door.chat(turn);
      assert.equal(second.status, 200);
      const body = (await second.json()) as ChatBody;
      assert.match(body.choices[0]?.message.content ?? "", /second fused answer/);
      assert.equal(
        (await stack.sim.calls({ model: "gpt-panel-a" })).length,
        2,
        `finite-k rounds must re-fan out: ${await stack.sim.describeJournal()}`
      );

      await delay(300);
      const sessions = store.list();
      assert.ok(sessions.length >= 1, "the conversation must persist as one session");
      const detail = store.load(sessions[0]?.id ?? "");
      assert.ok((detail?.turns.length ?? 0) >= 1, "panel candidates must be persisted per turn");
    }
  );
});
