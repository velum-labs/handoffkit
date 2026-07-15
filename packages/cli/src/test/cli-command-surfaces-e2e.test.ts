/**
 * Real-process coverage for the non-serving `fusionkit` CLI surfaces. These
 * invoke the actual built entrypoint against isolated repo/HOME/CODEX_HOME
 * fixtures — no injected Commander program or mocked command handlers.
 *
 * Covered: version, completions, config path/show/get/set/unset/export-yaml,
 * prompts list/reset, codex install/uninstall, telemetry
 * status/on/inspect/off, setup provisioning via the local uv workspace, and
 * doctor's machine-readable preflight against the provider simulator.
 */

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

import { repoRoot, stackToolingSkip, startProviderSim } from "@fusionkit/testkit";
import type { ProviderSimHandle } from "@fusionkit/testkit";

const SKIP = stackToolingSkip();
const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

let root: string;
let repo: string;
let home: string;
let sim: ProviderSimHandle;

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: repo,
    // env-spread-allowed: the product CLI needs normal PATH/HOME; all mutable homes and credentials are isolated below
    env: {
      ...process.env,
      HOME: home,
      PORTLESS: "0",
      NO_COLOR: "1",
      FUSIONKIT_TELEMETRY: undefined,
      ...extraEnv
    },
    encoding: "utf8",
    timeout: 120_000
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function mustRun(args: readonly string[], env: NodeJS.ProcessEnv = {}): string {
  const result = runCli(args, env);
  assert.equal(
    result.status,
    0,
    `fusionkit ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout;
}

before(async function () {
  if (SKIP !== false) return;
  sim = await startProviderSim();
  root = mkdtempSync(join(tmpdir(), "fusionkit-cli-surfaces-"));
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
  writeFileSync(
    join(repo, ".fusionkit", "fusion.json"),
    JSON.stringify(
      {
        version: "fusionkit.fusion.v3",
        tool: "codex",
        defaultEnsemble: "default",
        ensembles: {
          default: {
            k: 1,
            panel: [
              {
                id: "alpha",
                model: "surface-openai",
                provider: "openai",
                baseUrl: sim.url,
                keyEnv: "SIM_KEY"
              },
              {
                id: "beta",
                model: "surface-anthropic",
                provider: "anthropic",
                baseUrl: sim.url,
                keyEnv: "SIM_KEY"
              }
            ],
            judgeModel: "surface-openai"
          },
          mini: {
            k: 1,
            panel: [
              {
                id: "alpha",
                model: "surface-openai",
                provider: "openai",
                baseUrl: sim.url,
                keyEnv: "SIM_KEY"
              }
            ],
            judgeModel: "surface-openai"
          }
        }
      },
      null,
      2
    )
  );
});

after(async () => {
  if (SKIP !== false) return;
  await sim.close();
  rmSync(root, { recursive: true, force: true });
});

test("version and completion surfaces execute through the real CLI", { skip: SKIP }, () => {
  const version = JSON.parse(mustRun(["version", "--json"])) as {
    cli?: string;
  };
  assert.match(version.cli ?? "", /^\d+\.\d+\.\d+/);

  for (const shell of ["bash", "zsh", "fish"]) {
    const completion = mustRun(["completion", shell]);
    assert.ok(completion.length > 100, `${shell} completion must be substantive`);
    assert.match(completion, /fusionkit/);
  }
});

test("config path/show/get/set/unset/export-yaml round-trip the stored source of truth", { skip: SKIP }, () => {
  const configPath = join(repo, ".fusionkit", "fusion.json");
  assert.equal(mustRun(["config", "path", "--repo", repo]).trim(), configPath);

  const shown = JSON.parse(mustRun(["config", "show", "--repo", repo, "--json"])) as {
    source?: string;
    effective?: { defaultEnsemble?: { value?: string; source?: string } };
  };
  assert.equal(shown.source, configPath);
  assert.equal(shown.effective?.defaultEnsemble?.value, "default");
  assert.equal(shown.effective?.defaultEnsemble?.source, "config");

  mustRun(["config", "set", "budgetUsd", "2.5", "--repo", repo, "--json"]);
  assert.equal(mustRun(["config", "get", "budgetUsd", "--repo", repo]).trim(), "2.5");
  const stored = JSON.parse(readFileSync(configPath, "utf8")) as { budgetUsd?: number };
  assert.equal(stored.budgetUsd, 2.5);

  mustRun(["config", "unset", "budgetUsd", "--repo", repo, "--json"]);
  const missing = runCli(["config", "get", "budgetUsd", "--repo", repo]);
  assert.equal(missing.status, 1, "get exits 1 for an unset path");

  const yaml = mustRun(["config", "export-yaml", "--repo", repo]);
  assert.match(yaml, /default_model: alpha/);
  assert.match(yaml, /provider: openai/);
  assert.match(yaml, /provider: anthropic/);
});

test("prompt list/reset operates on real committed override files", { skip: SKIP }, () => {
  const promptDir = join(repo, ".fusionkit", "prompts");
  mkdirSync(promptDir, { recursive: true });
  const judgePath = join(promptDir, "judge.md");
  writeFileSync(judgePath, "JUDGE SURFACE OVERRIDE\n");

  const listed = mustRun(["prompts", "list", "--repo", repo, "--json"]);
  assert.match(listed, /JUDGE SURFACE OVERRIDE|judge\.md|configured/);

  mustRun(["prompts", "reset", "judge", "--repo", repo, "--json"]);
  assert.equal(existsSync(judgePath), false);
});

test("install/uninstall codex writes valid managed config and preserves user content", { skip: SKIP }, () => {
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, 'model = "user-model"\n');

  mustRun([
    "install",
    "codex",
    "--gateway-url",
    "http://127.0.0.1:4114",
    "--repo",
    repo,
    "--codex-home",
    codexHome
  ]);
  const installed = readFileSync(configPath, "utf8");
  assert.match(installed, /model = "user-model"/);
  assert.match(installed, /\[model_providers\.fusionkit\]/);
  assert.match(installed, /http:\/\/127\.0\.0\.1:4114\/v1/);
  assert.match(installed, /fusion-panel/);
  assert.match(installed, /fusion-mini/);

  mustRun(["uninstall", "codex", "--codex-home", codexHome]);
  const uninstalled = readFileSync(configPath, "utf8");
  assert.match(uninstalled, /model = "user-model"/);
  assert.doesNotMatch(uninstalled, /model_providers\.fusionkit/);
});

test("telemetry status/on/inspect/off is isolated to the temporary HOME", { skip: SKIP }, () => {
  const initial = JSON.parse(mustRun(["telemetry", "status", "--json"])) as {
    enabled?: boolean;
  };
  assert.equal(initial.enabled, false);

  const enabled = JSON.parse(mustRun(["telemetry", "on", "--json"])) as {
    enabled?: boolean;
    installId?: string;
  };
  assert.equal(enabled.enabled, true);
  assert.match(enabled.installId ?? "", /^[a-f0-9-]{16,}$/i);

  const inspection = JSON.parse(mustRun(["telemetry", "inspect", "--json"])) as {
    pending?: unknown[];
  };
  assert.deepEqual(inspection.pending, [], "inspect sends nothing and reports the pending queue");

  const disabled = JSON.parse(mustRun(["telemetry", "off", "--json"])) as {
    enabled?: boolean;
  };
  assert.equal(disabled.enabled, false);
});

test("setup provisions the local Python engine and doctor probes the real simulator endpoints", { skip: SKIP }, () => {
  const setup = JSON.parse(
    mustRun([
      "setup",
      "--fusionkit-dir",
      repoRoot(),
      "--force",
      "--json"
    ])
  ) as { ok?: boolean; capabilities?: Array<{ label?: string; ok?: boolean }> };
  assert.equal(setup.ok, true);
  assert.ok(setup.capabilities?.some((capability) => capability.label === "cloud ensembles"));

  const doctorResult = runCli(["doctor", "--json"], { SIM_KEY: "sk-doctor" });
  assert.equal(
    doctorResult.status,
    0,
    `doctor failed\nstdout:\n${doctorResult.stdout}\nstderr:\n${doctorResult.stderr}`
  );
  const doctor = JSON.parse(doctorResult.stdout) as {
    ready?: boolean;
    checks?: Array<{ ok?: boolean }>;
  };
  assert.equal(doctor.ready, true);
  assert.ok((doctor.checks?.length ?? 0) > 0);
  assert.ok(
    doctor.checks?.some((check) => check.ok === true),
    "doctor must report concrete passing checks, not only a top-level flag"
  );
});
