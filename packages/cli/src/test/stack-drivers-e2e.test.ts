/**
 * Canonical harness-core drivers through the full stack with the real Claude
 * Agent SDK / Codex SDK and their real
 * binaries. RouteKit's single gateway translates each native protocol before
 * it reaches the credential-free Python sidecar. Two turns prove native cursor handling; Claude's
 * worktree-scoped stale cursor intentionally falls back to a fresh session
 * carrying the full gateway conversation instead of failing the follow-up.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cliSkip, judgeAnalysis, stackToolingSkip } from "@fusionkit/testkit";

import { startSimFusionStack } from "./sim-stack.js";

const STACK_SKIP = stackToolingSkip();

type DriverCase = {
  id: string;
  harness: "claude-code" | "codex";
  binary: string;
  provider: "anthropic" | "openai";
  model: string;
  dialect: "anthropic-messages" | "openai-chat";
  env: Record<string, string>;
};

const CASES: readonly DriverCase[] = [
  {
    id: "claude-agent-sdk",
    harness: "claude-code",
    binary: "claude",
    provider: "anthropic",
    model: "claude-driver-model",
    dialect: "anthropic-messages",
    env: {
      ANTHROPIC_AUTH_TOKEN: "local-driver-token",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  },
  {
    id: "codex-sdk",
    harness: "codex",
    binary: "codex",
    provider: "openai",
    model: "codex-driver-model",
    dialect: "openai-chat",
    env: { OPENAI_API_KEY: "local-driver-key" }
  }
];

for (const driverCase of CASES) {
  const binarySkip = STACK_SKIP !== false ? STACK_SKIP : cliSkip(driverCase.binary);
  test(
    `[${driverCase.id}] real driver runs two fused turns through native per-member dialect gateways`,
    { skip: binarySkip },
    async () => {
      const previous: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(driverCase.env)) {
        previous[name] = process.env[name];
        process.env[name] = value;
      }
      const stack = await startSimFusionStack({
        members: [
          {
            id: "member",
            model: driverCase.model,
            provider: driverCase.provider,
            reasoning: {
              status: "supported" as const,
              efforts: [{ id: "high" }],
              ...(driverCase.provider === "anthropic"
                ? {
                    budget: { minTokens: 1, maxTokens: 1_000_000 },
                    adaptive: true,
                    wireShape: "anthropic"
                  }
                : { wireShape: "openai-chat" }),
              provenance: "provider" as const
            }
          },
          { id: "judge", model: `${driverCase.id}-judge`, provider: "openai" }
        ],
        judgeId: "judge",
        harness: driverCase.harness,
        unbounded: true
      });
      try {
        for (const turn of [1, 2]) {
          await stack.sim.queue(driverCase.model, [`${driverCase.id} candidate turn ${turn}`]);
          await stack.sim.queue(`${driverCase.id}-judge`, [
            { reply: judgeAnalysis() },
            { reply: `${driverCase.id.toUpperCase()}_DRIVER_OK_TURN_${turn}` }
          ]);
        }

        const first = await stack.door.chat({
          model: "fusion-panel",
          messages: [{ role: "user", content: "first native-driver task" }]
        });
        assert.equal(first.status, 200, await stack.sim.describeJournal());
        const firstText = ((await first.json()) as {
          choices: Array<{ message: { content: string } }>;
        }).choices[0]?.message.content;
        assert.match(firstText ?? "", /DRIVER_OK_TURN_1/);

        const second = await stack.door.chat({
          model: "fusion-panel",
          messages: [
            { role: "user", content: "first native-driver task" },
            { role: "assistant", content: firstText },
            { role: "user", content: "follow-up native-driver task" }
          ]
        });
        assert.equal(second.status, 200, await stack.sim.describeJournal());
        const secondText = ((await second.json()) as {
          choices: Array<{ message: { content: string } }>;
        }).choices[0]?.message.content;
        assert.match(secondText ?? "", /DRIVER_OK_TURN_2/);

        const memberCalls = await stack.sim.calls({
          model: driverCase.model,
          dialect: driverCase.dialect
        });
        assert.equal(memberCalls.length, 2, await stack.sim.describeJournal());
        assert.ok(
          memberCalls.every((entry) => entry.stream),
          "the real native driver must use its streaming protocol"
        );
        assert.ok(
          memberCalls.every((entry) => entry.model === driverCase.model),
          "the canonical driver must route by the opaque member endpoint"
        );
      } finally {
        await stack.close();
        for (const [name] of Object.entries(driverCase.env)) {
          if (previous[name] === undefined) delete process.env[name];
          else process.env[name] = previous[name];
        }
      }
    }
  );
}
