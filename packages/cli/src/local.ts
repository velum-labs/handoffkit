import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackend, resolveBackendConfig, startGateway } from "@fusionkit/model-gateway";
import type { BackendConfig } from "@fusionkit/model-gateway";

import { spawnTool } from "./shared/proc.js";

/**
 * `warrant local <tool>` — back a vendor agent harness with a locally running
 * model, with no change to how the tool is invoked. Each launcher ensures the
 * model gateway is up, applies the tool's native configuration shim
 * (environment, config file, or — for Cursor — IDE settings + a public
 * tunnel), then execs the real binary with the user's own arguments.
 *
 * The shim builders below are pure so they can be unit-tested; the dispatcher
 * (`runLocal`) wires them to a started gateway and the real child process.
 */

export type LocalTool = "claude" | "codex" | "opencode" | "cursor" | "serve";

export const LOCAL_TOOLS: readonly LocalTool[] = ["claude", "codex", "opencode", "cursor", "serve"];

/** The label a tool uses for the local model in its own UI. */
const LOCAL_MODEL_LABEL = "warrant-local";

function backendModel(config: BackendConfig): string {
  return config.kind === "mlx" ? config.model : config.defaultModel ?? LOCAL_MODEL_LABEL;
}

// ---- pure shim builders (unit-tested) ----

/** Environment for Claude Code: point it at the gateway's Anthropic surface. */
export function claudeEnv(gatewayUrl: string, authToken?: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: authToken ?? "warrant-local",
    // Surface the local model in the /model picker (Anthropic discovery).
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  };
}

/**
 * Codex config.toml fragment defining the gateway as a Responses provider.
 * Written into an ephemeral CODEX_HOME so the user's own config is untouched.
 */
export function codexConfigToml(gatewayUrl: string, model: string): string {
  return [
    `model = "${model}"`,
    `model_provider = "${LOCAL_MODEL_LABEL}"`,
    "",
    `[model_providers.${LOCAL_MODEL_LABEL}]`,
    `name = "Warrant local"`,
    `base_url = "${gatewayUrl}/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    ""
  ].join("\n");
}

/** opencode config registering the gateway as an OpenAI-compatible provider. */
export function opencodeConfig(gatewayUrl: string, model: string): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [LOCAL_MODEL_LABEL]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Warrant local",
        options: { baseURL: `${gatewayUrl}/v1` },
        models: { [model]: { name: model } }
      }
    }
  };
}

/** The opencode `--model provider/model` argument for the gateway provider. */
export function opencodeModelArg(model: string): string {
  return `${LOCAL_MODEL_LABEL}/${model}`;
}

/** Human-facing setup for Cursor (IDE plan/chat panel only; needs a public URL). */
export function cursorInstructions(publicUrl: string, model: string): string {
  return [
    "Cursor backs only its plan/chat panel with a custom model, and cannot reach",
    "localhost — so this uses a public tunnel. In Cursor: Settings -> Models ->",
    "enable 'Override OpenAI Base URL', then set:",
    "",
    `  Override OpenAI Base URL : ${publicUrl}/v1`,
    `  Model name               : ${model}`,
    `  OpenAI API Key           : warrant-local (any non-empty value)`,
    "",
    "Use the chat/plan panel (Cmd/Ctrl+L). Composer, inline edit, apply, and",
    "autocomplete remain on Cursor's own backend and are not affected."
  ].join("\n");
}

// ---- dispatcher ----

type GatewayHandle = { url: string; close: () => Promise<void> };

async function startLocalGateway(config: BackendConfig, authToken?: string): Promise<GatewayHandle> {
  const backend = createBackend(config);
  const gateway = await startGateway({
    backend,
    ...(authToken !== undefined ? { authToken } : {})
  });
  return { url: gateway.url(), close: () => gateway.close() };
}

export type RunLocalOptions = {
  /** Public URL for Cursor's tunnel (or WARRANT_PUBLIC_URL). */
  publicUrl?: string;
  /** Bearer token to require on the gateway. */
  authToken?: string;
  /** Override the resolved backend (tests). */
  config?: BackendConfig;
  log?: (line: string) => void;
};

/**
 * Start the gateway, apply the tool's shim, and exec the real binary. Returns
 * the child's exit code. `serve` runs the gateway in the foreground.
 */
export async function runLocal(
  tool: LocalTool,
  toolArgs: string[],
  options: RunLocalOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const config = options.config ?? resolveBackendConfig();
  const model = backendModel(config);
  const gateway = await startLocalGateway(config, options.authToken);
  log(`warrant local: gateway on ${gateway.url} (model: ${model})`);

  try {
    switch (tool) {
      case "serve": {
        log(`OpenAI:    ${gateway.url}/v1`);
        log(`Anthropic: ${gateway.url}/v1/messages`);
        log(`Responses: ${gateway.url}/v1/responses`);
        log("Press Ctrl+C to stop.");
        await new Promise<void>(() => {
          /* run until interrupted */
        });
        return 0;
      }
      case "claude":
        return await spawnTool("claude", toolArgs, claudeEnv(gateway.url, options.authToken));
      case "codex": {
        const home = mkdtempSync(join(tmpdir(), "warrant-codex-"));
        writeFileSync(join(home, "config.toml"), codexConfigToml(gateway.url, model));
        return await spawnTool("codex", toolArgs, { CODEX_HOME: home });
      }
      case "opencode": {
        const dir = mkdtempSync(join(tmpdir(), "warrant-opencode-"));
        const configPath = join(dir, "opencode.json");
        writeFileSync(configPath, JSON.stringify(opencodeConfig(gateway.url, model), null, 2));
        const args = toolArgs.includes("--model") ? toolArgs : ["--model", opencodeModelArg(model), ...toolArgs];
        return await spawnTool("opencode", args, { OPENCODE_CONFIG: configPath });
      }
      case "cursor": {
        const publicUrl = options.publicUrl ?? process.env.WARRANT_PUBLIC_URL;
        if (publicUrl === undefined || publicUrl.length === 0) {
          log("");
          log("Cursor needs a public URL (it cannot reach localhost). Start a tunnel to");
          log(`${gateway.url} (e.g. 'cloudflared tunnel --url ${gateway.url}' or 'ngrok http`);
          log(`${gateway.url.replace(/^https?:\/\//, "")}'), then re-run with --public-url <url>`);
          log("or set WARRANT_PUBLIC_URL.");
          return 1;
        }
        log("");
        log(cursorInstructions(publicUrl, model));
        log("");
        log("Gateway is running; leave this process up while you use Cursor. Ctrl+C to stop.");
        await new Promise<void>(() => {
          /* keep the gateway (and tunnel target) alive */
        });
        return 0;
      }
      default: {
        const unreachable: never = tool;
        throw new Error(`unknown local tool: ${String(unreachable)}`);
      }
    }
  } finally {
    await gateway.close();
  }
}
