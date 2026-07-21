import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { spawnLogged, spawnTool, terminate, waitForOutput } from "@routekit/runtime";
import type { ToolLaunchContext } from "@routekit/tools";

import { cursorIdeEnv } from "./bridge-config.js";
import type { CursorBridgeModelDescriptor } from "./bridge-config.js";
import { startCursorBridge } from "./bridge.js";
import { resolveCursorkitCli } from "./cursorkit-path.js";
import { scaffoldCursorSubagents } from "./subagents.js";

function bridgeModels(ctx: ToolLaunchContext): CursorBridgeModelDescriptor[] {
  return ctx.spec.models.flatMap((model) => [
    {
      id: model.id,
      ...(model.label !== undefined ? { displayName: model.label } : {}),
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {})
    },
    ...(model.aliases ?? []).map((alias) => ({
      id: alias,
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {})
    }))
  ]);
}

export function cursorIdeInstructions(model: string): string {
  return `Cursor IDE is connected to the gateway. Choose "${model}" in the Agent model picker.`;
}

export function cursorInstructions(
  publicUrl: string,
  model: string,
  apiKey?: string
): string {
  return [
    "In Cursor Settings -> Models, enable Override OpenAI Base URL and set:",
    `  Override OpenAI Base URL : ${publicUrl}/v1/cursor`,
    `  Model name               : ${model}`,
    `  OpenAI API Key           : ${apiKey ?? "routekit-local"}`
  ].join("\n");
}

async function launchCursorCli(ctx: ToolLaunchContext): Promise<number> {
  const started = await startCursorBridge({
    gatewayUrl: ctx.spec.gatewayUrl,
    modelLabel: ctx.spec.defaultModel,
    models: bridgeModels(ctx),
    ...(ctx.spec.auth?.token !== undefined
      ? { apiKey: ctx.spec.auth.token }
      : {}),
    ...(ctx.spec.logsDir !== undefined
      ? { logFile: join(ctx.spec.logsDir, "cursor-bridge.log") }
      : {}),
    ...(ctx.spec.tls?.caCertPath !== undefined
      ? { caCertPath: ctx.spec.tls.caCertPath }
      : {}),
    log: ctx.log
  });
  const bridgeUrl = ctx.registerPort("cursor", started.port);
  ctx.registerDisposer(() => {
    ctx.unregisterPort("cursor");
    terminate(started.child);
  });
  ctx.prepareForPassthrough();
  return await spawnTool(
    "cursor-agent",
    ["--endpoint", bridgeUrl, "--model", ctx.spec.defaultModel, ...ctx.spec.args],
    {},
    ctx.spec.cwd
  );
}

async function launchCursorRemote(ctx: ToolLaunchContext): Promise<number> {
  const publicUrl = ctx.spec.publicUrl;
  if (publicUrl === undefined) {
    throw new Error("Cursor remote configuration requires a public gateway URL");
  }
  ctx.log(cursorInstructions(publicUrl, ctx.spec.defaultModel, ctx.spec.auth?.token));
  await new Promise<void>(() => {});
  return 0;
}

async function launchCursorIde(ctx: ToolLaunchContext): Promise<number> {
  const { serveCli } = resolveCursorkitCli();
  const repo = ctx.spec.cwd ?? process.cwd();
  const stateDir =
    ctx.spec.logsDir !== undefined
      ? join(ctx.spec.logsDir, "cursor-ide")
      : join(repo, ".cursor-rpc-ide");
  mkdirSync(stateDir, { recursive: true });
  const proc = spawnLogged(process.execPath, [serveCli, "ck"], {
    cwd: stateDir,
    env: cursorIdeEnv({
      repo,
      gatewayUrl: ctx.spec.gatewayUrl,
      modelLabel: ctx.spec.defaultModel,
      models: bridgeModels(ctx),
      ...(ctx.spec.auth?.token !== undefined ? { apiKey: ctx.spec.auth.token } : {}),
      ...(ctx.spec.tls?.caCertPath !== undefined
        ? { caCertPath: ctx.spec.tls.caCertPath }
        : {})
    }),
    ...(ctx.spec.logsDir !== undefined
      ? { logFile: join(ctx.spec.logsDir, "cursor-ide.log") }
      : {})
  });
  await waitForOutput(proc, /ck ready|bridge listening/, {
    timeoutMs: 60_000,
    label: "Cursor desktop bridge"
  });
  ctx.registerDisposer(() => terminate(proc.child));
  ctx.log(cursorIdeInstructions(ctx.spec.defaultModel));
  return await new Promise<number>((resolve) => {
    proc.child.once("exit", (code) => resolve(code ?? 0));
  });
}

export async function launchCursor(ctx: ToolLaunchContext): Promise<number> {
  const profiles = ctx.spec.agentProfiles ?? [];
  if (profiles.length > 0) {
    scaffoldCursorSubagents(ctx.spec.cwd ?? process.cwd(), profiles, ctx.log);
  }
  if (ctx.spec.ide === true) return launchCursorIde(ctx);
  if (ctx.spec.publicUrl !== undefined) return launchCursorRemote(ctx);
  return launchCursorCli(ctx);
}
