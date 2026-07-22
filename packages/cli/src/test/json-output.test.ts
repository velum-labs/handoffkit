/** Machine-output contract for FusionKit v4 commands. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));
const tempDirs: string[] = [];

after(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const BASE_CONFIG = {
  version: "fusionkit.fusion.v4",
  router: { url: "http://127.0.0.1:9" },
  tool: "claude",
  ensembles: {
    default: {
      members: ["openai/route-fast", "anthropic/route-deep"],
      judge: "anthropic/route-deep"
    }
  }
};

function makeRepo(config: Record<string, unknown> = BASE_CONFIG): string {
  const directory = mkdtempSync(join(tmpdir(), "fusionkit-v4-json-"));
  tempDirs.push(directory);
  mkdirSync(join(directory, ".fusionkit"), { recursive: true });
  writeFileSync(
    join(directory, ".fusionkit", "fusion.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );
  return directory;
}

function runCli(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FUSIONKIT_NO_TUI: "1" }
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

test("config show --json emits v4 router and effective namespaced ensembles", () => {
  const repo = makeRepo();
  const result = runCli(["config", "show", "--repo", repo, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = parseJson<{
    router: { url: string };
    effective: {
      tool: { value: string; source: string };
      ensembles: {
        value: Array<{ members: string[]; judge: string }>;
      };
    };
  }>(result.stdout);
  assert.equal(payload.router.url, "http://127.0.0.1:9");
  assert.equal(payload.effective.tool.value, "claude");
  assert.deepEqual(payload.effective.ensembles.value[0]?.members, [
    "openai/route-fast",
    "anthropic/route-deep"
  ]);
  assert.equal(
    payload.effective.ensembles.value[0]?.judge,
    "anthropic/route-deep"
  );
});

test("config get/set/unset --json round-trips validated v4 values", () => {
  const repo = makeRepo();
  const set = runCli([
    "config",
    "set",
    "budgetUsd",
    "5",
    "--repo",
    repo,
    "--json"
  ]);
  assert.equal(set.status, 0, set.stderr);
  assert.deepEqual(parseJson(set.stdout), { path: "budgetUsd", value: 5 });
  assert.deepEqual(
    parseJson(runCli(["config", "get", "budgetUsd", "--repo", repo, "--json"]).stdout),
    { path: "budgetUsd", value: 5 }
  );
  const persisted = JSON.parse(
    readFileSync(join(repo, ".fusionkit", "fusion.json"), "utf8")
  ) as { budgetUsd?: number };
  assert.equal(persisted.budgetUsd, 5);
  const unset = runCli([
    "config",
    "unset",
    "budgetUsd",
    "--repo",
    repo,
    "--json"
  ]);
  assert.equal(unset.status, 0, unset.stderr);
  assert.deepEqual(parseJson(unset.stdout), {
    path: "budgetUsd",
    unset: true
  });
});

test("ensemble JSON CRUD stores only namespaced RouteKit model ids", () => {
  const repo = makeRepo();
  const added = runCli([
    "ensemble",
    "add",
    "review",
    "--member",
    "openai/route-deep",
    "--judge",
    "openai/route-deep",
    "--repo",
    repo,
    "--json"
  ]);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(parseJson(added.stdout), { added: "review" });

  const listed = parseJson<{
    ensembles: Array<{
      name: string;
      members: string[];
      judge: string;
    }>;
  }>(runCli(["ensemble", "list", "--repo", repo, "--json"]).stdout);
  assert.deepEqual(
    listed.ensembles.find((entry) => entry.name === "review"),
    {
      name: "review",
      modelId: "fusion-review",
      default: false,
      members: ["openai/route-deep"],
      judge: "openai/route-deep"
    }
  );
  const serialized = readFileSync(
    join(repo, ".fusionkit", "fusion.json"),
    "utf8"
  );
  assert.doesNotMatch(serialized, /provider|baseUrl|apiKey|subscription/i);
});

test("prompts and sessions retain single-document JSON output", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, ".fusionkit", "prompts"), { recursive: true });
  writeFileSync(
    join(repo, ".fusionkit", "prompts", "judge.md"),
    "be brief\n"
  );
  const prompts = parseJson<{
    prompts: Array<{ id: string; active: boolean }>;
  }>(runCli(["prompts", "list", "--repo", repo, "--json"]).stdout);
  assert.equal(
    prompts.prompts.find((entry) => entry.id === "judge")?.active,
    true
  );

  const sessionsDir = mkdtempSync(join(tmpdir(), "fusionkit-json-sessions-"));
  tempDirs.push(sessionsDir);
  const sessions = spawnSync(
    process.execPath,
    [CLI, "sessions", "list", "--json"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FUSIONKIT_SESSIONS_DIR: sessionsDir,
        NO_COLOR: "1",
        FUSIONKIT_NO_TUI: "1"
      }
    }
  );
  assert.equal(sessions.status, 0, sessions.stderr);
  assert.deepEqual(JSON.parse(sessions.stdout), { sessions: [] });
});

test("v3 --json errors return actionable migration guidance", () => {
  const repo = makeRepo({
    version: "fusionkit.fusion.v3",
    panel: [{ id: "legacy", provider: "openai" }]
  });
  const result = runCli(["config", "show", "--repo", repo, "--json"]);
  assert.equal(result.status, 1);
  const payload = parseJson<{ error: { message: string } }>(result.stdout);
  assert.match(payload.error.message, /routekit\/router\.yaml/i);
  assert.match(payload.error.message, /provider\/model/i);
});
