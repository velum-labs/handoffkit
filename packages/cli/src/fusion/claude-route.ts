/**
 * `fusionkit claude --route` — smart Claude Code proxy with scenario routing.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeEnv } from "@fusionkit/tool-claude";
import { spawnTool } from "@fusionkit/tools";

import { loadFusionConfig } from "../fusion-config.js";
import type { FusionConfig, FusionRoutingConfig } from "../fusion-config.js";
import { createPortlessSession } from "../shared/portless.js";
import { portlessEnabled } from "../fusion-quickstart.js";
import { bold, brandBanner, dim, glyph, green } from "../ui/theme.js";
import { uiStream } from "../ui/runtime.js";
import { gitToplevel, loadEnvFileInto } from "./env.js";
import type { RunFusionOptions } from "./env.js";
import {
  loadRoutingConfig,
  printRoutingPreview,
  requireRoutingConfig,
  routingFromPanel,
  sampleRoutingBody,
  startClaudeRoutingGateway
} from "./routing.js";

export type RunClaudeRouteOptions = RunFusionOptions & {
  /** Print routing decision without starting the gateway or Claude. */
  dryRun?: boolean;
  /** Sample prompt text for dry-run preview. */
  previewText?: string;
};

function resolveRouting(repoRoot: string, config: FusionConfig | undefined): FusionRoutingConfig {
  const fromFile = loadRoutingConfig(repoRoot);
  if (fromFile !== undefined) return fromFile;
  if (config !== undefined) {
    const fromPanel = routingFromPanel(config);
    if (fromPanel !== undefined) return fromPanel;
  }
  return requireRoutingConfig(repoRoot);
}

/**
 * Run Claude Code backed by a smart routing gateway (claude-code-router semantics).
 */
export async function runClaudeRoute(
  toolArgs: string[],
  options: RunClaudeRouteOptions = {}
): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const repoRoot = options.repo ?? gitToplevel(process.cwd()) ?? process.cwd();
  loadEnvFileInto(join(process.cwd(), ".env"), process.env);
  if (repoRoot !== process.cwd()) loadEnvFileInto(join(repoRoot, ".env"), process.env);

  let fusionConfig: FusionConfig | undefined;
  try {
    fusionConfig = loadFusionConfig(repoRoot);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const routing = resolveRouting(repoRoot, fusionConfig);

  if (options.dryRun === true) {
    const body = sampleRoutingBody(options.previewText ?? "Explain this codebase.");
    printRoutingPreview(routing.routes, body, log);
    return 0;
  }

  const root = mkdtempSync(join(tmpdir(), "fusionkit-claude-route-"));
  const logsDir = join(root, "logs");
  mkdirSync(logsDir, { recursive: true });

  const portless = await createPortlessSession({
    enabled: portlessEnabled(options),
    log
  });

  const disposers: Array<() => Promise<void> | void> = [];
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        // best-effort
      }
    }
  };

  process.once("SIGINT", () => void cleanup().then(() => process.exit(130)));
  process.once("SIGTERM", () => void cleanup().then(() => process.exit(143)));

  log(`fusion: claude router (${routing.providers.map((p) => p.id).join(", ")})`);

  const gateway = await startClaudeRoutingGateway({
    routing,
    port: options.port,
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
    onDecision: (decision) => log(`routing: ${decision.scenario} -> ${decision.target.providerId},${decision.target.model}`)
  });
  disposers.push(() => gateway.close());

  const registered = await portless.register("claude-router", gateway.port());
  const gatewayUrl = registered.url;
  disposers.push(() => portless.unregister("claude-router"));

  if (uiStream().isTTY) {
    uiStream().write(
      `\n${brandBanner("claude router")}\n` +
        `${green(glyph.tick())} ${bold("routing gateway ready")}  ${dim(gatewayUrl)}\n` +
        `${dim(`providers: ${routing.providers.map((p) => p.id).join(", ")}`)}\n\n`
    );
  } else {
    log(`fusion: routing gateway on ${gatewayUrl}`);
  }

  try {
    return await spawnTool(
      "claude",
      toolArgs,
      claudeEnv(gatewayUrl, options.authToken),
      repoRoot
    );
  } finally {
    await cleanup();
  }
}
