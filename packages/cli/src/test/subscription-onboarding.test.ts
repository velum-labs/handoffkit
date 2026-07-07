import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { detectCodexModel, detectSubscription } from "../fusion/subscriptions.js";
import { routerConfigYaml } from "../fusion/stack.js";
import { parsePanelModelSpec } from "../shared/options.js";

const tmpRoots: string[] = [];
const originalHome = process.env.HOME;
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion-sub-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `header.${payload}.sig`;
}

// --- panel spec parsing ----------------------------------------------------

test("parsePanelModelSpec maps claude-code to anthropic + auth", () => {
  const spec = parsePanelModelSpec("cc=claude-code:claude-sonnet-4-5", {});
  assert.deepEqual(spec, {
    id: "cc",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    auth: "claude-code"
  });
});

test("parsePanelModelSpec maps codex to auth without provider", () => {
  const spec = parsePanelModelSpec("cx=codex:gpt-5.5", {});
  assert.deepEqual(spec, { id: "cx", model: "gpt-5.5", auth: "codex" });
});

test("parsePanelModelSpec still handles normal providers and bare mlx", () => {
  assert.equal(parsePanelModelSpec("g=openai:gpt-5.5", {}).provider, "openai");
  assert.equal(parsePanelModelSpec("q=some-model", {}).provider, "mlx");
});

test("parsePanelModelSpec keeps slashes and variant colons in openrouter model ids", () => {
  const spec = parsePanelModelSpec("or=openrouter:deepseek/deepseek-chat:free", {});
  assert.deepEqual(spec, {
    id: "or",
    model: "deepseek/deepseek-chat:free",
    provider: "openrouter"
  });
});

// --- router config generation ----------------------------------------------

test("routerConfigYaml emits auth blocks and omits api_key_env for subscriptions", () => {
  const yaml = routerConfigYaml({
    specs: [
      { id: "claude-code", model: "claude-sonnet-4-5", provider: "anthropic", auth: "claude-code" },
      { id: "codex", model: "gpt-5.5", auth: "codex" },
      { id: "gpt", model: "gpt-5.5", provider: "openai" }
    ],
    mlxUrls: {},
    judgeId: "claude-code"
  });

  assert.match(yaml, /provider: anthropic\n {4}auth:\n {6}mode: claude-code/);
  assert.match(yaml, /provider: codex\n {4}auth:\n {6}mode: codex/);
  // API-key cloud model still gets its env var.
  assert.match(yaml, /api_key_env: OPENAI_API_KEY/);
  // Subscription endpoints carry no api_key_env.
  const claudeBlock = yaml.slice(yaml.indexOf("id: claude-code"), yaml.indexOf("id: codex"));
  assert.doesNotMatch(claudeBlock, /api_key_env/);
});

test("routerConfigYaml emits the OpenRouter base URL and default key env", () => {
  const yaml = routerConfigYaml({
    specs: [{ id: "or", model: "deepseek/deepseek-chat:free", provider: "openrouter" }],
    mlxUrls: {},
    judgeId: "or"
  });

  assert.match(yaml, /provider: openrouter/);
  // No trailing /v1: fusionkit's OpenAI-compatible client appends it.
  assert.match(yaml, /base_url: https:\/\/openrouter\.ai\/api/);
  assert.match(yaml, /api_key_env: OPENROUTER_API_KEY/);
  assert.match(yaml, /model: deepseek\/deepseek-chat:free/);
});

// --- login detection -------------------------------------------------------

test("detectSubscription(codex) reads a temp auth.json", async () => {
  const home = freshHome();
  process.env.HOME = home;
  mkdirSync(join(home, ".codex"), { recursive: true });
  const token = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" }
  });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: token } }));

  const status = await detectSubscription("codex");
  assert.equal(status.available, true);
  assert.equal(status.expired, false);
  assert.equal(status.accountId, "acct_test");
});

test("detectSubscription(codex) reports unavailable with no auth.json", async () => {
  process.env.HOME = freshHome();
  const status = await detectSubscription("codex");
  assert.equal(status.available, false);
});

test("detectCodexModel reads the pinned model from config.toml", () => {
  const home = freshHome();
  process.env.HOME = home;
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5.5"\nmodel_reasoning_effort = "xhigh"\n');
  assert.equal(detectCodexModel(), "gpt-5.5");
});
