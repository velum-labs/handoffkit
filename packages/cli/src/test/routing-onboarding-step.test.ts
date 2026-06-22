import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { fusionConfigDir, fusionConfigPath } from "../fusion-config.js";
import { runRoutingOnboardingStep } from "../fusion/routing-onboarding-step.js";
import { ROUTING_API_KEY_ENVS } from "../fusion/routing-onboarding.js";
import type { RoutingOnboardingDetection } from "../fusion/routing-onboarding.js";

const AI_JSON = {
  routes: {
    default: "claude-sub,claude-sonnet-4-5",
    background: "groq,llama-3.1-8b-instant",
    longContext: "gemini,gemini-2.5-pro",
    longContextThreshold: 60_000,
    reasoning: "deepseek,deepseek-v4-pro",
    webSearch: "openrouter,anthropic/claude-sonnet-4.6"
  },
  providers: [
    { id: "claude-sub", provider: "anthropic" },
    { id: "groq", provider: "groq", keyEnv: "GROQ_API_KEY" }
  ]
};

function claudeDetection(): RoutingOnboardingDetection {
  return {
    subscriptions: {
      "claude-code": { mode: "claude-code", available: true, expired: false },
      codex: { mode: "codex", available: false, expired: false }
    },
    apiKeys: Object.fromEntries(ROUTING_API_KEY_ENVS.map((key) => [key, false])) as RoutingOnboardingDetection["apiKeys"]
  };
}

test("routing step: AI happy path accepts MLX proposal", async () => {
  const result = await runRoutingOnboardingStep({
    host: { platform: "darwin", arch: "arm64", totalRamGB: 32, appleSilicon: true },
    probeMlx: async () => ({ available: true }),
    generate: async () => JSON.stringify(AI_JSON),
    promptOverrides: { enableRouting: true, preferAi: true, action: "accept" }
  });
  assert.equal(result.usedAi, true);
  assert.equal(result.fellBackToDefaults, false);
  assert.equal(result.routing?.routes.default, "claude-sub,claude-sonnet-4-5");
});

test("routing step: AI declined uses deterministic defaults", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const result = await runRoutingOnboardingStep({
    host: { platform: "darwin", arch: "arm64", totalRamGB: 32, appleSilicon: true },
    probeMlx: async () => ({ available: true }),
    generate: async () => {
      throw new Error("MLX should not be called when user declines AI");
    },
    promptOverrides: { enableRouting: true, preferAi: false, action: "accept" }
  });
  assert.equal(result.usedAi, false);
  assert.equal(result.fellBackToDefaults, true);
  assert.equal(result.routing?.routes.default, "claude-sub,claude-sonnet-4-5");
  delete process.env.ANTHROPIC_API_KEY;
});

test("routing step: no MLX uses deterministic fallback", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const result = await runRoutingOnboardingStep({
    host: { platform: "linux", arch: "x64", totalRamGB: 64, appleSilicon: false },
    aiRouting: true,
    probeMlx: async () => ({ available: false, reason: "local MLX requires Apple Silicon" })
  });
  assert.equal(result.usedAi, false);
  assert.equal(result.fellBackToDefaults, true);
  assert.ok(result.routing);
  delete process.env.ANTHROPIC_API_KEY;
});

test("proposeAiRouting mocked failure returns deterministic config", async () => {
  const { proposeAiRouting } = await import("../fusion/routing-onboarding-ai.js");
  const result = await proposeAiRouting(
    {
      ...claudeDetection(),
      apiKeys: { ...claudeDetection().apiKeys, ANTHROPIC_API_KEY: true }
    },
    {
      generate: async () => "not valid json at all"
    }
  );
  assert.equal(result.source, "deterministic");
  assert.equal(result.config.routes.default, "claude-sub,claude-sonnet-4-5");
});

const tmpRoots: string[] = [];

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("routing step: proposal phase leaves on-disk fusion.json unchanged", async () => {
  const repo = mkdtempSync(join(tmpdir(), "routing-onboarding-disk-"));
  tmpRoots.push(repo);
  const original = JSON.stringify({ version: "fusionkit.fusion.v2", tool: "codex" }, null, 2) + "\n";
  mkdirSync(fusionConfigDir(repo), { recursive: true });
  writeFileSync(fusionConfigPath(repo), original);

  await runRoutingOnboardingStep({
    host: { platform: "darwin", arch: "arm64", totalRamGB: 32, appleSilicon: true },
    probeMlx: async () => ({ available: false }),
    promptOverrides: { enableRouting: true, preferAi: false, action: "accept" },
    onProposalReady: () => {
      assert.equal(readFileSync(fusionConfigPath(repo), "utf8"), original);
    }
  });

  assert.equal(readFileSync(fusionConfigPath(repo), "utf8"), original);
});

test("routing step: ai-routing auto-accepts in non-TTY contexts", async () => {
  const result = await runRoutingOnboardingStep({
    host: { platform: "linux", arch: "x64", totalRamGB: 64, appleSilicon: false },
    aiRouting: true,
    probeMlx: async () => ({ available: false, reason: "local MLX requires Apple Silicon" })
  });
  assert.ok(result.routing);
  assert.equal(result.usedAi, false);
});
