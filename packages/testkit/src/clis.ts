/**
 * Real coding-agent CLI harnesses: run the ACTUAL `claude` (Claude Code) and
 * `codex` (Codex CLI) binaries against a gateway URL — no mocked tool
 * clients. The CLIs authenticate against the gateway with inert tokens and
 * never touch real provider accounts: Claude Code is pointed via
 * `ANTHROPIC_BASE_URL`, Codex via a generated `CODEX_HOME` provider config
 * (`wire_api = "responses"`, `requires_openai_auth = false`).
 *
 * Suites gate on {@link cliAvailable} so environments without the binaries
 * skip with an honest reason; the `stack-e2e` CI job installs them for real.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CliRunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the run was killed on timeout instead of exiting. */
  timedOut: boolean;
};

function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child.
    }
  }
  child.kill("SIGKILL");
}

/** Whether a CLI binary is installed and answers `--version`. */
export function cliAvailable(binary: string): boolean {
  const probe = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return probe.error === undefined && probe.status === 0;
}

/** `node:test` skip-gating sugar for suites that drive a real CLI binary. */
export function cliSkip(binary: string): false | string {
  return cliAvailable(binary) ? false : `${binary} CLI is not installed`;
}

/** Build the environment passed to the real Claude Code process. */
export function claudeCodeEnv(
  input: { gatewayUrl: string; model?: string },
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  // env-spread-allowed: the real CLI needs a normal login environment (HOME, PATH); the auth env vars below point it at the local gateway, never a real account
  return {
    ...baseEnv,
    ANTHROPIC_BASE_URL: input.gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: "sim-gateway-token",
    ANTHROPIC_MODEL: input.model ?? "fusion-panel",
    // Keep the run deterministic: no background model traffic, telemetry,
    // update checks, or crash reporting.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1"
  };
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }
): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += error.message;
      resolve({ code: null, stdout, stderr, timedOut });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) killProcessTree(child);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Run the real Claude Code CLI in print mode against a gateway.
 *
 * `dangerouslySkipPermissions` is needed when the scripted fused turn commits
 * tool calls (e.g. `Bash`) that Claude Code should execute without an
 * interactive approval prompt.
 */
export async function runClaudeCode(input: {
  gatewayUrl: string;
  prompt: string;
  cwd?: string;
  /** Gateway model id the CLI should request (default `fusion-panel`). */
  model?: string;
  dangerouslySkipPermissions?: boolean;
  timeoutMs?: number;
}): Promise<CliRunResult> {
  const args = ["-p", input.prompt, "--output-format", "text"];
  if (input.dangerouslySkipPermissions === true) args.push("--dangerously-skip-permissions");
  const env = claudeCodeEnv(input);
  return await run("claude", args, {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    env,
    timeoutMs: input.timeoutMs ?? 120_000
  });
}

/** Serialize the generated config read by the real Codex process. */
export function codexExecConfigToml(input: {
  gatewayUrl: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}): string {
  return [
    `model = "${input.model ?? "fusion-panel"}"`,
    'model_provider = "fusion-gateway"',
    'approval_policy = "never"',
    `sandbox_mode = "${input.sandbox ?? "danger-full-access"}"`,
    "",
    "[model_providers.fusion-gateway]",
    'name = "Fusion Gateway"',
    // Codex appends `/responses`, so the provider base URL ends in `/v1`.
    `base_url = "${input.gatewayUrl}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    ""
  ].join("\n");
}

/**
 * Run the real Codex CLI (`codex exec`) against a gateway, with a generated
 * `CODEX_HOME` that registers the gateway as a Responses-wire model provider.
 *
 * `sandbox` defaults to `danger-full-access` because Codex's Landlock/seatbelt
 * sandboxes are unavailable in most CI containers and sandboxing is not what
 * these tests exercise; the scripted tool commands are inert (`echo`).
 */
export async function runCodexExec(input: {
  gatewayUrl: string;
  prompt: string;
  cwd: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  timeoutMs?: number;
}): Promise<CliRunResult> {
  const codexHome = mkdtempSync(join(tmpdir(), "fusionkit-testkit-codex-"));
  writeFileSync(join(codexHome, "config.toml"), codexExecConfigToml(input));
  try {
    // env-spread-allowed: the real CLI needs a normal environment (PATH, TMPDIR); CODEX_HOME points it at the generated gateway-only config
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
    return await run("codex", ["exec", "--skip-git-repo-check", input.prompt], {
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs ?? 120_000
    });
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

type OpenCodeInvocation = {
  config: Record<string, unknown>;
  args: string[];
};

/** Build the generated config and argv passed to the real OpenCode process. */
export function openCodeInvocation(input: {
  gatewayUrl: string;
  prompt: string;
  model?: string;
}): OpenCodeInvocation {
  const model = input.model ?? "fusion-panel";
  return {
    config: {
      $schema: "https://opencode.ai/config.json",
      provider: {
        "fusionkit-local": {
          npm: "@ai-sdk/openai-compatible",
          name: "FusionKit local",
          options: { baseURL: `${input.gatewayUrl}/v1` },
          models: { [model]: { name: model } }
        }
      }
    },
    args: [
      "run",
      "--model",
      `fusionkit-local/${model}`,
      "--format",
      "json",
      "--auto",
      input.prompt
    ]
  };
}

/**
 * Run the real OpenCode CLI (`opencode run`) against a gateway through an
 * ephemeral OpenAI-compatible provider config. OpenCode may make an internal
 * title-generation turn before the main agent turn; tests intentionally
 * observe and script both through the provider journal.
 */
export async function runOpenCode(input: {
  gatewayUrl: string;
  prompt: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
}): Promise<CliRunResult> {
  const configDir = mkdtempSync(join(tmpdir(), "fusionkit-testkit-opencode-"));
  const configPath = join(configDir, "opencode.json");
  const invocation = openCodeInvocation(input);
  writeFileSync(configPath, JSON.stringify(invocation.config, null, 2));
  try {
    // env-spread-allowed: the real CLI needs a normal PATH/HOME; its only model provider is the ephemeral local gateway config
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_CONFIG: configPath
    };
    return await run("opencode", invocation.args, {
      cwd: input.cwd,
      env,
      timeoutMs: input.timeoutMs ?? 120_000
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
