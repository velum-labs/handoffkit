/**
 * Gateway authentication boundary across every front-door dialect. Missing or
 * wrong bearer credentials must be rejected before body translation, panel
 * fanout, or any provider spend; a valid token unlocks the same stack.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DOOR_PROFILES, judgeAnalysis, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";

const SKIP = stackToolingSkip();

test(
  "gateway bearer auth rejects every door before provider spend and accepts the valid token",
  { skip: SKIP },
  async () => {
    const stack = await startSimFusionStack({
      members: [
        { id: "member", model: "auth-member", provider: "openai" },
        { id: "judge", model: "auth-judge", provider: "openai" }
      ],
      judgeId: "judge",
      authToken: "test-secret"
    });
    try {
      for (const door of DOOR_PROFILES) {
        const body = door.buildRequest({
          model: "fusion-panel",
          user: `unauthorized request through ${door.id}`
        });
        for (const authorization of [undefined, "Bearer wrong-secret"]) {
          const response = await fetch(`${stack.gatewayUrl}${door.path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...door.headers,
              ...(authorization !== undefined ? { authorization } : {})
            },
            body: JSON.stringify(body)
          });
          assert.equal(response.status, 401, `${door.id} must enforce gateway auth`);
          const error = (await response.json()) as {
            error?: { message?: string; type?: string };
          };
          assert.equal(error.error?.type, "auth_error");
        }
      }
      const models = await fetch(`${stack.gatewayUrl}/v1/models`);
      assert.equal(models.status, 401, "discovery routes are protected too");
      assert.equal(
        (await stack.sim.journal()).length,
        0,
        "unauthorized requests must cause zero provider spend"
      );

      await stack.sim.queue("auth-member", ["authorized candidate"]);
      await stack.sim.queue("auth-judge", [
        { reply: judgeAnalysis() },
        { reply: "authorized fused answer" }
      ]);
      const authorized = await fetch(`${stack.gatewayUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-secret"
        },
        body: JSON.stringify({
          model: "fusion-panel",
          messages: [{ role: "user", content: "authorized request" }]
        })
      });
      assert.equal(authorized.status, 200);
      assert.match(
        ((await authorized.json()) as {
          choices: Array<{ message: { content: string } }>;
        }).choices[0]?.message.content ?? "",
        /authorized fused answer/
      );
    } finally {
      await stack.close();
    }
  }
);
