import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
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

import { MODEL_FUSION_SCHEMA_BUNDLE_HASH } from "@fusionkit/protocol";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));
const SMOKE_ENV_KEYS = [
  "FUSIONKIT_CLAUDE_SMOKE",
  "FUSIONKIT_CODEX_SMOKE",
  "FUSIONKIT_CURSOR_SMOKE",
  "FUSIONKIT_ENSEMBLE_LIVE_SMOKE"
] as const;
const PROVIDER_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"] as const;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startFusionBackend(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse((await readBody(req)).toString("utf8")) as { model?: string };
      if (req.url === "/v1/fusion/trajectories:fuse") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `CLI_FUSION:${body.model}` } }],
            fusion: {
              trajectory: {
                trajectory_id: "synthesis_cli",
                synthesis: { decision: "synthesize", rationale: "fused" }
              }
            }
          })
        );
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `CLI_FUSION:${body.model}` } }]
          })
        );
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

async function startSentinelBackend(
  sentinel: string
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      await readBody(req);
      if (req.url === "/v1/fusion/trajectories:fuse") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `${sentinel} fusion synthesis` } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            fusion: {
              trajectory: {
                trajectory_id: "synthesis_sentinel",
                synthesis: { decision: "synthesize", rationale: "fused" }
              }
            }
          })
        );
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: `${sentinel} fusion synthesis` } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

function fusionkit(
  args: string[],
  options: { input?: string; env?: Record<string, string | undefined>; cwd?: string } = {}
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  for (const key of SMOKE_ENV_KEYS) delete env[key];
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env,
    input: options.input,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {})
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function fusionkitAsync(
  args: string[],
  options: { input?: string; env?: Record<string, string | undefined>; cwd?: string } = {}
): Promise<{ status: number; stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of SMOKE_ENV_KEYS) delete env[key];
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function fakeDoctorPath(options: { engineCached?: boolean; fusionkitShim?: boolean } = {}): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-doctor-path-"));
  const engineExit = options.engineCached === false ? "exit 1" : "exit 0";
  for (const bin of ["uv", "uvx"]) {
    writeFileSync(join(dir, bin), `#!/bin/sh\n${engineExit}\n`, { mode: 0o755 });
  }
  if (options.fusionkitShim === true) {
    writeFileSync(join(dir, "fusionkit"), "#!/bin/sh\necho 'python fusionkit shim'\n", { mode: 0o755 });
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function doctorEnv(pathDir: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...extra,
    NO_COLOR: "1",
    FUSIONKIT_NO_TUI: "1",
    // Hermetic: never scan the host's real MLX home — a dev machine with
    // downloaded models would otherwise flip doctor's readiness verdict.
    FUSIONKIT_MLX_HOME: join(pathDir, "mlx-home"),
    PATH: `${pathDir}${process.env.PATH !== undefined ? `:${process.env.PATH}` : ""}`
  };
}

function commandLineIndex(help: string, command: string): number {
  const match = new RegExp(`^  ${command}\\b`, "m").exec(help);
  assert.ok(match, `expected ${command} in help`);
  return match.index;
}

function assertCommandOrder(help: string, commands: readonly string[]): void {
  let previous = -1;
  for (const command of commands) {
    const current = commandLineIndex(help, command);
    assert.ok(current > previous, `expected ${command} after prior command`);
    previous = current;
  }
}

