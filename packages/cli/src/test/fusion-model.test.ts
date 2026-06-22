import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { gitText } from "@fusionkit/workspace";

import {
  buildModelChoices,
  labelForModelChoice,
  labelRoutingProvider,
  runFusionModel
} from "../commands/fusion-model.js";
import { FUSION_CONFIG_VERSION, writeFusionConfig } from "../fusion-config.js";
import { sessionOverridePath, writeSessionModelOverride } from "../fusion/session-override.js";

const tmpRoots: string[] = [];

function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "fusion-model-"));
  tmpRoots.push(root);
  gitText(root, ["init", "--quiet", "--initial-branch=main"]);
  gitText(root, ["config", "user.email", "model@test.local"]);
  gitText(root, ["config", "user.name", "model"]);
  return root;
}

after(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

test("labelRoutingProvider maps subscription providers to friendly labels", () => {
  assert.equal(labelRoutingProvider({ id: "claude-sub", provider: "anthropic" }), "Claude Code subscription");
  assert.equal(labelRoutingProvider({ id: "codex-sub", provider: "openai" }), "Codex subscription");
  assert.equal(
    labelRoutingProvider({ id: "or-main", provider: "openrouter", keyEnv: "OPENROUTER_API_KEY" }),
    "OpenRouter/or-main"
  );
});

test("buildModelChoices always leads with smart routing and includes providers", () => {
  const choices = buildModelChoices(
    {
      version: FUSION_CONFIG_VERSION,
      routing: {
        routes: { default: "claude-sub,m" },
        providers: [
          { id: "claude-sub", provider: "anthropic" },
          { id: "codex-sub", provider: "openai" }
        ]
      }
    },
    undefined
  );
  assert.equal(choices[0]?.value, null);
  assert.equal(choices[0]?.label, "Smart routing (recommended)");
  assert.ok(choices.some((choice) => choice.label === "Claude Code subscription"));
  assert.ok(choices.some((choice) => choice.label === "Codex subscription"));
  assert.equal(choices.at(-1)?.label, "Custom (enter model ID)");
});

test("labelForModelChoice resolves smart routing label", () => {
  const choices = buildModelChoices(undefined, undefined);
  assert.equal(labelForModelChoice(choices, null), "Smart routing (recommended)");
});

test("runFusionModel errors on non-TTY stdin", async () => {
  const repo = freshRepo();
  writeFusionConfig(repo, { version: FUSION_CONFIG_VERSION });
  const stdin = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  let exitCode: number | undefined;
  let exitMsg = "";
  const originalExit = process.exit;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("process.exit called");
  }) as typeof process.exit;
  const originalError = console.error;
  console.error = (msg: string) => {
    exitMsg += msg;
  };
  try {
    await assert.rejects(() => runFusionModel({ repo }), /process\.exit called/);
    assert.equal(exitCode, 1);
    assert.match(exitMsg, /fusionkit fusion model requires an interactive terminal/);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
    process.exit = originalExit;
    console.error = originalError;
  }
});

test("writeSessionModelOverride writes smart-routing null modelId shape", () => {
  const home = mkdtempSync(join(tmpdir(), "fusion-model-home-"));
  tmpRoots.push(home);
  const fixed = new Date("2026-06-22T12:00:00.000Z");
  writeSessionModelOverride(null, { homeDir: home, now: () => fixed });
  const path = sessionOverridePath(home);
  assert.equal(existsSync(path), true);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { modelId: string | null; setAt: string };
  assert.equal(parsed.modelId, null);
  assert.equal(parsed.setAt, "2026-06-22T12:00:00.000Z");
});
