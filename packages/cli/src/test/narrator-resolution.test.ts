import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DOOR_PROFILES,
  callDoor,
  doorFrames,
  stackToolingSkip
} from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

test("FusionBackend narration survives the single RouteKit streaming gateway", {
  skip: SKIP
}, async () => {
  const stack = await startSimFusionStack({
    members: [
      { id: "member", model: "narration-member", provider: "openai" },
      { id: "judge", model: "narration-judge", provider: "openai" }
    ],
    judgeId: "judge"
  });
  try {
    await stack.scriptFusedTurn({
      candidates: {
        "narration-member": {
          reply: "candidate",
          reasoning: "PANEL_REASONING"
        }
      },
      answer: {
        reply: "NARRATION_FINAL",
        reasoning: "SYNTH_REASONING"
      }
    });
    const door = DOOR_PROFILES.find((entry) => entry.id === "openai-chat");
    assert.ok(door);
    const response = await callDoor(stack.gatewayUrl, door, {
      model: "fusion-panel",
      user: "narrate this turn",
      stream: true
    });
    assert.equal(response.status, 200, await stack.sim.describeJournal());
    const { frames } = await doorFrames(response);
    const text = door.streamTextOf(frames);
    assert.match(text, /NARRATION_FINAL/);
    assert.ok(
      frames.some((frame) => JSON.stringify(frame).includes("fusion")),
      "stream includes Fusion progress narration"
    );
  } finally {
    await stack.close();
  }
});
