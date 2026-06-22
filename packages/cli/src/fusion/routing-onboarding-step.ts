/**
 * Interactive routing onboarding step for `fusionkit init`.
 */
import type { FusionRoutingConfig } from "../fusion-config.js";
import type { HostInfo } from "./local-catalog.js";
import { confirm, note, select, text } from "../ui/prompt.js";
import { canPromptInteractively, uiStream } from "../ui/runtime.js";
import { Spinner } from "../ui/spinner.js";
import { box, cyan, dim } from "../ui/theme.js";
import {
  detectRoutingContext,
  formatRoutingSection,
  proposeDeterministicRouting,
  validateRoutingProposal
} from "./routing-onboarding.js";
import { probeMlxReadiness, proposeAiRouting } from "./routing-onboarding-ai.js";
import type { RoutingLlmGenerate } from "./routing-onboarding-ai.js";
import { probeOllama } from "./ollama.js";

const out = uiStream();

export type RoutingOnboardingStepInput = {
  host: HostInfo;
  /** When true, enable routing and prefer the AI assistant when MLX is ready. */
  aiRouting?: boolean;
  /** Injectable LLM for tests. */
  generate?: RoutingLlmGenerate;
  /** Injectable MLX probe for tests. */
  probeMlx?: typeof probeMlxReadiness;
  /** Injectable Ollama probe for tests. */
  probeOllama?: typeof probeOllama;
  /** Local MLX panel model repo ids from the committed panel. */
  localPanelModels?: string[];
  /** Fixed prompt answers for non-TTY tests. */
  promptOverrides?: {
    enableRouting?: boolean;
    preferAi?: boolean;
    action?: "accept" | "edit" | "skip";
  };
};

export type RoutingOnboardingStepResult = {
  routing?: FusionRoutingConfig;
  usedAi: boolean;
  fellBackToDefaults: boolean;
};

/**
 * Optional smart-routing setup: detect auth, propose config (AI or deterministic),
 * confirm with the user, and return the routing section to merge into fusion.json.
 */
export async function runRoutingOnboardingStep(
  input: RoutingOnboardingStepInput
): Promise<RoutingOnboardingStepResult> {
  const probe = input.probeMlx ?? probeMlxReadiness;
  const ollamaProbe = input.probeOllama ?? probeOllama;
  const detection = detectRoutingContext(process.env);
  detection.localPanelModels = input.localPanelModels;
  detection.ollama = await ollamaProbe();
  if (detection.ollama.reachable && detection.ollama.models.length > 0) {
    note(`Ollama detected (${detection.ollama.models.length} model(s) on :11434)`);
  }

  const enableRouting =
    input.promptOverrides?.enableRouting ??
    (input.aiRouting === true ||
      (canPromptInteractively() &&
        (await confirm({
          message: "Add smart routing for Claude Code?",
          defaultValue: false
        }))));

  if (!enableRouting) {
    return { usedAi: false, fellBackToDefaults: false };
  }

  const mlx = await probe(input.host);
  let usedAi = false;
  let fellBackToDefaults = false;
  let proposal: FusionRoutingConfig;

  const preferAi =
    input.promptOverrides?.preferAi ??
    (mlx.available &&
      (input.aiRouting === true ||
        (canPromptInteractively() &&
          (await confirm({
            message: "Use local AI assistant to propose routing?",
            defaultValue: false
          })))));

  if (preferAi && mlx.available) {
    const spinner = new Spinner("asking local model for routing suggestions").start();
    const result = await proposeAiRouting(detection, {
      ...(input.generate !== undefined ? { generate: input.generate } : {})
    });
    proposal = result.config;
    usedAi = result.source === "ai";
    fellBackToDefaults = result.source === "deterministic";
    if (fellBackToDefaults) {
      spinner.warn("AI assistant didn't produce valid config; using defaults");
    } else {
      spinner.succeed("routing proposal ready");
    }
  } else {
    if (!mlx.available && input.aiRouting === true) {
      note(
        mlx.reason !== undefined
          ? `local MLX unavailable (${mlx.reason}); using deterministic defaults`
          : "local MLX unavailable; using deterministic defaults"
      );
    }
    proposal = proposeDeterministicRouting(detection);
    fellBackToDefaults = true;
  }

  out.write(`\n${box("proposed routing", formatRoutingSection(proposal).split("\n"))}\n`);

  if (canPromptInteractively() && input.promptOverrides?.action === undefined) {
    const action = await select<"accept" | "edit" | "skip">({
      message: "Routing setup",
      options: [
        { value: "accept", label: "accept proposal", hint: "write routing to fusion.json" },
        { value: "edit", label: "edit JSON", hint: "tweak routes or providers before saving" },
        { value: "skip", label: "skip routing", hint: "continue without a routing section" }
      ],
      defaultIndex: 0
    });

    if (action === "skip") {
      return { usedAi, fellBackToDefaults };
    }

    if (action === "edit") {
      const edited = await text({
        message: "Routing JSON (routes + providers)",
        defaultValue: JSON.stringify(proposal, null, 2)
      });
      try {
        proposal = validateRoutingProposal(JSON.parse(edited) as unknown, "edited-routing");
      } catch (error) {
        note(
          `invalid routing JSON (${error instanceof Error ? error.message : String(error)}); keeping the proposal`
        );
      }
    }
  } else if (input.promptOverrides?.action === "skip") {
    return { usedAi, fellBackToDefaults };
  } else if (input.promptOverrides?.action === "edit") {
    // Non-interactive edit override keeps the proposal as-is (used only in tests).
  }

  note(`routing will be saved under ${cyan("routing")} in fusion.json`);
  return { routing: proposal, usedAi, fellBackToDefaults };
}
