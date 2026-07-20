import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

function runCli(
  args: readonly string[],
  input: { cwd: string; env: NodeJS.ProcessEnv }
): CliResult {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
    timeout: 30_000
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function mustRun(
  args: readonly string[],
  input: { cwd: string; env: NodeJS.ProcessEnv }
): string {
  const result = runCli(args, input);
  assert.equal(
    result.status,
    0,
    `routekit ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result.stdout;
}

test("real routekit command surfaces execute independently of FusionKit", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-command-process-"));
  const project = join(root, "project");
  const stateHome = join(root, "state");
  const home = join(root, "home");
  mkdirSync(join(project, ".routekit"), { recursive: true });
  mkdirSync(home);
  const configPath = join(project, ".routekit", "router.yaml");
  writeFileSync(
    configPath,
    [
      "providers:",
      "  openai: {}",
      "defaultModel: openai/command-model",
      ""
    ].join("\n")
  );
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_TELEMETRY: "0",
    PORTLESS: "0",
    NO_COLOR: "1"
  };
  const input = { cwd: project, env };
  const configured = (args: readonly string[]): string =>
    mustRun(["--config", configPath, ...args], input);

  try {
    const version = JSON.parse(mustRun(["version", "--json"], input)) as {
      package?: string;
      version?: string;
    };
    assert.equal(version.package, "@routekit/cli");
    assert.match(version.version ?? "", /^\d+\.\d+\.\d+/);

    for (const shell of ["bash", "zsh", "fish"]) {
      assert.match(mustRun(["completion", shell], input), /routekit/);
    }

    const path = JSON.parse(configured(["config", "path", "--json"])) as {
      path?: string;
      exists?: boolean;
    };
    assert.equal(path.path, configPath);
    assert.equal(path.exists, true);
    const shown = JSON.parse(configured(["config", "show", "--json"])) as {
      config?: { defaultModel?: string };
    };
    assert.equal(shown.config?.defaultModel, "openai/command-model");

    const provider = JSON.parse(
      configured(["providers", "add", "codex", "--json"])
    ) as {
      provider?: string;
      added?: boolean;
    };
    assert.equal(provider.provider, "codex");
    assert.equal(provider.added, true);

    const telemetry = JSON.parse(mustRun(["telemetry", "status", "--json"], input)) as {
      enabled?: boolean;
      fields?: Record<string, string[]>;
    };
    assert.equal(telemetry.enabled, false);
    assert.ok(Array.isArray(telemetry.fields?.["cli.command"]));

    const doctor = runCli(
      ["--config", configPath, "doctor", "--json"],
      { cwd: project, env: { ...env, PATH: "/nonexistent" } }
    );
    assert.equal(doctor.status, 1, `${doctor.stdout}\n${doctor.stderr}`);
    const diagnosis = JSON.parse(doctor.stdout) as {
      ready?: boolean;
      checks?: Array<{ label?: string; ok?: boolean }>;
    };
    assert.equal(diagnosis.ready, false);
    assert.equal(
      diagnosis.checks?.find((check) => check.label === "router config")?.ok,
      true
    );
    for (const binary of ["codex", "claude", "cursor-agent", "opencode"]) {
      assert.equal(
        diagnosis.checks?.find((check) => check.label === binary)?.ok,
        false
      );
    }

    const installHelp = runCli(["codex", "install", "--help"], input);
    assert.equal(installHelp.status, 0, installHelp.stderr);
    assert.match(installHelp.stdout, /--gateway-url/);
    assert.match(installHelp.stdout, /--codex-home/);

    const legacyInstall = runCli(["install", "codex"], input);
    assert.equal(legacyInstall.status, 1);
    assert.match(legacyInstall.stderr, /unknown command/i);

    for (const fusionOnly of ["setup", "prompts", "sessions", "ensemble"]) {
      const rejected = runCli([fusionOnly], input);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /unknown command/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real routekit launcher fails preflight before starting a gateway when its harness is missing", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-missing-harness-"));
  const configPath = join(root, "router.yaml");
  writeFileSync(
    configPath,
    [
      "providers:",
      "  openai: {}",
      "defaultModel: openai/private",
      ""
    ].join("\n")
  );
  try {
    const result = runCli(
      ["--config", configPath, "codex", "openai/private"],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: root,
          ROUTEKIT_HOME: join(root, "state"),
          PATH: "/nonexistent",
          PORTLESS: "0",
          NO_COLOR: "1"
        }
      }
    );
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /routekit preflight failed/i);
    assert.match(`${result.stdout}${result.stderr}`, /"codex" was not found on PATH/);
    assert.equal(existsSync(join(root, "state", "services", "gateway.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config migrate diagnoses and converts legacy endpoint config explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-migrate-command-"));
  const configPath = join(root, "router.yaml");
  writeFileSync(
    configPath,
    [
      "endpoints:",
      "  - endpointId: kimi",
      "    model: moonshotai/kimi-k2-thinking",
      "    provider: openrouter",
      "    baseUrl: https://openrouter.ai/api/v1",
      "    apiKeyEnv: OPENROUTER_API_KEY",
      "defaultEndpointId: kimi",
      ""
    ].join("\n")
  );
  const input = {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      ROUTEKIT_HOME: join(root, "state"),
      PORTLESS: "0",
      NO_COLOR: "1"
    }
  };
  try {
    const preview = JSON.parse(
      mustRun(
        [
          "--config",
          configPath,
          "config",
          "migrate",
          "--dry-run",
          "--json"
        ],
        input
      )
    ) as {
      migration?: {
        changed?: boolean;
        diagnostics?: Array<{ code?: string }>;
      };
    };
    assert.equal(preview.migration?.changed, true);
    assert.equal(
      preview.migration?.diagnostics?.some(
        (diagnostic) => diagnostic.code === "custom-alias"
      ),
      true
    );
    assert.match(readFileSync(configPath, "utf8"), /^endpoints:/);

    mustRun(
      ["--config", configPath, "config", "migrate", "--json"],
      input
    );
    const migrated = readFileSync(configPath, "utf8");
    assert.match(migrated, /^providers:/);
    assert.match(
      migrated,
      /defaultModel: openrouter\/moonshotai\/kimi-k2-thinking/
    );
    assert.doesNotMatch(migrated, /endpoints:|defaultEndpointId:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
