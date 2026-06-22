/**
 * Minimal routing config parsing (mirrors `@fusionkit/model-gateway` validation).
 */

import type {
  ParsedRouteTarget,
  RouteTargetSpec,
  RoutingProviderKind,
  RoutingProviderSpec,
  RoutingScenario,
  ScenarioRoutes
} from "./types";
import { ROUTING_PROVIDER_KINDS, ROUTING_SCENARIOS } from "./types";

export class RoutingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingConfigError";
  }
}

export class RoutingProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingProviderError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a `providerId,modelId` or bare model route target. */
export function parseRouteTarget(spec: RouteTargetSpec): ParsedRouteTarget {
  const trimmed = spec.trim();
  const comma = trimmed.indexOf(",");
  if (comma === -1) return { model: trimmed };
  const providerId = trimmed.slice(0, comma).trim();
  const model = trimmed.slice(comma + 1).trim();
  if (model.length === 0) throw new RoutingConfigError(`invalid route target "${spec}"`);
  return providerId.length > 0 ? { providerId, model } : { model };
}

/** Validate parsed routing routes from config. */
export function parseScenarioRoutes(raw: unknown, source: string): ScenarioRoutes {
  if (!isRecord(raw)) throw new RoutingConfigError(`${source}: routing must be an object`);
  if (typeof raw.default !== "string" || raw.default.trim().length === 0) {
    throw new RoutingConfigError(`${source}: routing.default must be a non-empty string`);
  }
  const routes: ScenarioRoutes = { default: raw.default.trim() };

  for (const key of ["background", "longContext", "reasoning", "webSearch"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RoutingConfigError(`${source}: routing.${key} must be a non-empty string`);
    }
    routes[key] = value.trim();
  }

  if (raw.longContextThreshold !== undefined) {
    if (
      typeof raw.longContextThreshold !== "number" ||
      !Number.isInteger(raw.longContextThreshold) ||
      raw.longContextThreshold <= 0
    ) {
      throw new RoutingConfigError(`${source}: routing.longContextThreshold must be a positive integer`);
    }
    routes.longContextThreshold = raw.longContextThreshold;
  }

  if (raw.fallbacks !== undefined) {
    if (!isRecord(raw.fallbacks)) {
      throw new RoutingConfigError(`${source}: routing.fallbacks must be an object`);
    }
    const fallbacks: Partial<Record<RoutingScenario, readonly RouteTargetSpec[]>> = {};
    for (const scenario of ROUTING_SCENARIOS) {
      const entry = raw.fallbacks[scenario];
      if (entry === undefined) continue;
      if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) {
        throw new RoutingConfigError(`${source}: routing.fallbacks.${scenario} must be a string array`);
      }
      fallbacks[scenario] = entry.map((item) => item.trim()).filter((item) => item.length > 0);
    }
    routes.fallbacks = fallbacks;
  }

  parseRouteTarget(routes.default);
  for (const scenario of ROUTING_SCENARIOS) {
    if (scenario === "default") continue;
    const spec = routes[scenario];
    if (spec !== undefined) parseRouteTarget(spec);
  }

  return routes;
}

/** Validate a provider spec from config. */
export function parseRoutingProviderSpec(raw: unknown, index: number): RoutingProviderSpec {
  if (!isRecord(raw)) {
    throw new RoutingProviderError(`routing.providers[${index}] must be an object`);
  }
  const { id, provider, baseUrl, keyEnv } = raw;
  if (typeof id !== "string" || id.length === 0) {
    throw new RoutingProviderError(`routing.providers[${index}].id must be a non-empty string`);
  }
  if (
    typeof provider !== "string" ||
    !(ROUTING_PROVIDER_KINDS as readonly string[]).includes(provider)
  ) {
    throw new RoutingProviderError(
      `routing.providers[${index}].provider must be one of ${ROUTING_PROVIDER_KINDS.join(", ")}`
    );
  }
  const kind = provider as RoutingProviderKind;
  const spec: RoutingProviderSpec = { id, provider: kind };
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== "string" || baseUrl.length === 0) {
      throw new RoutingProviderError(`routing.providers[${index}].baseUrl must be a non-empty string`);
    }
    spec.baseUrl = baseUrl;
  }
  if (keyEnv !== undefined) {
    if (typeof keyEnv !== "string" || keyEnv.length === 0) {
      throw new RoutingProviderError(`routing.providers[${index}].keyEnv must be a non-empty string`);
    }
    spec.keyEnv = keyEnv;
  }
  return spec;
}
