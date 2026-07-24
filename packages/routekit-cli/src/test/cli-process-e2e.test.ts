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
import { parse as parseYaml } from "yaml";

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
  try {
    const version = JSON.parse(mustRun(["version", "--json"], input)) as {
      package?: string;
      version?: string;
    };
    assert.equal(version.package, "@velum-labs/routekit");
    assert.match(version.version ?? "", /^\d+\.\d+\.\d+/);

    for (const shell of ["bash", "zsh", "fish"]) {
      assert.match(mustRun(["completion", shell], input), /routekit/);
    }

    const installHelp = runCli(["codex", "install", "--help"], input);
    assert.equal(installHelp.status, 0, installHelp.stderr);
    assert.match(installHelp.stdout, /--gateway-url/);
    assert.match(installHelp.stdout, /--codex-home/);

    const claudeInstallHelp = runCli(["claude", "install", "--help"], input);
    assert.equal(claudeInstallHelp.status, 0, claudeInstallHelp.stderr);
    assert.match(claudeInstallHelp.stdout, /--gateway-url/);
    assert.match(claudeInstallHelp.stdout, /--auth-token-env/);
    assert.match(claudeInstallHelp.stdout, /--claude-config-dir/);

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

test("config init does not install a crash-looping daemon when credentials are missing", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-config-init-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const stateHome = join(root, "state");
  mkdirSync(home);
  mkdirSync(project);
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_NO_SUPERVISOR: "1",
    PORTLESS: "0",
    NO_COLOR: "1",
    OPENAI_API_KEY: undefined
  };
  try {
    const result = runCli(["config", "init", "--global", "--json"], {
      cwd: project,
      env
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      created?: boolean;
      daemonStarted?: boolean;
      missingCredentials?: string[];
    };
    assert.equal(payload.created, true);
    assert.equal(payload.daemonStarted, false);
    assert.deepEqual(payload.missingCredentials, ["OPENAI_API_KEY"]);
    assert.equal(
      existsSync(join(home, ".config", "routekit", "router.yaml")),
      true
    );
    const config = parseYaml(
      readFileSync(join(home, ".config", "routekit", "router.yaml"), "utf8")
    ) as {
      providers: Record<string, unknown>;
      defaultModel?: string;
    };
    assert.deepEqual(Object.keys(config.providers), ["openai"]);
    assert.equal(config.defaultModel, "openai/gpt-5.5");
    assert.equal(existsSync(join(stateHome, "services", "daemon.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("config init supports each first-launch provider and an empty bootstrap", async (t) => {
  const cases = [
    {
      name: "anthropic",
      args: ["--provider", "anthropic"],
      providers: ["anthropic"],
      defaultModel: "anthropic/claude-sonnet-4-5",
      requiredCredential: "ANTHROPIC_API_KEY"
    },
    {
      name: "openrouter",
      args: ["--provider", "openrouter"],
      providers: ["openrouter"],
      defaultModel: "openrouter/anthropic/claude-sonnet-4.5",
      requiredCredential: "OPENROUTER_API_KEY"
    },
    {
      name: "empty",
      args: ["--empty"],
      providers: [],
      defaultModel: undefined,
      requiredCredential: undefined
    }
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const root = mkdtempSync(join(tmpdir(), `routekit-config-init-${fixture.name}-`));
      const home = join(root, "home");
      const project = join(root, "project");
      const stateHome = join(root, "state");
      mkdirSync(home);
      mkdirSync(project);
      const env = {
        ...process.env,
        HOME: home,
        ROUTEKIT_HOME: stateHome,
        ROUTEKIT_NO_SUPERVISOR: "1",
        ROUTEKIT_TELEMETRY: "0",
        PORTLESS: "0",
        NO_COLOR: "1",
        OPENAI_API_KEY: undefined,
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        OPENROUTER_API_KEY: undefined
      };
      const input = { cwd: project, env };
      const configPath = join(home, ".config", "routekit", "router.yaml");
      const daemonRecordPath = join(stateHome, "services", "daemon.json");
      try {
        const result = runCli(
          ["config", "init", "--global", ...fixture.args, "--json"],
          input
        );
        assert.equal(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout) as {
          created?: boolean;
          daemonStarted?: boolean;
          missingCredentials?: string[];
        };
        assert.equal(payload.created, true);

        const config = parseYaml(readFileSync(configPath, "utf8")) as {
          providers: Record<string, unknown>;
          defaultModel?: string;
        };
        assert.deepEqual(Object.keys(config.providers), fixture.providers);
        assert.equal(config.defaultModel, fixture.defaultModel);

        if (fixture.requiredCredential !== undefined) {
          assert.equal(payload.daemonStarted, false);
          assert.ok(payload.missingCredentials?.includes(fixture.requiredCredential));
          assert.equal(existsSync(daemonRecordPath), false);
        } else {
          assert.equal(payload.missingCredentials, undefined);
          assert.equal(existsSync(daemonRecordPath), true);
        }
      } finally {
        if (existsSync(daemonRecordPath)) {
          const stopped = runCli(["stop", "--json"], input);
          assert.equal(stopped.status, 0, stopped.stderr);
        }
        rmSync(root, { recursive: true, force: true });
      }
    });
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
      ["config", "migrate", "--json"],
      {
        ...input,
        env: { ...input.env, ROUTEKIT_CONFIG: configPath }
      }
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
