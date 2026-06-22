/**
 * Claude Code Router scenario detection and route resolution.
 *
 * Ported from claude-code-router (MIT): five scenarios, tiktoken-based long
 * context detection, per-project overrides, and fallback chain resolution.
 */

import { getEncoding } from "js-tiktoken";

import type { AnthropicRequest } from "../adapters/anthropic.js";
import { anthropicToChat } from "../adapters/anthropic.js";

import type {
  ParsedRouteTarget,
  RouteTargetSpec,
  RoutableAnthropicRequest,
  RoutableChatRequest,
  RoutingDecision,
  RoutingScenario,
  ScenarioRoutes
} from "./types.js";
import {
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  ROUTING_SCENARIOS
} from "./types.js";

export class RoutingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingConfigError";
  }
}

let encoder: ReturnType<typeof getEncoding> | undefined;

function tiktoken(): ReturnType<typeof getEncoding> {
  encoder ??= getEncoding("cl100k_base");
  return encoder;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") return part.text;
      if (isRecord(part) && part.type === "tool_use") return JSON.stringify(part.input ?? {});
      if (isRecord(part) && part.type === "tool_result") {
        return textOfContent(part.content);
      }
      return "";
    })
    .join("\n");
}

function systemText(system: RoutableAnthropicRequest["system"]): string {
  if (system === undefined) return "";
  if (typeof system === "string") return system;
  return system.map((block) => block.text ?? "").join("\n");
}

function toolNames(tools: RoutableChatRequest["tools"] | RoutableAnthropicRequest["tools"]): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (!isRecord(tool)) return undefined;
      if (typeof tool.name === "string") return tool.name;
      if ("function" in tool) {
        const fn = tool.function;
        if (isRecord(fn) && typeof fn.name === "string") return fn.name;
      }
      return undefined;
    })
    .filter((name): name is string => name !== undefined);
}

const WEB_SEARCH_TOOL_PATTERN =
  /^(web[_-]?search|web[_-]?fetch|WebSearch|WebFetch|browser|internet_search)$/i;

/** True when the request carries a web search / fetch tool. */
export function hasWebSearchTools(
  request: RoutableChatRequest | RoutableAnthropicRequest
): boolean {
  return toolNames(request.tools).some((name) => WEB_SEARCH_TOOL_PATTERN.test(name));
}

/** True when extended thinking / reasoning mode is active. */
export function isReasoningRequest(
  request: RoutableChatRequest | RoutableAnthropicRequest
): boolean {
  if (isRecord(request.thinking) && request.thinking.type === "enabled") return true;
  if (isRecord(request.thinking) && typeof request.thinking.budget_tokens === "number") {
    return request.thinking.budget_tokens > 0;
  }
  const chat = request as RoutableChatRequest;
  if (typeof chat.reasoning_effort === "string" && chat.reasoning_effort.length > 0) return true;
  const model = request.model ?? "";
  return /thinking|reason/i.test(model);
}

