/**
 * Concurrency behavior through the full stack: many parallel streaming turns
 * must not cross-talk (each response carries exactly its own request's
 * content), fused turns must all complete under contention, and a client
 * abort mid-stream must not disturb sibling streams or the gateway.
 *
 * Cross-talk detection leans on the simulator's deterministic echo default:
 * an unscripted provider call replies with the request's own user text, so a
 * response containing another request's marker is a routing/plumbing bug.
 */

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

const MEMBERS = [
  { id: "member", model: "conc-member", provider: "openai" },
  { id: "judge", model: "conc-judge", provider: "openai" }
] as const;

let stack: SimFusionStack;

test.before(async () => {
  if (SKIP !== false) return;
  stack = await startSimFusionStack({ members: [...MEMBERS], judgeId: "judge" });
});

test.after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

type StreamedTurn = { status: number; content: string };

async function streamedChat(model: string, marker: string): Promise<StreamedTurn> {
  const response = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: marker }], stream: true })
  });
  const text = await response.text();
  const content = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => {
      try {
        return JSON.parse(line.slice("data: ".length)) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
      } catch {
        return {};
      }
    })
    .map((chunk) => chunk.choices?.[0]?.delta?.content ?? "")
    .join("");
  return { status: response.status, content };
}

test("24 concurrent passthrough streams answer without cross-talk", { skip: SKIP }, async () => {
  await stack.sim.reset();
  const count = 24;
  const markers = Array.from({ length: count }, (_, index) => `xtalk-marker-${index}-${Date.now()}`);
  // Use the exact public passthrough id. The test previously sent the unknown
  // alias `member`, which Fusion correctly folded into the default ensemble;
  // under suite-wide contention it was stress-testing 24 panel+judge pipelines,
  // not 24 passthrough streams.
  const turns = await Promise.all(
    markers.map((marker) => streamedChat("openai/conc-member", marker))
  );
  for (const [index, turn] of turns.entries()) {
    assert.equal(turn.status, 200, `request ${index}`);
    assert.ok(
      turn.content.includes(markers[index] ?? ""),
      `request ${index} lost its own content: ${turn.content.slice(0, 120)}`
    );
    for (const [other, marker] of markers.entries()) {
      if (other === index) continue;
      assert.ok(
        !turn.content.includes(marker),
        `request ${index} leaked content from request ${other}: ${turn.content.slice(0, 120)}`
      );
    }
  }
  // Accounting: exactly one provider call per passthrough request, none lost.
  const memberCalls = await stack.sim.calls({ model: "conc-member" });
  assert.equal(memberCalls.length, count, await stack.sim.describeJournal());
  assert.equal(
    (await stack.sim.calls({ model: "conc-judge" })).length,
    0,
    "passthrough concurrency must not invoke the fusion judge"
  );
});

test("8 concurrent fused streaming turns all complete with their own answers", { skip: SKIP }, async () => {
  await stack.sim.reset();
  const count = 8;
  const markers = Array.from({ length: count }, (_, index) => `fused-marker-${index}-${Date.now()}`);
  const turns = await Promise.all(markers.map((marker) => streamedChat("fusion-panel", marker)));
  for (const [index, turn] of turns.entries()) {
    assert.equal(turn.status, 200, `fused request ${index}`);
    assert.ok(
      turn.content.includes(markers[index] ?? ""),
      `fused request ${index} lost its marker: ${turn.content.slice(0, 160)}`
    );
  }
  // Every fused turn fans out to the member and judges twice (analysis + synthesis).
  assert.equal((await stack.sim.calls({ model: "conc-member" })).length, count);
  assert.equal((await stack.sim.calls({ model: "conc-judge" })).length, count * 2);
});

test("a client abort mid-stream leaves concurrent siblings and the gateway intact", { skip: SKIP }, async () => {
  await stack.sim.reset();
  // The doomed stream paces its frames so the abort lands mid-body.
  await stack.sim.queue("conc-member", [
    { reply: "one two three four five six seven eight nine ten", chunk_delay_s: 0.15 }
  ]);
  const controller = new AbortController();
  let firstFrame!: () => void;
  const firstFrameSeen = new Promise<void>((resolve) => { firstFrame = resolve; });
  let releaseAbort!: () => void;
  const abortNow = new Promise<void>((resolve) => { releaseAbort = resolve; });
  const doomed = (async () => {
    const response = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/conc-member",
        messages: [{ role: "user", content: "abort-victim" }],
        stream: true
      }),
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    await reader?.read();
    firstFrame();
    await abortNow;
    controller.abort();
    await reader?.read();
  })();
  // The simulator's queued response is model-global. Establish that the doomed
  // request consumed its first frame before launching the unscripted survivor;
  // otherwise suite contention can swap which request receives the slow script.
  await firstFrameSeen;
  const survivorMarker = `survivor-${Date.now()}`;
  const survivorPromise = streamedChat("openai/conc-member", survivorMarker);
  releaseAbort();
  const [doomedOutcome, survivor] = await Promise.allSettled([
    doomed,
    survivorPromise
  ]);
  assert.equal(doomedOutcome.status, "rejected", "the aborted stream must reject at the client");
  assert.equal(survivor.status, "fulfilled");
  if (survivor.status === "fulfilled") {
    assert.equal(survivor.value.status, 200);
    assert.ok(survivor.value.content.includes(survivorMarker), survivor.value.content.slice(0, 120));
  }
  await delay(300);
  assert.equal((await stack.sim.calls({ model: "conc-member" })).length, 2);
  assert.equal(
    (await stack.sim.calls({ model: "conc-judge" })).length,
    0,
    "passthrough abort isolation must not invoke the fusion judge"
  );
  const health = await fetch(`${stack.gatewayUrl}/v1/models`);
  assert.equal(health.status, 200, "gateway must survive a mid-stream client abort");
});