test("help prints usage and lists the top-level commands", () => {
  const result = fusionkit(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /real model fusion behind your coding agent/);
  for (const command of ["codex", "claude", "cursor", "serve", "opencode", "fusion", "init", "ensemble"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(result.stdout, /^  local\b/m);
  assertCommandOrder(result.stdout, [
    "codex",
    "claude",
    "cursor",
    "serve",
    "opencode",
    "fusion",
    "init",
    "setup",
    "doctor",
    "status",
    "config",
    "prompts",
    "sessions",
    "models",
    "ensemble",
    "completion",
    "runtime",
    "version"
  ]);
  assert.match(result.stdout, /Quickstart:/);
  assert.match(result.stdout, /fusionkit setup/);
  assert.match(result.stdout, /Environment variables:/);
  assert.match(result.stdout, /FUSIONKIT_SKIP_KEY_VALIDATION/);
  assert.match(result.stdout, /FUSIONKIT_\*/);
});

test("ensemble help lists its subcommands", () => {
  const result = fusionkit(["ensemble", "--help"]);
  assert.equal(result.status, 0);
  for (const sub of ["run", "handoff", "dashboard", "e2e", "gateway"]) {
    assert.match(result.stdout, new RegExp(`\\b${sub}\\b`));
  }
});

test("ensemble dashboard help documents the live-smoke flag", () => {
  const result = fusionkit(["ensemble", "dashboard", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--live-smoke/);
});

test("gateway help lists the front-door subcommands", () => {
  const result = fusionkit(["ensemble", "gateway", "--help"]);
  assert.equal(result.status, 0);
  for (const sub of ["serve", "acp", "acp-registry", "test", "codex-config"]) {
    assert.match(result.stdout, new RegExp(`\\b${sub}\\b`));
  }
});

test("completion bash includes top-level commands from the Commander tree", () => {
  const result = fusionkit(["completion", "bash"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /complete -F _fusionkit_completion fusionkit/);
  assert.match(result.stdout, /fusionkit __complete/);
  for (const command of ["codex", "claude", "cursor", "serve", "opencode", "fusion", "doctor", "ensemble"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("__complete lists top-level commands for an empty word and hides internals", () => {
  const result = fusionkit(["__complete", "--", ""]);
  assert.equal(result.status, 0, result.stderr);
  const candidates = result.stdout.split("\n").filter((line) => line !== "");
  for (const command of ["codex", "claude", "config", "sessions", "doctor"]) {
    assert.ok(candidates.includes(command), `expected ${command} in ${candidates.join(",")}`);
  }
  assert.ok(!candidates.includes("__complete"));
  assert.ok(!candidates.includes("help"));
});

test("__complete filters by the typed prefix", () => {
  const result = fusionkit(["__complete", "--", "se"]);
  assert.equal(result.status, 0, result.stderr);
  const candidates = result.stdout.split("\n").filter((line) => line !== "");
  assert.deepEqual(candidates, ["serve", "sessions", "setup"]);
});

test("__complete descends into subcommands and dynamic argument values", () => {
  const config = fusionkit(["__complete", "--", "config", ""]);
  assert.equal(config.status, 0, config.stderr);
  for (const sub of ["get", "set", "unset", "path"]) {
    assert.ok(config.stdout.split("\n").includes(sub), `expected ${sub} in config completions`);
  }

  const prompts = fusionkit(["__complete", "--", "prompts", "edit", ""]);
  assert.equal(prompts.status, 0, prompts.stderr);
  const promptIds = prompts.stdout.split("\n").filter((line) => line !== "");
  assert.ok(promptIds.includes("judge"));
  assert.ok(promptIds.includes("synthesizer"));

  const shells = fusionkit(["__complete", "--", "completion", ""]);
  assert.equal(shells.status, 0, shells.stderr);
  assert.deepEqual(
    shells.stdout.split("\n").filter((line) => line !== ""),
    ["bash", "fish", "zsh"]
  );
});

test("__complete offers long flags when the current word starts with a dash", () => {
  const result = fusionkit(["__complete", "--", "doctor", "--"]);
  assert.equal(result.status, 0, result.stderr);
  const flags = result.stdout.split("\n").filter((line) => line !== "");
  assert.ok(flags.includes("--json"), `expected --json in ${flags.join(",")}`);
  assert.ok(flags.every((flag) => flag.startsWith("--")));
});

test("doctor exits nonzero when no provider credentials and no local path are available", () => {
  const fixture = makeRepo();
  const fakePath = fakeDoctorPath({ engineCached: false });
  try {
    const result = fusionkit(["doctor"], {
      cwd: fixture.repo,
      env: doctorEnv(fakePath.dir)
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /almost ready/);
    assert.match(result.stderr, /OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY/);
    assert.match(result.stderr, /fusionkit setup/);
  } finally {
    fakePath.cleanup();
    fixture.cleanup();
  }
});

test("doctor exits zero with partial default credentials and names skipped members", () => {
  const fixture = makeRepo();
  const fakePath = fakeDoctorPath({ engineCached: false });
  try {
    const result = fusionkit(["doctor"], {
      cwd: fixture.repo,
      env: doctorEnv(fakePath.dir, { OPENAI_API_KEY: "sk-test" })
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ready with a partial cloud panel/);
    assert.match(result.stderr, /sonnet \(ANTHROPIC_API_KEY\)/);
    assert.match(result.stderr, /gemini \(GEMINI_API_KEY\)/);
    assert.match(result.stderr, /fusionkit setup/);
  } finally {
    fakePath.cleanup();
    fixture.cleanup();
  }
});

test("doctor --json includes a stable ready boolean", () => {
  const fixture = makeRepo();
  const fakePath = fakeDoctorPath();
  try {
    const result = fusionkit(["doctor", "--json"], {
      cwd: fixture.repo,
      env: doctorEnv(fakePath.dir, {
        OPENAI_API_KEY: "sk-test",
        ANTHROPIC_API_KEY: "sk-test",
        GEMINI_API_KEY: "sk-test"
      })
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ready?: boolean;
      credentials?: { defaultPanel?: { missing?: string[] } };
    };
    assert.equal(payload.ready, true);
    assert.deepEqual(payload.credentials?.defaultPanel?.missing, []);
  } finally {
    fakePath.cleanup();
    fixture.cleanup();
  }
});

test("doctor accepts key envs from the repo fusion config", () => {
  const fixture = makeRepo();
  const fakePath = fakeDoctorPath();
  try {
    mkdirSync(join(fixture.repo, ".fusionkit"));
    writeFileSync(
      join(fixture.repo, ".fusionkit", "fusion.json"),
      JSON.stringify(
        {
          version: "fusionkit.fusion.v3",
          ensembles: {
            default: {
              panel: [{ id: "custom", model: "vendor/custom-model", provider: "openrouter", keyEnv: "CUSTOM_PANEL_KEY" }]
            }
          }
        },
        null,
        2
      )
    );
    const result = fusionkit(["doctor", "--json"], {
      cwd: fixture.repo,
      env: doctorEnv(fakePath.dir, { CUSTOM_PANEL_KEY: "sk-test" })
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ready?: boolean;
      credentials?: { acceptedKeyEnvs?: string[] };
    };
    assert.equal(payload.ready, true);
    assert.ok(payload.credentials?.acceptedKeyEnvs?.includes("CUSTOM_PANEL_KEY"));
  } finally {
    fakePath.cleanup();
    fixture.cleanup();
  }
});

test("doctor warns when another fusionkit binary is first on PATH", () => {
  const fixture = makeRepo();
  const fakePath = fakeDoctorPath({ fusionkitShim: true });
  try {
    const result = fusionkit(["doctor", "--json"], {
      cwd: fixture.repo,
      env: doctorEnv(fakePath.dir, { OPENAI_API_KEY: "sk-test" })
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      checks: Array<{ section: string; label: string; ok: boolean; detail?: string }>;
    };
    const binary = payload.checks.find((check) => check.section === "binaries" && check.label === "fusionkit on PATH");
    assert.equal(binary?.ok, false);
    assert.match(binary?.detail ?? "", /resolves before this npm CLI/);
  } finally {
    fakePath.cleanup();
    fixture.cleanup();
  }
});

test("gateway acp-registry rejects an unknown action", () => {
  const result = fusionkit(["ensemble", "gateway", "acp-registry", "bogus"]);
  assert.notEqual(result.status, 0);
});

test("the removed local subcommand is rejected", () => {
  const result = fusionkit(["local"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command ['"]local['"]/);
});

test("direct mode rejects the contradictory local-panel flag", () => {
  const result = fusionkit(["codex", "--direct", "--local"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--direct cannot be combined with --local or --no-local/);
});

test("direct-only tools require the direct flag", () => {
  const result = fusionkit(["opencode"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /opencode only supports direct mode/);
});

test("public URL is scoped to direct mode", () => {
  const result = fusionkit(["codex", "--public-url", "https://example.test"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--public-url requires --direct/);
});

test("fusion help documents the flags-before-tool contract", () => {
  const result = fusionkit(["fusion", "--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /must precede the tool name/);
  assert.match(result.stdout, /--direct\s+back the tool with one local model directly/);
  assert.match(result.stdout, /run the panel on local MLX models \(Apple Silicon\s+only\) instead of cloud providers/);
});

test("init help does not expose removed governance plane flags", () => {
  const result = fusionkit(["init", "--help"]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /--dir\b/);
  assert.doesNotMatch(result.stdout, /--host\b/);
  assert.doesNotMatch(result.stdout, /--plane-url\b/);
});

test("init scaffolds a .fusionkit/fusion.json and refuses to clobber without --force", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit(["init", "--repo", fixture.repo]);
    assert.equal(result.status, 0, result.stderr);
    const configPath = join(fixture.repo, ".fusionkit", "fusion.json");
    assert.ok(existsSync(configPath));
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { version: string };
    assert.equal(config.version, "fusionkit.fusion.v3");

    const again = fusionkit(["init", "--repo", fixture.repo]);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);

    const forced = fusionkit(["init", "--repo", fixture.repo, "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
  } finally {
    fixture.cleanup();
  }
});

type InitConfig = {
  ensembles?: Record<string, { panel?: Array<{ id: string }>; judgeModel?: string }>;
  defaultEnsemble?: string;
};

function initScripted(
  repo: string,
  input: string
): { status: number; stdout: string; stderr: string; config: InitConfig } {
  const result = fusionkit(["init", "--repo", repo], {
    input,
    // Skip the telemetry step (and never touch the real consent file) so the
    // scripted answers line up with the remaining prompts deterministically.
    env: { DO_NOT_TRACK: "1" }
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(
    readFileSync(join(repo, ".fusionkit", "fusion.json"), "utf8")
  ) as InitConfig;
  return { ...result, config };
}

test("init keeps the first ensemble named default on empty input", () => {
  const fixture = makeRepo();
  try {
    // Answers: tool, judge, ensemble name (default), observe, add-ensemble.
    const { config, stderr } = initScripted(fixture.repo, "\n\n\n\n\n");
    assert.match(stderr, /Ensemble name/);
    assert.match(stderr, /keeps the canonical/);
    assert.deepEqual(Object.keys(config.ensembles ?? {}), ["default"]);
    assert.equal(config.defaultEnsemble, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("init lets the user name the first ensemble and records it as the session default", () => {
  const fixture = makeRepo();
  try {
    // Answers: tool, judge, ensemble name ("fast"), observe, add-ensemble.
    const { config } = initScripted(fixture.repo, "\n\nfast\n\n\n");
    assert.deepEqual(Object.keys(config.ensembles ?? {}), ["fast"]);
    assert.equal(config.defaultEnsemble, "fast");
    assert.ok((config.ensembles?.fast?.panel?.length ?? 0) > 0);
    assert.equal(config.ensembles?.fast?.judgeModel, "gpt-5.5");
  } finally {
    fixture.cleanup();
  }
});

test("init re-prompts on reserved or invalid first-ensemble names", () => {
  const fixture = makeRepo();
  try {
    // Answers: tool, judge, name ("panel" is reserved, "My_Bad" is invalid,
    // exhausted input falls back to "default"), observe, add-ensemble.
    const { config, stderr } = initScripted(fixture.repo, "\n\npanel\nMy_Bad\n\n\n");
    assert.match(stderr, /"panel" is reserved/);
    assert.match(stderr, /"My_Bad" must match/);
    assert.deepEqual(Object.keys(config.ensembles ?? {}), ["default"]);
    assert.equal(config.defaultEnsemble, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("init creates additional named ensembles with the same naming semantics", () => {
  const fixture = makeRepo();
  try {
    // Answers: tool, judge, first name ("main"), observe, add-ensemble (yes),
    // extra name ("main" is taken, then "deep"), extra judge, add-another (no).
    const { config, stderr } = initScripted(fixture.repo, "\n\nmain\n\ny\nmain\ny\ndeep\n\n\n");
    assert.match(stderr, /"main" is taken/);
    assert.deepEqual(Object.keys(config.ensembles ?? {}).sort(), ["deep", "main"]);
    assert.equal(config.defaultEnsemble, "main");
    assert.ok((config.ensembles?.deep?.panel?.length ?? 0) > 0);
    assert.equal(config.ensembles?.deep?.judgeModel, "gpt-5.5");
  } finally {
    fixture.cleanup();
  }
});

test("unknown commands fail with guidance", () => {
  const unknown = fusionkit(["frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command/);
});

function makeRepo(): { repo: string; cleanup: () => void; output: string } {
  const root = mkdtempSync(join(tmpdir(), "fusionkit-ensemble-cli-"));
  const repo = join(root, "repo");
  const output = join(root, "out");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "cli@fusionkit.local"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "fusionkit-cli"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# cli ensemble\n");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repo });
  return { repo, output, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeCodingRepo(): { repo: string; cleanup: () => void; output: string } {
  const fixture = makeRepo();
  writeFileSync(
    join(fixture.repo, "calculator.js"),
    "exports.add = (left, right) => left - right;\n"
  );
  writeFileSync(
    join(fixture.repo, "calculator.test.js"),
    [
      "const assert = require('node:assert/strict');",
      "const { add } = require('./calculator.js');",
      "assert.equal(add(2, 3), 5);",
      "console.log('TEST_OK');",
      ""
    ].join("\n")
  );
  writeFileSync(
    join(fixture.repo, "fix-and-test.js"),
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync('calculator.js', 'exports.add = (left, right) => left + right;\\n');",
      "require('./calculator.test.js');",
      "console.log('PATCH_TEST_OK');",
      ""
    ].join("\n")
  );
  spawnSync("git", ["add", "-A"], { cwd: fixture.repo });
  spawnSync("git", ["commit", "--quiet", "-m", "add failing coding fixture"], { cwd: fixture.repo });
  return fixture;
}

function addFusionCommandProbe(repo: string): void {
  writeFileSync(
    join(repo, "fusion-probe.js"),
    [
      "const fs = require('node:fs');",
      "(async () => {",
      "  const response = await fetch(process.env.FUSIONKIT_CHAT_COMPLETIONS_URL, {",
      "    method: 'POST',",
      "    headers: { 'content-type': 'application/json' },",
      "    body: JSON.stringify({",
      "      model: process.env.FUSIONKIT_MODEL,",
      "      messages: [{ role: 'user', content: 'probe' }]",
      "    })",
      "  });",
      "  const body = await response.json();",
      "  fs.writeFileSync('fusion-result.txt', body.choices[0].message.content);",
      "  console.log('FUSION_PROBE_OK');",
      "})().catch((error) => { console.error(error); process.exit(1); });",
      ""
    ].join("\n")
  );
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "--quiet", "-m", "add fusion probe"], { cwd: repo });
}

test("ensemble mock smoke writes records and concise summary", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit([
      "ensemble",
      "run",
      "--harness",
      "mock",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_mock",
      "this prompt should not be printed in full"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ensemble cli_mock \[succeeded\]/);
    assert.match(result.stderr, /candidates: 2/);
    assert.ok(!result.stderr.includes("this prompt should not be printed in full"));
    assert.ok(existsSync(join(fixture.output, "summary.json")));
    assert.ok(existsSync(join(fixture.output, "harness-run-request.json")));
    assert.ok(existsSync(join(fixture.output, "harness-run-result.json")));
    assert.ok(existsSync(join(fixture.output, "candidates", "cli_mock_fast_0.json")));
    const summary = JSON.parse(readFileSync(join(fixture.output, "summary.json"), "utf8")) as {
      candidates: unknown[];
      finalPatchPath: string | null;
    };
    assert.equal(summary.candidates.length, 2);
    assert.equal(typeof summary.finalPatchPath === "string" || summary.finalPatchPath === null, true);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble command smoke records command output", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit([
      "ensemble",
      "run",
      "--harness",
      "command",
      "--command",
      "printf command-ok",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_command",
      "command prompt"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ensemble cli_command \[succeeded\]/);
    const summary = readFileSync(join(fixture.output, "summary.json"), "utf8");
    assert.ok(summary.includes("cli_command_command_0"));
    const candidate = readFileSync(
      join(fixture.output, "candidates", "cli_command_command_0.json"),
      "utf8"
    );
    assert.ok(candidate.includes("succeeded"));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble command failure exits nonzero but writes summary", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit([
      "ensemble",
      "run",
      "--harness",
      "command",
      "--command",
      "exit 7",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_fail",
      "command prompt"
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ensemble cli_fail \[failed\]/);
    assert.ok(existsSync(join(fixture.output, "summary.json")));
  } finally {
    fixture.cleanup();
  }
});


function benchmarkTask(taskId: string, prompt: string) {
  const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  return {
    schema: "benchmark-task-record.v1",
    schema_version: "v1",
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: "fusionkit-evals",
    producer_version: "0.1.0",
    producer_git_sha: "a".repeat(40),
    created_at: "2026-01-01T00:00:00.000Z",
    task_id: taskId,
    task_kind: "harness_coding",
    source_repo: "fusionkit",
    source_sha: "b".repeat(40),
    prompt,
    prompt_hash: hash(prompt),
    setup_hash: hash(`${taskId}:setup`),
    expected_evidence: ["harness records join"],
    scorer: { kind: "record_join" },
    holdout: false,
    contamination_notes: "synthetic cli handoff test",
    allowed_tools: ["read_file"]
  };
}

test("ensemble handoff rejects positional prompts", () => {
  const payload = {
    category: "coding",
    manifest_path: "/tmp/handoff-positional-task.json",
    task: benchmarkTask("handoff_positional", "should come from stdin")
  };
  const result = fusionkit(["ensemble", "handoff", "unexpected prompt"], {
    input: JSON.stringify(payload)
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not accept positional arguments/);
  assert.equal(result.stdout, "");
});

test("ensemble handoff emits FusionKit-compatible contract records on stdout", () => {
  const fixture = makeRepo();
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-cli-task.json",
      task: benchmarkTask("handoff_cli_task", "summarize the repo for handoff")
    };
    const result = fusionkit(
      [
        "ensemble",
        "handoff",
        "--harness",
        "mock",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_handoff"
      ],
      { input: JSON.stringify(payload) }
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as { records: Array<{ schema: string }> };
    const schemas = parsed.records.map((record) => record.schema);
    assert.deepEqual(schemas.slice(0, 3), [
      "benchmark-task-record.v1",
      "harness-run-request.v1",
      "harness-run-result.v1"
    ]);
    assert.ok(schemas.includes("harness-candidate-record.v1"));
    assert.ok(schemas.includes("judge-synthesis-record.v1"));
    assert.ok(existsSync(join(fixture.output, "harness-run-result.json")));
    assert.ok(!result.stdout.includes("ensemble cli_handoff"));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble handoff exits zero with failed command harness records for FusionKit ingestion", () => {
  const fixture = makeRepo();
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-command-fail-task.json",
      task: benchmarkTask("handoff_command_fail", "run a failing command harness")
    };
    const result = fusionkit(
      [
        "ensemble",
        "handoff",
        "--harness",
        "command",
        "--command",
        "exit 7",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_command_fail"
      ],
      { input: JSON.stringify(payload) }
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      records: Array<{ schema: string; status?: string; harness_kind?: string }>;
    };
    const runResult = parsed.records.find(
      (record) => record.schema === "harness-run-result.v1"
    );
    assert.equal(runResult?.status, "failed");
    assert.equal(runResult?.harness_kind, "generic");
    assert.ok(parsed.records.some((record) => record.schema === "harness-candidate-record.v1"));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble handoff command harness records real patch and test evidence", () => {
  const fixture = makeCodingRepo();
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-command-patch-task.json",
      task: {
        ...benchmarkTask(
          "handoff_command_patch",
          "Fix calculator.js so calculator.test.js passes, then run the test."
        ),
        allowed_tools: ["read_file", "write_file", "run_tests"]
      }
    };
    const result = fusionkit(
      [
        "ensemble",
        "handoff",
        "--harness",
        "command",
        "--command",
        "node fix-and-test.js",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_command_patch"
      ],
      { input: JSON.stringify(payload) }
    );

    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      records: Array<{
        schema: string;
        status?: string;
        artifacts?: Array<{ kind?: string; uri?: string }>;
      }>;
    };
    const runResult = parsed.records.find(
      (record) => record.schema === "harness-run-result.v1"
    );
    const candidate = parsed.records.find(
      (record) => record.schema === "harness-candidate-record.v1"
    );
    const toolExecution = parsed.records.find(
      (record) => record.schema === "tool-execution-record.v1"
    );
    assert.equal(runResult?.status, "succeeded");
    assert.equal(candidate?.status, "succeeded");
    assert.equal(toolExecution?.status, "succeeded");

    const patch = candidate?.artifacts?.find((artifact) => artifact.kind === "patch");
    const transcript = candidate?.artifacts?.find((artifact) => artifact.kind === "transcript");
    assert.ok(patch?.uri, "candidate must include a patch artifact");
    assert.ok(transcript?.uri, "candidate must include a transcript artifact");
    assert.match(
      readFileSync(fileURLToPath(transcript.uri), "utf8"),
      /PATCH_TEST_OK/
    );
  } finally {
    fixture.cleanup();
  }
});

test("ensemble handoff returns structured skip records when codex credentials are absent", () => {
  const fixture = makeRepo();
  const emptyCodexHome = mkdtempSync(join(tmpdir(), "fusionkit-codex-empty-home-"));
  try {
    const payload = {
      category: "coding",
      manifest_path: "/tmp/handoff-codex-task.json",
      task: benchmarkTask("handoff_codex_skip", "try the codex coding harness")
    };
    const result = fusionkit(
      [
        "ensemble",
        "handoff",
        "--harness",
        "codex",
        "--repo",
        fixture.repo,
        "--out",
        fixture.output,
        "--id",
        "cli_codex_skip"
      ],
      {
        input: JSON.stringify(payload),
        env: {
          CODEX_API_KEY: "",
          OPENAI_API_KEY: "",
          CODEX_HOME: emptyCodexHome,
          FUSIONKIT_CODEX_RESPONSES_BASE_URL: "",
          CODEX_RESPONSES_BASE_URL: "",
          FUSIONKIT_CODEX_OPENAI_BASE_URL: "",
          OPENAI_BASE_URL: ""
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as {
      records: Array<{ schema: string; status?: string; harness_kind?: string; errors?: unknown[] }>;
    };
    const runResult = parsed.records.find(
      (record) => record.schema === "harness-run-result.v1"
    );
    assert.equal(runResult?.status, "skipped");
    assert.equal(runResult?.harness_kind, "codex");
    assert.ok(JSON.stringify(runResult?.errors).includes("Codex credentials are absent"));
  } finally {
    fixture.cleanup();
    rmSync(emptyCodexHome, { recursive: true, force: true });
  }
});

test("ensemble dashboard writes markdown and run-result records", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit([
      "ensemble",
      "dashboard",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--timeout-ms",
      "1000"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /harness dashboard/);
    assert.match(result.stderr, /records: 6/);
    assert.ok(existsSync(join(fixture.output, "dashboard.md")));
    assert.ok(existsSync(join(fixture.output, "harness-run-results", "mock-success.json")));
    assert.ok(existsSync(join(fixture.output, "harness-run-results", "cursor-skipped.json")));
    const dashboard = readFileSync(join(fixture.output, "dashboard.md"), "utf8");
    assert.match(dashboard, /Capability Matrix/);
    assert.match(dashboard, /command-failure/);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble dashboard live-smoke flag remains env-gated by default", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit([
      "ensemble",
      "dashboard",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--timeout-ms",
      "1000",
      "--live-smoke",
      "claude-code",
      "--live-smoke",
      "codex"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /records: 6/);
    const dashboard = readFileSync(join(fixture.output, "dashboard.md"), "utf8");
    assert.match(dashboard, /live smoke not requested/);
    assert.equal(dashboard.includes("claude-code-live"), false);
    assert.equal(dashboard.includes("codex-live"), false);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble dashboard rejects unknown live-smoke targets", () => {
  const fixture = makeRepo();
  try {
    const result = fusionkit([
      "ensemble",
      "dashboard",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--live-smoke",
      "bogus"
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--live-smoke must be/);
  } finally {
    fixture.cleanup();
  }
});

test("ensemble task-file input works without printing prompt contents", () => {
  const fixture = makeRepo();
  try {
    const taskFile = join(fixture.repo, "task.txt");
    writeFileSync(taskFile, "secret-ish task text that should not print");
    const result = fusionkit([
      "ensemble",
      "run",
      "--harness",
      "mock",
      "--task-file",
      taskFile,
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "--id",
      "cli_file"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ensemble cli_file \[succeeded\]/);
    assert.ok(!result.stderr.includes("secret-ish task text"));
    assert.ok(existsSync(join(fixture.output, "summary.json")));
  } finally {
    fixture.cleanup();
  }
});

test("ensemble e2e runs a FusionKit-backed command matrix and writes a report", async () => {
  const fixture = makeRepo();
  const backend = await startFusionBackend();
  try {
    addFusionCommandProbe(fixture.repo);
    const result = await fusionkitAsync([
      "ensemble",
      "e2e",
      "--fusion-backend",
      backend.url,
      "--harness",
      "command",
      "--command",
      "node fusion-probe.js",
      "--model",
      "alpha=fusion-alpha",
      "--judge-model",
      "fusion-judge",
      "--repo",
      fixture.repo,
      "--out",
      fixture.output,
      "Run the FusionKit-backed command harness."
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /unified e2e \[succeeded:1\]/);
    assert.ok(existsSync(join(fixture.output, "unified-e2e-report.json")));
    const report = readFileSync(join(fixture.output, "unified-e2e-report.json"), "utf8");
    assert.match(report, /"harness": "command"/);
    assert.match(report, /"judgeSynthesis": true/);
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("ensemble gateway codex-config prints a Responses provider snippet", () => {
  const result = fusionkit([
    "ensemble",
    "gateway",
    "codex-config",
    "--fusion-backend",
    "http://127.0.0.1:8787"
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model_provider = "fusionkit-local"/);
  assert.match(result.stdout, /wire_api = "responses"/);
  assert.match(result.stdout, /base_url = "http:\/\/127\.0\.0\.1:8787\/v1"/);
});

test("ensemble gateway test runs the unified front-door acceptance suite", async () => {
  const fixture = makeRepo();
  const backend = await startSentinelBackend("FUSION_OK");
  try {
    addFusionCommandProbe(fixture.repo);
    const reportPath = join(fixture.output, "front-door-report.json");
    const result = await fusionkitAsync([
      "ensemble",
      "gateway",
      "test",
      "--fusion-backend",
      backend.url,
      "--harness",
      "command",
      "--command",
      "node fusion-probe.js",
      "--model",
      "alpha=fusion-alpha",
      "--judge-model",
      "fusion-judge",
      "--repo",
      fixture.repo,
      "--out",
      reportPath,
      "--sentinel",
      "FUSION_OK"
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /front-door acceptance passed — report:/);
    assert.ok(existsSync(reportPath));
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      front_doors: Array<{ id: string; status: string; reason?: string }>;
    };
    const statusOf = (id: string): string | undefined =>
      report.front_doors.find((door) => door.id === id)?.status;
    assert.equal(statusOf("codex-responses"), "passed");
    assert.equal(statusOf("claude-messages"), "passed");
    assert.equal(statusOf("openai-chat"), "passed");
    assert.equal(statusOf("generic-acp"), "passed");
    assert.equal(statusOf("codex-acp"), "blocked");
    assert.equal(statusOf("cursor-acp"), "blocked");
  } finally {
    await backend.close();
    fixture.cleanup();
  }
});

test("fusionkit --version prints the npm CLI and pinned synthesizer versions", async () => {
  const result = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^@fusionkit\/cli \d+\.\d+\.\d+/);
  assert.match(result.stdout, /synthesizer: fusionkit@\d+\.\d+\.\d+ from PyPI/);
});

test("fusionkit version --json emits the version matrix", async () => {
  const result = spawnSync(process.execPath, [CLI, "version", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const matrix = JSON.parse(result.stdout) as {
    cli: string;
    synthesizerPinned: string;
    tools: Record<string, string | null>;
  };
  assert.match(matrix.cli, /^\d+\.\d+\.\d+$/);
  assert.match(matrix.synthesizerPinned, /^\d+\.\d+\.\d+$/);
  assert.ok(typeof matrix.tools.codex === "string");
});

test("--expose is rejected for non-serve launch tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusionkit-expose-"));
  try {
    const result = fusionkit(["codex", "--expose"], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /--expose only applies to `fusionkit serve`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

