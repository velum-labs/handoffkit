/**
 * Claude Code smart routing for FusionKit.
 *
 * Loads routing config from `.fusionkit/fusion.json` (and optional per-project
 * overrides), starts a {@link RoutingBackend} gateway, and exposes helpers for
 * the `fusionkit claude --route` command.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RoutingBackend,
  formatRoutingDecision,
  parseScenarioRoutes,
  previewRoutingForAnthropic,
  startGateway
} from "@fusionkit/model-gateway";
import type { Gateway, RoutingDecision, ScenarioRoutes } from "@fusionkit/model-gateway";

import { fusionConfigDir, loadFusionConfig } from "../fusion-config.js";
import type { FusionConfig, FusionRoutingConfig } from "../fusion-config.js";
import { mergeRoutingProviders } from "./providers/index.js";

export const ROUTING_OVERRIDE_BASENAME = "routing.override.json";

/** Per-repo routing override file (merged over `fusion.json` routes). */
export function routingOverridePath(repoRoot: string): string {
  return join(fusionConfigDir(repoRoot), ROUTING_OVERRIDE_BASENAME);
}

/**
 * Load routing config: base from `fusion.json`, routes shallow-merged with
 * `.fusionkit/routing.override.json` when present.
 */
export function loadRoutingConfig(repoRoot: string): FusionRoutingConfig | undefined {
  const fusion = loadFusionConfig(repoRoot);
  if (fusion?.routing === undefined) return undefined;

  const overridePath = routingOverridePath(repoRoot);
  if (!existsSync(overridePath)) {
    return {
      routes: fusion.routing.routes,
      providers: mergeRoutingProviders(fusion.routing.providers, fusion.panel)
    };
  }

  let overrideRaw: unknown;
  try {
    overrideRaw = JSON.parse(readFileSync(overridePath, "utf8"));
  } catch (error) {
    throw new Error(
      `${overridePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }

  const overrideRoutes =
    overrideRaw !== null && typeof overrideRaw === "object" && !Array.isArray(overrideRaw)
      ? parseScenarioRoutes(overrideRaw, overridePath)
      : undefined;

  const routes: ScenarioRoutes = overrideRoutes ?? fusion.routing.routes;
  return {
    routes,
    providers: mergeRoutingProviders(fusion.routing.providers, fusion.panel)
  };
}

/** Require routing config or throw a actionable error. */
export function requireRoutingConfig(repoRoot: string): FusionRoutingConfig {
  const routing = loadRoutingConfig(repoRoot);
  if (routing === undefined) {
    throw new Error(
      "no routing config found — add a `routing` section to .fusionkit/fusion.json " +
        "(see `fusionkit init` or docs) or pass explicit --model specs"
    );
  }
  return routing;
}

export type StartClaudeRoutingGatewayInput = {
  routing: FusionRoutingConfig;
  host?: string;
  port?: number;
  authToken?: string;
  onDecision?: (decision: RoutingDecision) => void;
};

/** Boot a Claude Code routing gateway (Anthropic surface + smart backend). */
export async function startClaudeRoutingGateway(
  input: StartClaudeRoutingGatewayInput
): Promise<Gateway> {
  const backend = new RoutingBackend({
    routes: input.routing.routes,
    providers: input.routing.providers,
    ...(input.onDecision !== undefined ? { onDecision: input.onDecision } : {})
  });
  return await startGateway({
    backend,
    host: input.host ?? "127.0.0.1",
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.authToken !== undefined ? { authToken: input.authToken } : {})
  });
}

/** Print a routing dry-run summary for a sample Anthropic-shaped body. */
export function printRoutingPreview(
  routes: ScenarioRoutes,
  body: Parameters<typeof previewRoutingForAnthropic>[0],
  log: (line: string) => void = (line) => console.error(line)
): RoutingDecision {
  const decision = previewRoutingForAnthropic(body, routes);
  log(`routing: ${formatRoutingDecision(decision)}`);
  return decision;
}

/** Build a minimal sample request for routing preview when no body is supplied. */
export function sampleRoutingBody(text: string): {
  model: string;
  messages: Array<{ role: "user"; content: string }>;
} {
  return {
    model: "claude-sonnet-4-5",
    messages: [{ role: "user", content: text }]
  };
}

/** Infer a minimal routing config from panel entries when fusion.json has no routing section. */
export function routingFromPanel(config: FusionConfig): FusionRoutingConfig | undefined {
  if (config.routing !== undefined) {
    return {
      routes: config.routing.routes,
      providers: mergeRoutingProviders(config.routing.providers, config.panel)
    };
  }
  const panel = config.panel;
  if (panel === undefined || panel.length === 0) return undefined;
  const primary = panel[0];
  if (primary === undefined) return undefined;
  const providers = mergeRoutingProviders([], panel);
  if (providers.length === 0) return undefined;
  return {
    routes: { default: `${primary.id},${primary.model}` },
    providers
  };
}

export {
  formatRoutingDecision,
  previewRoutingForAnthropic,
  previewRoutingForChat
} from "@fusionkit/model-gateway";

export type { RoutingDecision, ScenarioRoutes } from "@fusionkit/model-gateway";
