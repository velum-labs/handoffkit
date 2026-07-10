/**
 * Differential full-stack checks: equivalent requests expressed through
 * different transports must produce equivalent observable results.
 *
 * Unlike scripted outcome tests, these compare independent product paths
 * against one another. A translator, buffering, or streaming regression can
 * therefore fail without the test having to predict the model's answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOOR_PROFILES,
  callDoor,
  doorFrames,
  stackToolingSkip
} from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

let stack: SimFusionStack;

test.before(async () => {
  if (SKIP !== false) return;
  stack = await startSimFusionStack({
    members: [
      { id: "member", model: "differential-member", provider: "openai" },
      { id: "judge", model: "differential-judge", provider: "openai" }
    ],
    judgeId: "judge"
  });
});

test.after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

for (const door of DOOR_PROFILES) {
  test(
    `[differential:${door.id}] buffered JSON and SSE reassemble to the same answer`,
    { skip: SKIP },
    async () => {
      await stack.sim.reset();
      const marker = `differential-${door.id}-${Date.now()}`;
      const buffered = await callDoor(stack.gatewayUrl, door, {
        model: "member",
        user: marker
      });
      const bufferedRaw = await buffered.text();
      assert.equal(buffered.status, 200, bufferedRaw);
      const bufferedText = door.textOf(JSON.parse(bufferedRaw) as unknown);

      const streamed = await callDoor(stack.gatewayUrl, door, {
        model: "member",
        user: marker,
        stream: true
      });
      assert.equal(streamed.status, 200);
      const { frames, raw } = await doorFrames(streamed);
      assert.equal(door.streamClosed(frames), true, raw.slice(-500));
      const streamedText = door.streamTextOf(frames);

      assert.equal(streamedText, bufferedText);
      assert.match(streamedText, new RegExp(marker));
      assert.equal(
        (await stack.sim.calls({ model: "differential-member" })).length,
        2,
        await stack.sim.describeJournal()
      );
    }
  );
}

test("cross-door concurrent fused streams preserve request isolation", { skip: SKIP }, async () => {
  await stack.sim.reset();
  const turns = DOOR_PROFILES.flatMap((door) =>
    Array.from({ length: 4 }, (_, index) => ({
      door,
      marker: `cross-door-${door.id}-${index}-${Date.now()}`
    }))
  );

  const results = await Promise.all(
    turns.map(async ({ door, marker }) => {
      const response = await callDoor(stack.gatewayUrl, door, {
        model: "fusion-panel",
        user: marker,
        stream: true
      });
      const { frames, raw } = await doorFrames(response);
      return {
        status: response.status,
        content: door.streamTextOf(frames),
        closed: door.streamClosed(frames),
        raw
      };
    })
  );

  for (const [index, result] of results.entries()) {
    const own = turns[index];
    assert.ok(own !== undefined);
    assert.equal(result.status, 200, result.raw.slice(0, 500));
    assert.equal(result.closed, true, result.raw.slice(-500));
    assert.match(result.content, new RegExp(own.marker));
    for (const other of turns) {
      if (other === own) continue;
      assert.doesNotMatch(result.content, new RegExp(other.marker));
    }
  }
  assert.equal(
    (await stack.sim.calls({ model: "differential-member" })).length,
    turns.length
  );
  assert.equal(
    (await stack.sim.calls({ model: "differential-judge" })).length,
    turns.length * 2
  );
});
