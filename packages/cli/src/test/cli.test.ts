import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

function fusionkit(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      NO_COLOR: "1",
      FUSIONKIT_NO_TUI: "1",
      ...options.env
    }
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function makeRepo(): { repo: string; cleanup(): void } {
  const repo = mkdtempSync(join(tmpdir(), "fusionkit-v4-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=e2e@fusionkit.local",
      "-c",
      "user.name=fusionkit-e2e",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "fixture"
    ],
    { cwd: repo }
  );
  return {
    repo,
    cleanup: () => rmSync(repo, { recursive: true, force: true })
  };
}

test("help exposes all four Fusion launchers and only Fusion product commands", () => {
  const result = fusionkit(["help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const command of [
    "codex",
    "claude",
    "cursor",
    "opencode",
    "serve",
    "init",
    "setup",
    "doctor",
    "config",
    "prompts",
    "sessions",
    "ensemble",
    "stop"
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`), command);
  }
  for (const removed of ["proxy", "accounts", "install", "uninstall", "local"]) {
    assert.doesNotMatch(result.stdout, new RegExp(`^  ${removed}\\b`, "m"));
  }
});

test("completion is generated from the v4 Commander tree", () => {
  const bash = fusionkit(["completion", "bash"]);
  assert.equal(bash.status, 0, bash.stderr);
  for (const command of ["codex", "claude", "cursor", "opencode", "ensemble"]) {
    assert.match(bash.stdout, new RegExp(`\\b${command}\\b`));
  }
  const prefix = fusionkit(["__complete", "--", ""]);
  assert.equal(prefix.status, 0, prefix.stderr);
  const candidates = prefix.stdout.split("\n");
  for (const command of ["codex", "claude", "cursor", "opencode"]) {
    assert.ok(candidates.includes(command));
  }
});

test("removed routing, account, and install commands are rejected", () => {
  for (const args of [
    ["proxy"],
    ["accounts"],
    ["install", "codex"]
  ]) {
    const result = fusionkit(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /unknown (?:command|option)/i);
  }
});

test("all four launcher help surfaces share the Fusion option contract", () => {
  for (const tool of ["codex", "claude", "cursor", "opencode"]) {
    const result = fusionkit([tool, "--help"]);
    assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
    assert.match(result.stdout, /--ensemble/);
    assert.doesNotMatch(result.stdout, /--direct|--model|--provider/);
  }
});

test("init writes v4 Fusion config and a separate safe RouteKit config", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit([
      "--no-input",
      "init",
      "--repo",
      fixture.repo
    ]);
    assert.equal(result.status, 0, result.stderr);
    const fusionPath = join(fixture.repo, ".fusionkit", "fusion.json");
    const routerPath = join(fixture.repo, ".routekit", "router.yaml");
    assert.ok(existsSync(fusionPath));
    assert.ok(existsSync(routerPath));
    const config = JSON.parse(readFileSync(fusionPath, "utf8")) as {
      version: string;
      router: unknown;
      ensembles: Record<string, { members: string[] }>;
    };
    assert.equal(config.version, "fusionkit.fusion.v4");
    assert.deepEqual(config.router, { config: ".routekit/router.yaml" });
    assert.deepEqual(config.ensembles.default?.members, ["openai/gpt-5.5"]);
    assert.doesNotMatch(
      readFileSync(fusionPath, "utf8"),
      /baseUrl|apiKey|subscription/
    );
    assert.match(readFileSync(routerPath, "utf8"), /providers:/);
    assert.match(readFileSync(routerPath, "utf8"), /defaultModel: openai\/gpt-5.5/);
  } finally {
    fixture.cleanup();
  }
});

test("v3 config is rejected with RouteKit migration guidance", () => {
  const fixture = makeRepo();
  try {
    mkdirSync(join(fixture.repo, ".fusionkit"));
    writeFileSync(
      join(fixture.repo, ".fusionkit", "fusion.json"),
      JSON.stringify({
        version: "fusionkit.fusion.v3",
        panel: [{ id: "legacy", provider: "openai" }]
      })
    );
    const result = fusionkit([
      "config",
      "show",
      "--repo",
      fixture.repo
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /routekit\/router\.yaml/i);
  } finally {
    fixture.cleanup();
  }
});
