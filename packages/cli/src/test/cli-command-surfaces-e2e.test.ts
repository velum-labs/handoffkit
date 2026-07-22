/** Real-process coverage for non-serving FusionKit v4 CLI surfaces. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import {
  repoRoot,
  stackToolingSkip,
  startProviderSim
} from "@fusionkit/testkit";
import type { ProviderSimHandle } from "@fusionkit/testkit";

const SKIP = stackToolingSkip();
const CLI_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "index.js"
);

let root: string;
let repo: string;
let home: string;
let sim: ProviderSimHandle;

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: home,
      PORTLESS: "0",
      NO_COLOR: "1",
      FUSIONKIT_NO_TUI: "1",
      FUSIONKIT_TELEMETRY: undefined,
      OPENAI_API_KEY: "test-openai",
      OPENAI_BASE_URL: sim.url
    },
    encoding: "utf8",
    timeout: 120_000
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function mustRun(args: readonly string[]): string {
  const result = runCli(args);
  assert.equal(
    result.status,
    0,
    `fusionkit ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

before(async () => {
  if (SKIP !== false) return;
  sim = await startProviderSim();
  await sim.queue("provider-surface-a", ["catalog seed"]);
  await sim.queue("provider-surface-b", ["catalog seed"]);
  root = mkdtempSync(join(tmpdir(), "fusionkit-v4-cli-surfaces-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
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
  mkdirSync(join(repo, ".fusionkit"));
  mkdirSync(join(repo, ".routekit"));
  writeFileSync(
    join(repo, ".fusionkit", "fusion.json"),
    `${JSON.stringify(
      {
        version: "fusionkit.fusion.v4",
        router: { config: ".routekit/router.yaml" },
        tool: "codex",
        defaultEnsemble: "default",
        ensembles: {
          default: {
            members: [
              "openai/provider-surface-a",
              "openai/provider-surface-b"
            ],
            judge: "openai/provider-surface-a",
            k: 1
          },
          mini: {
            members: ["openai/provider-surface-a"],
            judge: "openai/provider-surface-a",
            k: 1
          }
        }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(repo, ".routekit", "router.yaml"),
    [
      "providers:",
      "  openai: {}",
      "defaultModel: openai/provider-surface-a",
      ""
    ].join("\n")
  );
});

after(async () => {
  if (SKIP !== false) return;
  await sim.close();
  rmSync(root, { recursive: true, force: true });
});

test("version, completion, and config surfaces execute through the real CLI", {
  skip: SKIP
}, () => {
  const version = JSON.parse(mustRun(["version", "--json"])) as {
    cli?: string;
  };
  assert.match(version.cli ?? "", /^\d+\.\d+\.\d+/);
  for (const shell of ["bash", "zsh", "fish"]) {
    assert.match(mustRun(["completion", shell]), /fusionkit/);
  }
  const shown = JSON.parse(
    mustRun(["config", "show", "--repo", repo, "--json"])
  ) as {
    router: { config: string };
    effective: { ensembles: { value: Array<{ members: string[] }> } };
  };
  assert.deepEqual(shown.router, { config: ".routekit/router.yaml" });
  assert.deepEqual(shown.effective.ensembles.value[0]?.members, [
    "openai/provider-surface-a",
    "openai/provider-surface-b"
  ]);
});

test("prompt, telemetry, and config mutation surfaces preserve JSON contracts", {
  skip: SKIP
}, () => {
  const promptDir = join(repo, ".fusionkit", "prompts");
  mkdirSync(promptDir, { recursive: true });
  const judgePath = join(promptDir, "judge.md");
  writeFileSync(judgePath, "JUDGE V4 OVERRIDE\n");
  const listed = JSON.parse(
    mustRun(["prompts", "list", "--repo", repo, "--json"])
  ) as { prompts: Array<{ id: string; active: boolean }> };
  assert.equal(
    listed.prompts.find((entry) => entry.id === "judge")?.active,
    true
  );
  mustRun(["prompts", "reset", "judge", "--repo", repo, "--json"]);
  assert.equal(existsSync(judgePath), false);

  mustRun(["config", "set", "budgetUsd", "2.5", "--repo", repo, "--json"]);
  assert.equal(
    mustRun(["config", "get", "budgetUsd", "--repo", repo]).trim(),
    "2.5"
  );
  mustRun(["config", "unset", "budgetUsd", "--repo", repo, "--json"]);

  assert.equal(
    (JSON.parse(mustRun(["telemetry", "status", "--json"])) as {
      enabled?: boolean;
    }).enabled,
    false
  );
});

test("setup and doctor validate the v4 Fusion/RouteKit composition", {
  skip: SKIP
}, () => {
  const setup = JSON.parse(
    mustRun([
      "setup",
      "--fusionkit-dir",
      repoRoot(),
      "--force",
      "--json"
    ])
  ) as {
    ok?: boolean;
    capabilities?: Array<{ label?: string; ok?: boolean }>;
  };
  assert.equal(setup.ok, true);
  assert.ok(
    setup.capabilities?.some(
      (capability) =>
        capability.label === "RouteKit-backed fusion" &&
        capability.ok === true
    )
  );

  const doctor = runCli(["doctor", "--json"]);
  const result = JSON.parse(doctor.stdout) as {
    ready?: boolean;
    checks?: Array<{ label?: string; ok?: boolean; required?: boolean }>;
  };
  const selected = result.checks?.find((check) => check.label === "codex");
  assert.equal(selected?.required, true);
  assert.equal(result.ready, selected?.ok);
  assert.equal(doctor.status, selected?.ok === true ? 0 : 1, `${doctor.stdout}\n${doctor.stderr}`);
  assert.ok(
    result.checks?.some(
      (check) => check.label === "embedded RouteKit config" && check.ok === true
    )
  );
  assert.deepEqual(
    result.checks
      ?.filter((check) => ["codex", "claude", "cursor", "opencode"].includes(check.label ?? ""))
      .map((check) => check.label),
    ["codex", "claude", "cursor", "opencode"]
  );
});

test("removed routing/account/install commands remain absent", {
  skip: SKIP
}, () => {
  for (const command of ["proxy", "accounts", "install", "uninstall"]) {
    const result = runCli([command]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown command/i);
  }
  assert.doesNotMatch(
    readFileSync(join(repo, ".fusionkit", "fusion.json"), "utf8"),
    /baseUrl|apiKey|subscription/
  );
});
