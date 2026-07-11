import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { buildAuthOptions, defaultModelForAuthChoice, specForAuthChoice } from "../fusion/panel-auth.js";
import { defaultMemberId, judgeOptions } from "../fusion-init.js";

const tmpRoots: string[] = [];
const originalHome = process.env.HOME;
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-auth-"));
  tmpRoots.push(dir);
  return dir;
}

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

// --- specForAuthChoice: auth is decoupled from the model -------------------

test("specForAuthChoice maps subscriptions to auth, no keyEnv", () => {
  assert.deepEqual(specForAuthChoice("claude-code", "cc", "claude-opus-4-8"), {
    id: "cc",
    model: "claude-opus-4-8",
    provider: "anthropic",
    auth: "claude-code"
  });
  assert.deepEqual(specForAuthChoice("codex", "cx", "gpt-5.5"), {
    id: "cx",
    model: "gpt-5.5",
    auth: "codex"
  });
});

test("specForAuthChoice maps API-key providers to a keyEnv, no auth", () => {
  assert.deepEqual(specForAuthChoice("openai", "g", "gpt-5.5"), {
    id: "g",
    model: "gpt-5.5",
    provider: "openai",
    keyEnv: "OPENAI_API_KEY"
  });
  assert.equal(specForAuthChoice("anthropic", "a", "claude-x").keyEnv, "ANTHROPIC_API_KEY");
  assert.equal(specForAuthChoice("google", "ge", "gemini-x").keyEnv, "GEMINI_API_KEY");
  assert.deepEqual(specForAuthChoice("openrouter", "or", "moonshotai/kimi-k2"), {
    id: "or",
    model: "moonshotai/kimi-k2",
    provider: "openrouter",
    keyEnv: "OPENROUTER_API_KEY"
  });
});

test("specForAuthChoice maps local to the mlx provider", () => {
  assert.deepEqual(specForAuthChoice("local", "q", "some-mlx-model"), {
    id: "q",
    model: "some-mlx-model",
    provider: "mlx"
  });
});

test("defaultModelForAuthChoice gives a per-choice default", () => {
  assert.equal(defaultModelForAuthChoice("openai"), "gpt-5.5");
  assert.equal(defaultModelForAuthChoice("claude-code"), "claude-sonnet-4-5");
  assert.equal(defaultModelForAuthChoice("google"), "gemini-2.5-flash");
  assert.equal(defaultModelForAuthChoice("openrouter"), "anthropic/claude-sonnet-4.5");
});

// --- buildAuthOptions: combinable methods, gated by detection --------------

test("buildAuthOptions always offers API-key providers and local", async () => {
  process.env.HOME = freshHome();
  const values = (await buildAuthOptions({})).map((option) => option.value);
  for (const expected of ["openai", "anthropic", "google", "openrouter", "local"] as const) {
    assert.ok(values.includes(expected), `expected ${expected} in ${values.join(", ")}`);
  }
});

test("buildAuthOptions hint reflects whether the API key env is set", async () => {
  process.env.HOME = freshHome();
  const set = (await buildAuthOptions({ OPENAI_API_KEY: "x" })).find((o) => o.value === "openai");
  const unset = (await buildAuthOptions({})).find((o) => o.value === "openai");
  assert.match(set?.hint ?? "", /is set/);
  assert.match(unset?.hint ?? "", /set OPENAI_API_KEY/);
});

// --- judge + member-id helpers ---------------------------------------------

test("judgeOptions yields one entry per member, value=model, deduped by model", () => {
  const options = judgeOptions([
    { id: "claude-code", model: "claude-sonnet-4-5", provider: "anthropic", auth: "claude-code" },
    { id: "gpt", model: "gpt-5.5", provider: "openai" },
    { id: "gpt-dup", model: "gpt-5.5", provider: "openai" }
  ]);
  assert.equal(options.length, 2);
  assert.deepEqual(options[0], { value: "claude-sonnet-4-5", label: "claude-code (claude-sonnet-4-5)" });
  assert.equal(options[1]?.value, "gpt-5.5");
});

test("defaultMemberId derives the base from the choice and unique-ifies", () => {
  const taken = new Set<string>();
  const first = defaultMemberId("openai", taken);
  assert.equal(first, "openai");
  taken.add(first);
  assert.equal(defaultMemberId("openai", taken), "openai-2");
  assert.equal(defaultMemberId("claude-code", taken), "claude-code");
});

test("buildAuthOptions local hint reflects the host", async () => {
  process.env.HOME = freshHome();
  const apple = (
    await buildAuthOptions({}, { platform: "darwin", arch: "arm64", totalRamGB: 32, appleSilicon: true })
  ).find((option) => option.value === "local");
  assert.match(apple?.hint ?? "", /32GB RAM/);

  const other = (
    await buildAuthOptions({}, { platform: "linux", arch: "x64", totalRamGB: 64, appleSilicon: false })
  ).find((option) => option.value === "local");
  assert.match(other?.hint ?? "", /Apple Silicon only/);
});

test("buildAuthOptions includes codex only when a login is detected", async () => {
  const home = freshHome();
  process.env.HOME = home;
  mkdirSync(join(home, ".codex"), { recursive: true });
  const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: token } }));

  const values = (await buildAuthOptions({})).map((option) => option.value);
  assert.ok(values.includes("codex"), `expected codex in ${values.join(", ")}`);
});
