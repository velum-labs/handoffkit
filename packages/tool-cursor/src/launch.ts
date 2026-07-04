import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveCursorkitCli } from "@fusionkit/ensemble";
import { spawnLogged, spawnTool, terminate, waitForOutput } from "@fusionkit/tools";
import type { ToolLaunchContext } from "@fusionkit/tools";

import { cursorIdeEnv } from "./bridge-config.js";
import { startCursorBridge } from "./bridge.js";

/** Human-facing setup for the turnkey Cursor IDE (desktop proxy) flow. */
export function cursorIdeInstructions(model: string): string {
  return [
    "Cursor IDE is being wired to the fusion ensemble via the bundled cursorkit",
    "desktop proxy — local-only, no public tunnel and no Settings changes. An",
    "isolated Cursor window will open on this repo.",
    "",
    `  In the Agent model picker, choose: ${model}`,
    "",
    "Your normal Cursor profile and its built-in models are untouched; the",
    "isolated window adds the fusion model additively. Leave this process running",
    "while you use Cursor. Ctrl+C to stop."
  ].join("\n");
}

/** Human-facing setup for Cursor (IDE plan/chat panel only; needs a public URL). */
export function cursorInstructions(
  publicUrl: string,
  model: string,
  fusedModels: readonly string[] = []
): string {
  const otherFused = fusedModels.filter((id) => id !== model);
  return [
    "Cursor backs only its plan/chat panel with a custom model, and cannot reach",
    "localhost — so this uses a public tunnel. In Cursor: Settings -> Models ->",
    "enable 'Override OpenAI Base URL', then set:",
    "",
    `  Override OpenAI Base URL : ${publicUrl}/v1`,
    `  Model name               : ${model}`,
    `  OpenAI API Key           : fusionkit-local (any non-empty value)`,
    ...(otherFused.length > 0
      ? [
          "",
          `Other registered ensembles work as model names too: ${otherFused.join(", ")}.`
        ]
      : []),
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
    ...(ctx.fusedModels !== undefined ? { fusedModels: ctx.fusedModels } : {}),
    ...(ctx.nativeModels !== undefined ? { nativeModels: ctx.nativeModels } : {}),
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
  ctx.log(cursorInstructions(publicUrl, ctx.modelLabel, ctx.fusedModels ?? []));
  ctx.log("");
  ctx.log("Gateway is running; leave this process up while you use Cursor. Ctrl+C to stop.");
  await new Promise<void>(() => {
    /* keep the gateway (and tunnel target) alive */
  });
  return 0;
}

/**
 * Turnkey Cursor IDE launch: drive cursorkit's bundled desktop launcher (`ck`),
 * which starts the local TLS desktop proxy + a loopback CONNECT proxy and opens
 * an isolated Cursor app pre-wired to it. The fused model (and each native panel
 * member) is seeded into that isolated profile pointed at the gateway, so the
 * user only picks the model in Cursor's Agent picker. No public tunnel, no
 * Settings override, no system routing changes. Works in both fusion and local
 * mode (both expose a gateway URL).
 */
async function launchCursorIde(ctx: ToolLaunchContext): Promise<number> {
  const { serveCli } = resolveCursorkitCli();
  const repo = ctx.repo ?? process.cwd();
  // Keep ck's certs/state/logs in a scratch dir (the session logs dir when one
  // exists) so we never write a `.cursor-rpc/` folder into the user's repo, and
  // open the real repo as the Cursor workspace via CK_WORKSPACE_PATH.
  const stateDir = ctx.logsDir !== undefined ? join(ctx.logsDir, "cursor-ide") : join(repo, ".cursor-rpc-ide");
  mkdirSync(stateDir, { recursive: true });

  const env = cursorIdeEnv({
    repo,
    gatewayUrl: ctx.gatewayUrl,
    modelLabel: ctx.modelLabel,
    ...(ctx.fusedModels !== undefined ? { fusedModels: ctx.fusedModels } : {}),
    ...(ctx.nativeModels !== undefined ? { nativeModels: ctx.nativeModels } : {}),
    ...(ctx.authToken !== undefined ? { apiKey: ctx.authToken } : {}),
    ...(ctx.caCertPath !== undefined ? { caCertPath: ctx.caCertPath } : {})
  });

  const proc = spawnLogged(process.execPath, [serveCli, "ck"], {
    cwd: stateDir,
    env,
    ...(ctx.logsDir !== undefined ? { logFile: join(ctx.logsDir, "cursor-ide.log") } : {})
  });
  try {
    await waitForOutput(proc, /ck ready|bridge listening/, {
      timeoutMs: 60_000,
      label: "Cursor desktop bridge"
    });
  } catch (error) {
    terminate(proc.child);
    throw error instanceof Error ? error : new Error(String(error));
  }
  ctx.registerDisposer(() => terminate(proc.child));

  ctx.log("");
  ctx.log(cursorIdeInstructions(ctx.modelLabel));
  ctx.log("");
  ctx.log(`fusion: Cursor IDE desktop proxy running (state: ${stateDir})`);
  // Hold the gateway up for the life of the desktop session; resolve when the
  // ck process (desktop proxy) exits.
  return await new Promise<number>((resolve) => {
    proc.child.once("exit", (code) => resolve(code ?? 0));
  });
}

/** Boot Cursor, branching on whether it backs the fusion panel or a local model. */
export async function launchCursor(ctx: ToolLaunchContext): Promise<number> {
  if (ctx.ide === true) {
    return await launchCursorIde(ctx);
  }
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
