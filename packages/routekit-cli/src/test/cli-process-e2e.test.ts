import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  const codexHome = join(root, "codex");
  mkdirSync(join(project, ".routekit"), { recursive: true });
  mkdirSync(home);
  const configPath = join(project, ".routekit", "router.yaml");
  writeFileSync(
    configPath,
    [
      "endpoints:",
      "  - endpointId: command-opaque",
      "    model: provider-private",
      "    provider: mock",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    dialect: openai",
      "defaultEndpointId: command-opaque",
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
      config?: { defaultEndpointId?: string };
    };
    assert.equal(shown.config?.defaultEndpointId, "command-opaque");

    const endpoints = JSON.parse(configured(["endpoints", "list", "--json"])) as {
      endpoints?: Array<{ endpointId?: string; model?: string }>;
    };
    assert.deepEqual(
      endpoints.endpoints?.map((entry) => entry.endpointId),
      ["command-opaque"]
    );
    assert.equal(endpoints.endpoints?.[0]?.model, "provider-private");

    const models = JSON.parse(configured(["models", "--json"])) as {
      defaultModel?: string;
      models?: string[];
    };
    assert.equal(models.defaultModel, "command-opaque");
    assert.deepEqual(models.models, ["command-opaque"]);

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

    const installHelp = runCli(["install", "codex", "--help"], input);
    assert.equal(installHelp.status, 0, installHelp.stderr);
    assert.match(installHelp.stdout, /--gateway-url/);
    assert.match(installHelp.stdout, /--codex-home/);

    const installed = JSON.parse(
      configured([
        "install",
        "codex",
        "--gateway-url",
        "http://127.0.0.1:8080",
        "--codex-home",
        codexHome,
        "--json"
      ])
    ) as { action?: string; profiles?: string[] };
    assert.equal(installed.action, "installed");
    assert.deepEqual(installed.profiles, ["command-opaque"]);

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
      "endpoints:",
      "  - endpointId: opaque",
      "    model: private",
      "    baseUrl: http://127.0.0.1:9/v1",
      "defaultEndpointId: opaque",
      ""
    ].join("\n")
  );
  try {
    const result = runCli(
      ["--config", configPath, "codex", "opaque"],
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
