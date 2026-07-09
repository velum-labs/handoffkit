/**
 * The REAL product front door: `fusionkit serve` (this package's actual CLI
 * entrypoint) booting its production stack — config loading from
 * `.fusionkit/fusion.json`, provider-key preflight probes, the Python engine
 * spawned through the real dev override (`uv run --package fusionkit`), the
 * in-process gateway, and the printed setup snippets — with every provider
 * endpoint pointed at the scripted simulator. A fused turn is then driven
 * through the gateway the CLI itself booted.
 *
 * This is the orchestration path production users run (`fusion-quickstart` ->
 * `startFusionStack` -> `startRouter` -> `startFusionStepGateway`), not a
 * test-assembled stack.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { judgeAnalysis, repoRoot, stackToolingSkip, startProviderSim } from "@fusionkit/testkit";
import type { ProviderSimHandle } from "@fusionkit/testkit";

const SKIP = stackToolingSkip();

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

let sim: ProviderSimHandle;
let repo: string;
let cli: ChildProcess | undefined;
let cliOutput = "";
let gatewayUrl: string | undefined;

function makeConfiguredRepo(simUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-npm-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.email=e2e@fusionkit.local", "-c", "user.name=e2e", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir }
  );
  mkdirSync(join(dir, ".fusionkit"));
  writeFileSync(
    join(dir, ".fusionkit", "fusion.json"),
    JSON.stringify(
      {
        version: "fusionkit.fusion.v3",
        defaultEnsemble: "default",
        ensembles: {
          default: {
            // k=1 proposal mode keeps provider scripting deterministic; the
            // rollout path is covered by gateway-e2e's worktree suite.
            k: 1,
            panel: [
              { id: "alpha", model: "gpt-real-a", provider: "openai", baseUrl: simUrl, keyEnv: "SIM_KEY" },
              { id: "beta", model: "claude-real-b", provider: "anthropic", baseUrl: simUrl, keyEnv: "SIM_KEY" }
            ],
            judgeModel: "gpt-real-a"
          }
        }
      },
      null,
      2
    )
  );
  return dir;
}

before(async function () {
  if (SKIP !== false) return;
  sim = await startProviderSim();
  repo = makeConfiguredRepo(sim.url);
  cli = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      "serve",
      "--fusionkit-dir",
      repoRoot(),
      "--repo",
      repo,
      "--no-reasoning",
      "--no-observe",
      "--no-subagents",
      "--yes"
    ],
    {
      cwd: repo,
      // env-spread-allowed: the CLI under test is this repo's own product entrypoint
      env: { ...process.env, SIM_KEY: "sk-sim", PORTLESS: "0", FUSIONKIT_TELEMETRY: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  cli.stdout?.on("data", (chunk: Buffer) => (cliOutput += chunk.toString("utf8")));
  cli.stderr?.on("data", (chunk: Buffer) => (cliOutput += chunk.toString("utf8")));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && gatewayUrl === undefined) {
    if (cli.exitCode !== null) break;
    if (/gateway is running/i.test(cliOutput)) {
      // The Claude setup snippet names the gateway root unambiguously (the
      // first loopback URL in the output can be the router, not the gateway).
      gatewayUrl = cliOutput.match(/ANTHROPIC_BASE_URL=(http:\/\/[\d.]+:\d+)/)?.[1];
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
});

after(async () => {
  if (SKIP !== false) return;
  cli?.kill("SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  cli?.kill("SIGKILL");
  await sim.close();
  rmSync(repo, { recursive: true, force: true });
});

test("the real `fusionkit serve` CLI boots its production stack against the simulator", { skip: SKIP }, () => {
  assert.ok(gatewayUrl, `the CLI must print a running gateway URL:\n${cliOutput.slice(0, 3000)}`);
  // Preflight really probed the (simulated) providers and passed.
  assert.doesNotMatch(cliOutput, /preflight failed/i);
  // The product's own onboarding surface: per-tool setup snippets.
  assert.match(cliOutput, /Codex \(OpenAI Responses\)/);
  assert.match(cliOutput, /Claude Code \(Anthropic Messages\)/);
  assert.match(cliOutput, /fusion-panel/);
});

test("the CLI-booted gateway advertises the fused model", { skip: SKIP }, async () => {
  assert.ok(gatewayUrl);
  const models = (await (await fetch(`${gatewayUrl}/v1/models`)).json()) as {
    data: Array<{ id: string }>;
  };
  const ids = new Set(models.data.map((entry) => entry.id));
  assert.ok(ids.has("fusion-panel"));
  assert.ok(ids.has("gpt-real-a"), "panel members are advertised as passthroughs");
});

test("a fused turn flows through the CLI-booted stack end to end", { skip: SKIP }, async () => {
  assert.ok(gatewayUrl);
  await sim.reset();
  // Deterministic same-queue order for gpt-real-a: panel member call first,
  // then the judge's analysis + synthesis calls of the fuse step.
  await sim.queue("gpt-real-a", [
    "candidate from the openai member",
    { reply: judgeAnalysis() },
    { reply: "FUSION_NPM_CLI_OK: fused by the real product CLI" }
  ]);
  await sim.queue("claude-real-b", ["candidate from the anthropic member"]);

  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fusion-panel",
      messages: [{ role: "user", content: "what does the real CLI produce?" }]
    })
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
  assert.match(body.choices[0]?.message.content ?? "", /FUSION_NPM_CLI_OK/);

  // The CLI's own router (spawned via `uv run` from the checkout) called both
  // providers on their real dialects.
  const journal = await sim.journal();
  const dialects = new Map(journal.map((entry) => [entry.model, entry.dialect]));
  assert.equal(dialects.get("gpt-real-a"), "openai-chat", await sim.describeJournal());
  assert.equal(dialects.get("claude-real-b"), "anthropic-messages");
  const memberCall = journal.find((entry) => entry.model === "claude-panel-b" || entry.model === "claude-real-b");
  assert.ok(
    JSON.stringify(memberCall?.request).includes("what does the real CLI produce?"),
    "the caller's prompt must reach the panel wire through the CLI-booted stack"
  );
});