/** True for background-agent style requests (CCR metadata heuristics). */
export function isBackgroundRequest(
  request: RoutableChatRequest | RoutableAnthropicRequest,
  headers: Record<string, string | string[] | undefined> = {}
): boolean {
  const model = (request.model ?? "").toLowerCase();
  if (model.includes("background")) return true;

  const agentType = headerValue(headers, "x-ccr-agent-type") ?? headerValue(headers, "x-agent-type");
  if (agentType !== undefined && /background/i.test(agentType)) return true;

  const combined = extractRequestText(request).toLowerCase();
  return combined.includes("<background_task>") || combined.includes("background agent");
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

/** Concatenate all textual content from a chat or Anthropic request. */
export function extractRequestText(
  request: RoutableChatRequest | RoutableAnthropicRequest
): string {
  const parts: string[] = [];
  const anthropic = request as RoutableAnthropicRequest;
  parts.push(systemText(anthropic.system));
  for (const message of request.messages ?? []) {
    parts.push(textOfContent(message.content));
    if (Array.isArray(message.tool_calls)) {
      parts.push(JSON.stringify(message.tool_calls));
    }
  }
  if (Array.isArray(request.tools)) parts.push(JSON.stringify(request.tools));
  return parts.filter((part) => part.length > 0).join("\n\n");
}

/** Count tokens with tiktoken (`cl100k_base`), matching claude-code-router. */
export function countRequestTokens(
  request: RoutableChatRequest | RoutableAnthropicRequest
): number {
  const text = extractRequestText(request);
  if (text.length === 0) return 1;
  return Math.max(1, tiktoken().encode(text).length);
}

/**
 * Parse a route target spec (`provider,model` or bare `model`).
 *
 * @throws {@link RoutingConfigError} on empty input.
 */
export function parseRouteTarget(spec: RouteTargetSpec): ParsedRouteTarget {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new RoutingConfigError("route target must be non-empty");
  const comma = trimmed.indexOf(",");
  if (comma < 0) return { model: trimmed };
  const providerId = trimmed.slice(0, comma).trim();
  const model = trimmed.slice(comma + 1).trim();
  if (providerId.length === 0 || model.length === 0) {
    throw new RoutingConfigError(`invalid route target "${spec}" (expected provider,model)`);
  }
  return { providerId, model };
}

function routeForScenario(routes: ScenarioRoutes, scenario: RoutingScenario): RouteTargetSpec {
  if (scenario === "default") return routes.default;
  const value = routes[scenario];
  if (value !== undefined) return value;
  return routes.default;
}

/** Ordered targets for a scenario: primary then configured fallbacks. */
export function fallbackChain(
  routes: ScenarioRoutes,
  scenario: RoutingScenario
): ParsedRouteTarget[] {
  const primary = parseRouteTarget(routeForScenario(routes, scenario));
  const extras = routes.fallbacks?.[scenario] ?? routes.fallbacks?.default ?? [];
  const chain = [primary, ...extras.map((spec) => parseRouteTarget(spec))];
  const seen = new Set<string>();
  return chain.filter((target) => {
    const key = `${target.providerId ?? ""}:${target.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Detect the routing scenario for an incoming request.
 *
 * Priority (matches claude-code-router): webSearch → reasoning → longContext →
 * background → default.
 */
export function detectRoutingScenario(
  request: RoutableChatRequest | RoutableAnthropicRequest,
  routes: ScenarioRoutes,
  options: {
    tokenCount?: number;
    headers?: Record<string, string | string[] | undefined>;
  } = {}
): { scenario: RoutingScenario; tokenCount: number; reason: string } {
  const tokenCount = options.tokenCount ?? countRequestTokens(request);
  const threshold = routes.longContextThreshold ?? DEFAULT_LONG_CONTEXT_THRESHOLD;

  if (hasWebSearchTools(request)) {
    return { scenario: "webSearch", tokenCount, reason: "request includes web search tools" };
  }
  if (isReasoningRequest(request)) {
    return { scenario: "reasoning", tokenCount, reason: "extended thinking / reasoning mode" };
  }
  if (tokenCount > threshold) {
    return {
      scenario: "longContext",
      tokenCount,
      reason: `token count ${tokenCount} exceeds threshold ${threshold}`
    };
  }
  if (isBackgroundRequest(request, options.headers ?? {})) {
    return { scenario: "background", tokenCount, reason: "background agent request" };
  }
  return { scenario: "default", tokenCount, reason: "standard request" };
}

/**
 * Resolve the primary routing decision for a request (fallback index 0).
 */
export function resolveRoutingDecision(
  request: RoutableChatRequest | RoutableAnthropicRequest,
  routes: ScenarioRoutes,
  options: {
    headers?: Record<string, string | string[] | undefined>;
  } = {}
): RoutingDecision {
  const detected = detectRoutingScenario(request, routes, options);
  const chain = fallbackChain(routes, detected.scenario);
  const target = chain[0];
  if (target === undefined) {
    throw new RoutingConfigError(`no route configured for scenario "${detected.scenario}"`);
  }
  return {
    scenario: detected.scenario,
    target,
    tokenCount: detected.tokenCount,
    reason: detected.reason,
    fallbackIndex: 0
  };
}

/** Resolve a decision at a specific fallback index (for retry after provider failure). */
export function resolveRoutingFallback(
  decision: RoutingDecision,
  routes: ScenarioRoutes,
  nextIndex: number
): RoutingDecision | undefined {
  const chain = fallbackChain(routes, decision.scenario);
  const target = chain[nextIndex];
  if (target === undefined) return undefined;
  return { ...decision, target, fallbackIndex: nextIndex };
}

/** Convert an Anthropic request to the chat shape used for routing detection. */
export function anthropicRequestForRouting(body: AnthropicRequest): RoutableAnthropicRequest {
  return body;
}

/** Route an Anthropic body through chat translation for token counting parity. */
export function countAnthropicTokens(body: AnthropicRequest): number {
  const chat = anthropicToChat(body, body.model);
  return countRequestTokens(chat as RoutableChatRequest);
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

  // Validate targets parse cleanly.
  parseRouteTarget(routes.default);
  for (const scenario of ROUTING_SCENARIOS) {
    if (scenario === "default") continue;
    const spec = routes[scenario];
    if (spec !== undefined) parseRouteTarget(spec);
  }

  return routes;
}
