/**
 * Dialect acceptance for the only production public server:
 * RouteKit `startGateway` with FusionBackend, reached through the v4 stack.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  DOOR_PROFILES,
  callDoor,
  stackToolingSkip
} from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";
import type { SimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();
let stack: SimFusionStack;

before(async () => {
  if (SKIP !== false) return;
  stack = await startSimFusionStack({
    members: [
      { id: "member-a", model: "dialect-a", provider: "openai" },
      { id: "member-b", model: "dialect-b", provider: "anthropic" },
      { id: "judge", model: "dialect-judge", provider: "openai" }
    ],
    judgeId: "judge"
  });
});

after(async () => {
  if (SKIP !== false) return;
  await stack.close();
});

for (const door of DOOR_PROFILES) {
  test(
    `[FusionBackend/${door.id}] native dialect reaches one fused turn`,
    { skip: SKIP },
    async () => {
      await stack.scriptFusedTurn({
        candidates: {
          "dialect-a": "candidate a",
          "dialect-b": "candidate b"
        },
        answer: `FUSION_DIALECT_OK:${door.id}`
      });
      const response = await callDoor(stack.gatewayUrl, door, {
        model: "fusion-panel",
        user: `exercise ${door.id}`
      });
      assert.equal(response.status, 200, await stack.sim.describeJournal());
      assert.match(
        door.textOf(await response.json()),
        new RegExp(`FUSION_DIALECT_OK:${door.id}`)
      );
    }
  );
}

test("FusionBackend discovery exposes fused and opaque RouteKit endpoint ids", {
  skip: SKIP
}, async () => {
  const response = await stack.door.models();
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((entry) => entry.id).sort(),
    ["fusion-panel", "member-a", "member-b", "judge"].sort()
  );
  assert.ok(
    body.data.every((entry) => !entry.id.startsWith("dialect-")),
    "provider model names must remain behind RouteKit"
  );
});
