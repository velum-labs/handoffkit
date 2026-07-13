import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
const SMOKE_ENV_KEYS = [
  "FUSIONKIT_CLAUDE_SMOKE",
  "FUSIONKIT_CODEX_SMOKE",
  "FUSIONKIT_CURSOR_SMOKE"
] as const;
const PROVIDER_ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"] as const;

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
  for (const command of ["codex", "claude", "cursor", "serve", "opencode", "init", "ensemble"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(result.stdout, /^  local\b/m);
  assertCommandOrder(result.stdout, [
    "codex",
    "claude",
    "cursor",
    "serve",
    "opencode",
    "init",
    "setup",
    "doctor",
    "config",
    "prompts",
    "sessions",
    "models",
    "ensemble",
    "completion",
    "version"
  ]);
  assert.doesNotMatch(result.stdout, /^  runtime\b/m);
  assert.match(result.stdout, /Quickstart:/);
  assert.match(result.stdout, /fusionkit setup/);
  assert.match(result.stdout, /Environment variables:/);
  assert.match(result.stdout, /FUSIONKIT_SKIP_KEY_VALIDATION/);
  assert.match(result.stdout, /FUSIONKIT_\*/);
});

test("ensemble help only lists named-ensemble management", () => {
  const result = fusionkit(["ensemble", "--help"]);
  assert.equal(result.status, 0);
  for (const sub of ["list", "add", "edit", "remove", "rename"]) {
    assert.match(result.stdout, new RegExp(`\\b${sub}\\b`));
  }
  for (const removed of ["run", "handoff", "dashboard", "e2e", "gateway", "use"]) {
    assert.doesNotMatch(result.stdout, new RegExp(`^  ${removed}\\b`, "m"));
  }
});

test("completion bash includes top-level commands from the Commander tree", () => {
  const result = fusionkit(["completion", "bash"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /complete -F _fusionkit_completion fusionkit/);
  assert.match(result.stdout, /fusionkit __complete/);
  for (const command of ["codex", "claude", "cursor", "serve", "opencode", "doctor", "ensemble"]) {
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

test("removed maintainer commands are rejected", () => {
  for (const args of [
    ["runtime"],
    ["ensemble", "run"],
    ["ensemble", "handoff"],
    ["ensemble", "dashboard"],
    ["ensemble", "e2e"],
    ["ensemble", "gateway"],
    ["ensemble", "use"]
  ]) {
    const result = fusionkit(args);
    assert.equal(result.status, 1, `${args.join(" ")} should be rejected`);
    assert.match(result.stderr, /unknown command/);
  }
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

test("direct mode rejects fusion-only options instead of ignoring them", () => {
  const result = fusionkit(["codex", "--direct", "--model", "gpt=openai:gpt-5.5"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model\/--models cannot be combined with --direct/);
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

test("the removed fusion dispatcher is rejected", () => {
  const result = fusionkit(["fusion"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command ['"]fusion['"]/);
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

function makeRepo(): { repo: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "fusionkit-ensemble-cli-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  spawnSync("git", ["config", "user.email", "cli@fusionkit.local"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "fusionkit-cli"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# cli ensemble\n");
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repo });
  return { repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

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

