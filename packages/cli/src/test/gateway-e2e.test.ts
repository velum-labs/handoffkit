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

import { passthroughModelsFor } from "../gateway.js";
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

test("FusionBackend discovery exposes fused and namespaced RouteKit model ids", {
  skip: SKIP
}, async () => {
  const response = await stack.door.models();
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Array<{ id: string }> };
  assert.deepEqual(
    body.data.map((entry) => entry.id).sort(),
    [
      "fusion-panel",
      "openai/dialect-a",
      "anthropic/dialect-b",
      "openai/dialect-judge"
    ].sort()
  );
  assert.ok(
    body.data.every(
      (entry) => entry.id === "fusion-panel" || entry.id.includes("/")
    ),
    "passthrough models must stay namespaced"
  );
});

test("CLI passthrough construction uses inventory provider identity, never model naming", () => {
  const [codex, openai, unknown] = passthroughModelsFor(
    [
      { id: "opaque-a", model: "opaque-a", provider: "codex" },
      {
        id: "codex-looking-openai-id",
        model: "codex-looking-openai-id",
        provider: "openai",
        reasoning: { status: "supported", provenance: "provider", wireShape: "openai-chat" }
      },
      { id: "codex-looking-unknown-id", model: "codex-looking-unknown-id" }
    ],
    "http://routekit.test"
  );
  assert.equal(codex?.reasoningWireShape, "openai-responses");
  assert.equal(openai?.reasoningWireShape, "openai-chat");
  assert.equal(unknown?.reasoningWireShape, undefined);
});

test("Responses encrypted reasoning reaches a codex passthrough downstream", {
  skip: SKIP
}, async () => {
  const codexStack = await startSimFusionStack({
    members: [
      { id: "member", model: "panel-member", provider: "openai" },
      { id: "codex", model: "opaque-codex-model", provider: "codex" },
      { id: "judge", model: "panel-judge", provider: "openai" }
    ],
    judgeId: "judge"
  });
  try {
    await codexStack.sim.queue("opaque-codex-model", ["codex passthrough answer"]);
    const response = await codexStack.door.responses({
      model: "codex/opaque-codex-model",
      input: [
        { role: "user", content: "continue" },
        {
          type: "reasoning",
          id: "rs_passthrough",
          summary: [],
          encrypted_content: "opaque-passthrough"
        },
        { type: "message", role: "assistant", content: "continuing" }
      ],
      include: ["reasoning.encrypted_content"]
    });
    assert.equal(response.status, 200, await response.text());
    const calls = await codexStack.sim.calls({
      model: "opaque-codex-model",
      dialect: "openai-responses"
    });
    assert.equal(calls.length, 1, await codexStack.sim.describeJournal());
    assert.equal(JSON.stringify(calls[0]?.request).includes("opaque-passthrough"), true);
    assert.deepEqual(calls[0]?.request.include, ["reasoning.encrypted_content"]);
  } finally {
    await codexStack.close();
  }
});
