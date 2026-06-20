import { join } from "node:path";

import { spawnTool, terminate } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

import { startCursorBridge } from "./bridge.js";

/** Human-facing setup for Cursor (IDE plan/chat panel only; needs a public URL). */
export function cursorInstructions(publicUrl: string, model: string): string {
  return [
    "Cursor backs only its plan/chat panel with a custom model, and cannot reach",
    "localhost — so this uses a public tunnel. In Cursor: Settings -> Models ->",
    "enable 'Override OpenAI Base URL', then set:",
    "",
    `  Override OpenAI Base URL : ${publicUrl}/v1`,
    `  Model name               : ${model}`,
    `  OpenAI API Key           : fusionkit-local (any non-empty value)`,
    "",
    "Use the chat/plan panel (Cmd/Ctrl+L). Composer, inline edit, apply, and",
    "autocomplete remain on Cursor's own backend and are not affected."
  ].join("\n");
}

/**
 * Fusion launch: spawn the Cursorkit bridge (its local-model backend pointed at
 * the fusion gateway) and exec cursor-agent against it.
 */
async function launchCursorFusion(ctx: ToolLaunchContext): Promise<number> {
  const started = await startCursorBridge({
    fusionUrl: ctx.gatewayUrl,
    modelLabel: ctx.modelLabel,
    ...(ctx.logsDir !== undefined ? { logFile: join(ctx.logsDir, "cursor-bridge.log") } : {}),
    ...(ctx.caCertPath !== undefined ? { caCertPath: ctx.caCertPath } : {}),
    log: ctx.log
  });
  const bridgeUrl = ctx.registerPort("cursor", started.port);
  ctx.registerDisposer(() => {
    ctx.unregisterPort("cursor");
    terminate(started.child);
  });
  ctx.prepareForPassthrough();
  ctx.log("fusion: launching cursor-agent...");
  return await spawnTool(
    "cursor-agent",
    ["--endpoint", bridgeUrl, "--model", ctx.modelLabel, ...ctx.toolArgs],
    {},
    ctx.repo
  );
}

/**
 * Local launch: Cursor cannot reach loopback, so print the IDE override setup
 * for a public tunnel and hold the gateway up.
 */
async function launchCursorLocal(ctx: ToolLaunchContext): Promise<number> {
  const publicUrl = ctx.publicUrl;
  if (publicUrl === undefined || publicUrl.length === 0) {
    ctx.log("");
    ctx.log("Cursor needs a public URL (it cannot reach localhost). Start a tunnel to");
    ctx.log(`${ctx.gatewayUrl} (e.g. 'cloudflared tunnel --url ${ctx.gatewayUrl}' or 'ngrok http`);
    ctx.log(`${ctx.gatewayUrl.replace(/^https?:\/\//, "")}'), then re-run with --public-url <url>`);
    ctx.log("or set FUSIONKIT_PUBLIC_URL.");
    return 1;
  }
  ctx.log("");
  ctx.log(cursorInstructions(publicUrl, ctx.modelLabel));
  ctx.log("");
  ctx.log("Gateway is running; leave this process up while you use Cursor. Ctrl+C to stop.");
  await new Promise<void>(() => {
    /* keep the gateway (and tunnel target) alive */
  });
  return 0;
}

/** Boot Cursor, branching on whether it backs the fusion panel or a local model. */
export async function launchCursor(ctx: ToolLaunchContext): Promise<number> {
  switch (ctx.mode) {
    case "fusion":
      return await launchCursorFusion(ctx);
    case "local":
      return await launchCursorLocal(ctx);
    default: {
      const exhaustive: never = ctx.mode;
      throw new Error(`unknown launch mode: ${String(exhaustive)}`);
    }
  }
}
