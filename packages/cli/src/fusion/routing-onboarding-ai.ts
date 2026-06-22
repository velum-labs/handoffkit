/**
 * MLX-backed routing proposal for `fusionkit init`.
 *
 * Builds a prompt from {@link detectRoutingContext}, calls a local model, validates
 * the JSON response, and falls back to {@link proposeDeterministicRouting} when
 * MLX is unavailable or the model returns invalid config twice.
 */
import { MlxCapabilityError, mlxServer } from "@fusionkit/adapter-ai-sdk";
import type { MlxEnv } from "@fusionkit/adapter-ai-sdk";

import type { FusionRoutingConfig } from "../fusion-config.js";
import type { HostInfo } from "./local-catalog.js";
import { ownedMlxEnv } from "./mlx.js";
import {
  ROUTING_PROVIDER_KEY_ENVS,
  ROUTING_SCENARIO_DESCRIPTIONS,
  proposeDeterministicRouting,
  validateRoutingProposal
} from "./routing-onboarding.js";
import type { RoutingOnboardingDetection } from "./routing-onboarding.js";

/** Default local model for routing onboarding (fast on Apple Silicon). */
export const ROUTING_AI_MODEL = "mlx-community/Llama-3.2-1B-Instruct-4bit";

/** Injectable LLM call used by tests (prompt in, model text out). */
export type RoutingLlmGenerate = (prompt: string) => Promise<string>;

/** Result of probing whether MLX can serve the onboarding assistant. */
export type MlxReadiness = {
  available: boolean;
  reason?: string;
};

/** Thrown when the AI assistant cannot produce valid routing JSON. */
export class RoutingAiProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingAiProposalError";
  }
}

/**
 * Probe MLX availability using the same readiness path as init's local setup.
 */
export async function probeMlxReadiness(
  host: HostInfo,
  env: MlxEnv = ownedMlxEnv()
): Promise<MlxReadiness> {
  if (!host.appleSilicon) {
    return { available: false, reason: "local MLX requires Apple Silicon" };
  }
  try {
    await env.ensureProvisioned();
    return { available: true };
  } catch (error) {
    if (error instanceof MlxCapabilityError) {
      return { available: false, reason: error.message.split("\n")[0]?.trim() ?? error.message };
    }
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Build the system/user prompt sent to the local MLX model.
 */
export function buildRoutingPrompt(detection: RoutingOnboardingDetection): string {
  const claude = detection.subscriptions["claude-code"];
  const codex = detection.subscriptions.codex;
  const subscriptionLines = [
    `claude-code: ${claude.available ? (claude.expired ? "expired" : "available") : "absent"}`,
    `codex: ${codex.available ? (codex.expired ? "expired" : "available") : "absent"}`
  ];
  const keyLines = Object.entries(detection.apiKeys).map(
    ([env, present]) => `${env}: ${present ? "present" : "absent"}`
  );
  const localLines: string[] = [];
  if (detection.localPanelModels !== undefined && detection.localPanelModels.length > 0) {
    localLines.push(`local MLX panel models: ${detection.localPanelModels.join(", ")}`);
  }
  if (detection.ollama !== undefined) {
    localLines.push(
      detection.ollama.reachable
        ? `Ollama on :11434: ${detection.ollama.models.join(", ") || "(no models pulled)"}`
        : "Ollama on :11434: not reachable"
    );
  }
  const scenarioLines = Object.entries(ROUTING_SCENARIO_DESCRIPTIONS).map(
    ([key, description]) => `- ${key}: ${description}`
  );
  const providerLines = [
    ...Object.entries(ROUTING_PROVIDER_KEY_ENVS)
      .filter(([, keyEnv]) => keyEnv !== undefined)
      .map(([kind, keyEnv]) => `- ${kind} (env: ${keyEnv})`),
    "- mlx (local Apple Silicon; requires model HF repo id, no API key)",
    "- ollama (local OpenAI-compat on http://127.0.0.1:11434/v1, no API key)"
  ];

  return [
    "You are a configuration assistant for FusionKit Claude Code smart routing.",
    "Given the user's detected auth below, output ONLY a JSON object matching this shape:",
    '{ "routes": { "default": "providerId,modelId", "background": "...", "longContext": "...", "longContextThreshold": 60000, "reasoning": "...", "webSearch": "..." },',
    '  "providers": [{ "id": "providerId", "provider": "anthropic|openai|openrouter|deepseek|groq|google-gemini|mlx|ollama", "keyEnv": "ENV_VAR", "model": "HF_REPO_FOR_MLX" }] }',
    "",
    "Rules:",
    "- Route values are providerId,modelId (comma-separated).",
    "- Omit keyEnv for subscription-backed anthropic/openai providers (Claude Code / Codex login).",
    "- Omit keyEnv for mlx and ollama (local, no API key).",
    "- Include model (HF repo id) for mlx providers.",
    "- Include keyEnv for API-key providers. Never include secret values.",
    "- Only propose providers the user can actually use (subscriptions or present env vars).",
    "- Prefer claude-sonnet-4-5 for default when Claude auth exists.",
    "- If local models are available (MLX panel or Ollama), prefer them for background tasks (cheap, private, fast for small queries).",
    "",
    "Detected subscriptions:",
    ...subscriptionLines,
    "",
    "API keys (presence only):",
    ...keyLines,
    ...(localLines.length > 0 ? ["", "Local models:", ...localLines] : []),
    "",
    "Routing scenarios:",
    ...scenarioLines,
    "",
    "Provider kinds:",
    ...providerLines,
    "",
    "Respond with the JSON object only."
  ].join("\n");
}

/**
 * Extract a JSON object from a model response (raw JSON or fenced code block).
 */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new RoutingAiProposalError("model response did not contain a JSON object");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new RoutingAiProposalError(
      `model response was not valid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

/**
 * Parse and validate an AI routing response.
 *
 * @throws {@link RoutingAiProposalError} on parse/validation failure.
 */
export function parseAiRoutingResponse(text: string, source = "ai-routing"): FusionRoutingConfig {
  const raw = extractJsonObject(text);
  try {
    return validateRoutingProposal(raw, source);
  } catch (error) {
    throw new RoutingAiProposalError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Default MLX-backed generate function for routing onboarding.
 */
export async function defaultMlxGenerate(prompt: string): Promise<string> {
  const server = mlxServer({ model: ROUTING_AI_MODEL, structured: true });
  try {
    const result = await server.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    });
    const text = result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length === 0) {
      throw new RoutingAiProposalError("model returned an empty response");
    }
    return text;
  } finally {
    await server.stop();
  }
}

export type ProposeAiRoutingOptions = {
  generate?: RoutingLlmGenerate;
  maxAttempts?: number;
};

/**
 * Ask the local model for a routing config; retry once on validation failure.
 * Falls back to {@link proposeDeterministicRouting} after repeated failure.
 */
export async function proposeAiRouting(
  detection: RoutingOnboardingDetection,
  options: ProposeAiRoutingOptions = {}
): Promise<{ config: FusionRoutingConfig; source: "ai" | "deterministic" }> {
  const generate = options.generate ?? defaultMlxGenerate;
  const maxAttempts = options.maxAttempts ?? 2;
  const basePrompt = buildRoutingPrompt(detection);
  let lastError = "unknown error";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\nYour previous JSON was invalid because: ${lastError}\nRespond with corrected JSON only.`;
    try {
      const text = await generate(prompt);
      const config = parseAiRoutingResponse(text);
      return { config, source: "ai" };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { config: proposeDeterministicRouting(detection), source: "deterministic" };
}
