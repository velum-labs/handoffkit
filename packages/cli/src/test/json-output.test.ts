/**
 * The `--json` machine-output contract: every informational/mutating command
 * emits exactly one JSON document on stdout (UI stays on stderr), and config
 * mutations round-trip through the validated store.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(config?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-json-cli-"));
  tempDirs.push(dir);
  if (config !== undefined) {
    mkdirSync(join(dir, ".fusionkit"), { recursive: true });
    writeFileSync(join(dir, ".fusionkit", "fusion.json"), JSON.stringify(config, null, 2) + "\n");
  }
  return dir;
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FUSIONKIT_NO_TUI: "1" }
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

const BASE_CONFIG = {
  version: "fusionkit.fusion.v3",
  tool: "claude",
  ensembles: {
    default: {
      panel: [{ id: "gpt", model: "gpt-5.5", provider: "openai", keyEnv: "OPENAI_API_KEY" }],
      judgeModel: "gpt-5.5"
    }
  }
};

test("config show --json emits the effective config with provenance", () => {
  const repo = makeRepo(BASE_CONFIG);
  const result = runCli(["config", "show", "--repo", repo, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson<{
    source: string;
    effective: { tool: { value: string; source: string }; panel: { value: unknown[]; source: string } };
  }>(result.stdout);
  assert.equal(payload.effective.tool.value, "claude");
  assert.equal(payload.effective.tool.source, "config");
  assert.equal(payload.effective.panel.value.length, 1);
});

test("config get/set/unset --json round-trip a value through the validated store", () => {
  const repo = makeRepo(BASE_CONFIG);

  const set = runCli(["config", "set", "budgetUsd", "5", "--repo", repo, "--json"]);
  assert.equal(set.status, 0, set.stderr);
  assert.equal(parseJson<{ value: number }>(set.stdout).value, 5);

  const get = runCli(["config", "get", "budgetUsd", "--repo", repo, "--json"]);
  assert.equal(get.status, 0, get.stderr);
  assert.deepEqual(parseJson(get.stdout), { path: "budgetUsd", value: 5, set: true });

  const written = JSON.parse(readFileSync(join(repo, ".fusionkit", "fusion.json"), "utf8")) as {
    budgetUsd?: number;
  };
  assert.equal(written.budgetUsd, 5);

  const unset = runCli(["config", "unset", "budgetUsd", "--repo", repo, "--json"]);
  assert.equal(unset.status, 0, unset.stderr);
  const cleared = runCli(["config", "get", "budgetUsd", "--repo", repo, "--json"]);
  assert.equal(cleared.status, 1);
  assert.equal(parseJson<{ set: boolean }>(cleared.stdout).set, false);
});

test("config set rejects invalid values with the validator's message", () => {
  const repo = makeRepo(BASE_CONFIG);
  const result = runCli(["config", "set", "budgetUsd", "-3", "--repo", repo]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /budgetUsd must be a positive number/);
});

test("config set rejects unknown paths with guidance", () => {
  const repo = makeRepo(BASE_CONFIG);
  const result = runCli(["config", "set", "frobnicate", "1", "--repo", repo]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown config path/);
  assert.match(result.stderr, /budgetUsd/);
});

test("ensemble CRUD and config defaultEnsemble manage named ensembles end to end", () => {
  const repo = makeRepo(BASE_CONFIG);

  const add = runCli([
    "ensemble",
    "add",
    "fast",
    "--repo",
    repo,
    "--model",
    "mini=openai:gpt-5.5-mini",
    "--judge",
    "gpt-5.5-mini",
    "--json"
  ]);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(parseJson<{ modelId: string }>(add.stdout).modelId, "fusion-fast");

  const selectDefault = runCli(["config", "set", "defaultEnsemble", "fast", "--repo", repo, "--json"]);
  assert.equal(selectDefault.status, 0, selectDefault.stderr);

  const list = runCli(["ensemble", "list", "--repo", repo, "--json"]);
  assert.equal(list.status, 0, list.stderr);
  const listed = parseJson<{
    defaultEnsemble: string;
    ensembles: Array<{ name: string; default: boolean; panel: Array<{ id: string }> }>;
  }>(list.stdout);
  assert.equal(listed.defaultEnsemble, "fast");
  const fast = listed.ensembles.find((entry) => entry.name === "fast");
  assert.equal(fast?.default, true);
  assert.deepEqual(fast?.panel.map((spec) => spec.id), ["mini"]);

  const edit = runCli([
    "ensemble",
    "edit",
    "fast",
    "--repo",
    repo,
    "--add-model",
    "flash=google:gemini-2.5-flash",
    "--json"
  ]);
  assert.equal(edit.status, 0, edit.stderr);
  assert.equal(parseJson<{ panel: unknown[] }>(edit.stdout).panel.length, 2);

  const rename = runCli(["ensemble", "rename", "fast", "quick", "--repo", repo, "--json"]);
  assert.equal(rename.status, 0, rename.stderr);

  const remove = runCli(["ensemble", "remove", "quick", "--repo", repo, "--yes", "--json"]);
  assert.equal(remove.status, 0, remove.stderr);
  const after = parseJson<{ ensembles: Array<{ name: string }>; defaultEnsemble: string | null }>(
    runCli(["ensemble", "list", "--repo", repo, "--json"]).stdout
  );
  assert.deepEqual(after.ensembles.map((entry) => entry.name), ["default"]);
});

test("ensemble add refuses non-interactive runs without --model flags", () => {
  const repo = makeRepo(BASE_CONFIG);
  const result = runCli(["ensemble", "add", "fast", "--repo", repo]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model/);
});

test("ensemble remove refuses to delete the last ensemble", () => {
  const repo = makeRepo(BASE_CONFIG);
  const result = runCli(["ensemble", "remove", "default", "--repo", repo, "--yes"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only ensemble/);
});

test("prompts list --json reports override state per ensemble", () => {
  const repo = makeRepo(BASE_CONFIG);
  mkdirSync(join(repo, ".fusionkit", "prompts"), { recursive: true });
  writeFileSync(join(repo, ".fusionkit", "prompts", "judge.md"), "be brief\n");
  const result = runCli(["prompts", "list", "--repo", repo, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson<{ prompts: Array<{ id: string; ensemble: string; active: boolean }> }>(result.stdout);
  const judge = payload.prompts.find((entry) => entry.id === "judge" && entry.ensemble === "default");
  assert.equal(judge?.active, true);
  const synth = payload.prompts.find((entry) => entry.id === "synthesizer");
  assert.equal(synth?.active, false);
});

test("prompts reset --json removes an override", () => {
  const repo = makeRepo(BASE_CONFIG);
  mkdirSync(join(repo, ".fusionkit", "prompts"), { recursive: true });
  writeFileSync(join(repo, ".fusionkit", "prompts", "judge.md"), "be brief\n");
  const result = runCli(["prompts", "reset", "judge", "--repo", repo, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseJson<{ reset: boolean }>(result.stdout).reset, true);
});

test("config show --json carries the dry-run preview fields", () => {
  const repo = makeRepo(BASE_CONFIG);
  const result = runCli(["config", "show", "--repo", repo, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson<{ runPlan: { modelServers: number; tool: string; spawnsCloud: boolean } }>(
    result.stdout
  );
  assert.deepEqual(payload.runPlan, { modelServers: 1, tool: "claude", spawnsCloud: true });
});

test("sessions list --json emits a sessions array", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-json-sessions-"));
  tempDirs.push(dir);
  const result = spawnSync(process.execPath, [CLI, "sessions", "list", "--json"], {
    encoding: "utf8",
    env: { ...process.env, FUSIONKIT_SESSIONS_DIR: dir, NO_COLOR: "1", FUSIONKIT_NO_TUI: "1" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sessions: [] });
});

test("--json errors are structured on stdout", () => {
  const repo = makeRepo({ version: "fusionkit.fusion.v3", tool: "not-a-tool" });
  const result = runCli(["config", "show", "--repo", repo, "--json"]);
  assert.equal(result.status, 1);
  const payload = parseJson<{ error: { message: string } }>(result.stdout);
  assert.match(payload.error.message, /tool must be one of/);
});
