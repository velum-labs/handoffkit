import { bold, box, cyan, dim, glyph, green, isInteractive, uiStream } from "@routekit/cli-ui";
import { createBackend, resolveBackendConfig } from "@fusionkit/gateway";
import type { BackendConfig } from "@fusionkit/gateway";
import { startGateway } from "@routekit/gateway";
import { KernelBackend } from "@fusionkit/ensemble";
import { LOCAL_MODEL_LABEL, readEnv } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

import { generateSessionToken, startPublicTunnel } from "./shared/tunnel.js";
import type { PublicTunnel, StartPublicTunnelOptions } from "./shared/tunnel.js";
import { toolRegistry } from "./tools.js";

/**
 * `fusionkit <tool> --direct` — back a vendor agent harness with one locally
 * running model, with no change to how the tool is invoked. Each launcher
 * ensures the model gateway is up, applies the tool's native configuration
 * shim (environment, config file, or — for Cursor — IDE settings + a public
 * tunnel), then execs the real binary with the user's own arguments.
 *
 * The per-tool launch + shim logic now lives in the `@fusionkit/tool-*`
 * packages; this dispatcher wires a started gateway into a ToolLaunchContext.
 */

/** A tool launched directly against one local model, or the `serve` pseudo-tool. */
export type DirectTool = string;

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

export type RunDirectOptions = {
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
  /** Override the local gateway lifecycle (tests). */
  startGateway?: (config: BackendConfig, authToken?: string) => Promise<GatewayHandle>;
  log?: (line: string) => void;
};

/**
 * Start the gateway, apply the tool's shim, and exec the real binary. Returns
 * the child's exit code. `serve` runs the gateway in the foreground.
 */
export async function runDirect(
  tool: DirectTool,
  toolArgs: string[],
  options: RunDirectOptions = {}
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
  const gateway = await (options.startGateway ?? startLocalGateway)(config, authToken);
  // The framed summary renders only on the default interactive surface;
  // injected log sinks (tests, programmatic callers) keep plain lines.
  const styled = options.log === undefined && isInteractive();
  if (!styled || tool !== "serve") {
    log(`${green(glyph.tick())} ${bold("local gateway")} ${cyan(gateway.url)} ${dim(`(model: ${model})`)}`);
  }

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
        log(`fusionkit --direct: automatic tunnel unavailable (${first})`);
      }
    }
    if (tool === "serve") {
      const label = (text: string): string => dim(text.padEnd("anthropic".length));
      const rows = [
        `${label("openai")}  ${cyan(`${gateway.url}/v1`)}`,
        `${label("anthropic")}  ${cyan(`${gateway.url}/v1/messages`)}`,
        `${label("responses")}  ${cyan(`${gateway.url}/v1/responses`)}`,
        `${label("model")}  ${model}`
      ];
      if (styled) {
        uiStream().write(`\n${box("local gateway", rows)}\n`);
        uiStream().write(
          `${green(glyph.tick())} ${bold("gateway is running")} ${dim("— point any tool at it, or Ctrl+C to stop")}\n`
        );
      } else {
        for (const row of rows) log(row);
        log(dim("Press Ctrl+C to stop."));
      }
      const exitCode = await new Promise<number>((resolve) => {
        const finish = (code: number): void => {
          process.off("SIGINT", onInterrupt);
          process.off("SIGTERM", onTerminate);
          if (styled) {
            uiStream().write(`\n${green(glyph.tick())} ${bold("gateway stopped")}\n`);
          }
          resolve(code);
        };
        const onInterrupt = (): void => finish(130);
        const onTerminate = (): void => finish(143);
        process.once("SIGINT", onInterrupt);
        process.once("SIGTERM", onTerminate);
      });
      return exitCode;
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
