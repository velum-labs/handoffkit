import { uiStream } from "@fusionkit/cli-ui";
import { createBackend, resolveBackendConfig, startGateway } from "@fusionkit/model-gateway";
import type { BackendConfig } from "@fusionkit/model-gateway";
import { KernelBackend } from "@fusionkit/ensemble";
import { LOCAL_MODEL_LABEL, readEnv } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

import { generateSessionToken, startPublicTunnel } from "./shared/tunnel.js";
import type { PublicTunnel, StartPublicTunnelOptions } from "./shared/tunnel.js";
import { toolRegistry } from "./tools.js";

/**
 * `fusionkit local <tool>` — back a vendor agent harness with a locally running
 * model, with no change to how the tool is invoked. Each launcher ensures the
 * model gateway is up, applies the tool's native configuration shim
 * (environment, config file, or — for Cursor — IDE settings + a public
 * tunnel), then execs the real binary with the user's own arguments.
 *
 * The per-tool launch + shim logic now lives in the `@fusionkit/tool-*`
 * packages; this dispatcher wires a started gateway into a ToolLaunchContext.
 */

/** A launchable local tool id from the registry, or the `serve` pseudo-tool. */
export type LocalTool = string;

/** Launchable local tools (registry-derived) plus the `serve` pseudo-tool. */
export const LOCAL_TOOLS: readonly LocalTool[] = [
  ...toolRegistry.launchableLocal().map((tool) => tool.id),
  "serve"
];

function backendModel(config: BackendConfig): string {
  return config.kind === "mlx" ? config.model : config.defaultModel ?? LOCAL_MODEL_LABEL;
}

// ---- pure shim builders (re-exported from the per-tool packages) ----

export { claudeEnv } from "@fusionkit/tool-claude";
export { codexLaunchConfigToml as codexConfigToml } from "@fusionkit/tool-codex";
export { opencodeConfig, opencodeModelArg } from "@fusionkit/tool-opencode";
export { cursorInstructions } from "@fusionkit/tool-cursor";

// ---- dispatcher ----

type GatewayHandle = { url: string; close: () => Promise<void> };

async function startLocalGateway(config: BackendConfig, authToken?: string): Promise<GatewayHandle> {
  const backend = new KernelBackend(createBackend(config), {
    workflowIds: { chat: "direct-model-turn", models: "direct-model-models", embeddings: "direct-model-embeddings" }
  });
  const gateway = await startGateway({
    backend,
    ...(authToken !== undefined ? { authToken } : {})
  });
  return { url: gateway.url(), close: () => gateway.close() };
}

export type RunLocalOptions = {
  /** Public URL for Cursor's tunnel (or FUSIONKIT_PUBLIC_URL). */
  publicUrl?: string;
  /** Cursor only: wire the desktop IDE to the gateway via the local desktop proxy. */
  ide?: boolean;
  /** Bearer token to require on the gateway. */
  authToken?: string;
  /** Override the resolved backend (tests). */
  config?: BackendConfig;
  /** Override the tunnel provisioner (tests). */
  startTunnel?: (options: StartPublicTunnelOptions) => Promise<PublicTunnel>;
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
  const log = options.log ?? ((line: string) => uiStream().write(`${line}\n`));
  const config = options.config ?? resolveBackendConfig();
  const model = backendModel(config);
  let publicUrl = options.publicUrl ?? readEnv(process.env, "FUSIONKIT_PUBLIC_URL");
  // Cursor's BYOK plan-panel flow needs a public HTTPS URL (Cursor's backend
  // proxies BYOK traffic and blocks loopback). When the user did not bring
  // their own tunnel, provision a Quick Tunnel — and since that URL is public,
  // always enforce a gateway bearer token (auto-generated when unset).
  const needsTunnel = tool === "cursor" && options.ide !== true && publicUrl === undefined;
  const authToken = options.authToken ?? (needsTunnel ? generateSessionToken() : undefined);
  const gateway = await startLocalGateway(config, authToken);
  log(`fusionkit local: gateway on ${gateway.url} (model: ${model})`);

  const disposers: Array<() => Promise<void> | void> = [];
  try {
    if (needsTunnel) {
      try {
        const tunnel = await (options.startTunnel ?? startPublicTunnel)({
          gatewayUrl: gateway.url,
          log
        });
        disposers.push(() => tunnel.close());
        publicUrl = tunnel.url;
      } catch (error) {
        // Degrade to the manual-tunnel instructions the launcher prints when
        // no public URL is available, instead of failing the whole launch.
        const first = (error instanceof Error ? error.message : String(error)).split("\n")[0];
        log(`fusionkit local: automatic tunnel unavailable (${first})`);
      }
    }
    if (tool === "serve") {
      log(`OpenAI:    ${gateway.url}/v1`);
      log(`Anthropic: ${gateway.url}/v1/messages`);
      log(`Responses: ${gateway.url}/v1/responses`);
      log("Press Ctrl+C to stop.");
      await new Promise<void>(() => {
        /* run until interrupted */
      });
      return 0;
    }
    const integration = toolRegistry.get(tool);
    if (integration === undefined || !integration.modes.includes("local")) {
      throw new Error(`unknown local tool: ${String(tool)}`);
    }
    const ctx: ToolLaunchContext = {
      mode: "local",
      gatewayUrl: gateway.url,
      modelLabel: model,
      toolArgs,
      ...(options.ide === true ? { ide: true } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      log,
      prepareForPassthrough: () => undefined,
      registerPort: (_name, port) => `http://127.0.0.1:${port}`,
      unregisterPort: () => undefined,
      registerDisposer: (dispose) => disposers.push(dispose)
    };
    return await integration.launch(ctx);
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        // best-effort teardown
      }
    }
    await gateway.close();
  }
}
