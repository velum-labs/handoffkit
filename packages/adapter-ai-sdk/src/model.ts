import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";

import type { Handoff, ModelDecision } from "@warrant/handoff";

/**
 * Why a call left the local model. Deterministic and observable: an error
 * from the local provider, a context/token-length failure (classified from
 * the error), a prompt-size threshold, or sticky escalation after a prior
 * failure.
 */
export type EscalationReason =
  | "local-error"
  | "context-overflow"
  | "prompt-threshold"
  | "sticky";

export type HandoffModelConfig = {
  /** The model work starts on. */
  local: LanguageModelV3;
  /** The model work escalates to. */
  cloud: LanguageModelV3;
  /**
   * Escalate without trying local when the serialized prompt exceeds this
   * many bytes — the deterministic stand-in for "context too large".
   */
  maxLocalPromptBytes?: number;
  /**
   * Once escalated, stay on the cloud model for subsequent calls in this
   * model instance. Defaults to true: thrash-free and easier to reason
   * about than per-call retries.
   */
  sticky?: boolean;
  /** Observer for every routing decision (withModel wires this to h.trace). */
  onDecision?: (decision: ModelDecision) => void;
};

const OVERFLOW_PATTERN = /context|token|length|too.?(long|large)/i;

function classify(error: unknown): EscalationReason {
  const message = error instanceof Error ? error.message : String(error);
  return OVERFLOW_PATTERN.test(message) ? "context-overflow" : "local-error";
}

function promptBytes(options: LanguageModelV3CallOptions): number {
  try {
    return Buffer.byteLength(JSON.stringify(options.prompt), "utf8");
  } catch {
    return 0;
  }
}

/**
 * An AI SDK-compatible model that starts local and escalates to cloud
 * under deterministic, explainable conditions. Honest semantics:
 *
 * - Escalation happens *between* generate/stream calls (a failed local call
 *   is retried in full on the cloud model). There is no mid-generation
 *   handoff: once a stream has started emitting, it belongs to the model
 *   that produced it. A local stream that fails to *start* escalates; a
 *   stream that dies midway surfaces the error to the caller.
 * - Every routing decision is reported via onDecision, so a Handoff context
 *   can record it (`model.routed` trace events) and triggers.modelEscalated()
 *   can gate continuation.
 */
export class HandoffModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "warrant-handoff";
  readonly modelId: string;
  private readonly config: HandoffModelConfig;
  private escalatedSticky = false;

  constructor(config: HandoffModelConfig) {
    this.config = config;
    this.modelId = `local-first(${config.local.modelId} → ${config.cloud.modelId})`;
  }

  get supportedUrls(): LanguageModelV3["supportedUrls"] {
    return this.config.local.supportedUrls;
  }

  private decide(options: LanguageModelV3CallOptions): {
    model: LanguageModelV3;
    route: "local" | "cloud";
    escalated: boolean;
    reason: string;
  } {
    if (this.escalatedSticky) {
      return {
        model: this.config.cloud,
        route: "cloud",
        escalated: false,
        reason: "sticky escalation from an earlier local failure"
      };
    }
    const threshold = this.config.maxLocalPromptBytes;
    if (threshold !== undefined) {
      const bytes = promptBytes(options);
      if (bytes > threshold) {
        return {
          model: this.config.cloud,
          route: "cloud",
          escalated: true,
          reason: `prompt is ${bytes} bytes, over the local threshold of ${threshold}`
        };
      }
    }
    return {
      model: this.config.local,
      route: "local",
      escalated: false,
      reason: "local-first policy"
    };
  }

  private note(route: "local" | "cloud", escalated: boolean, reason: string): void {
    this.config.onDecision?.({
      model:
        route === "local" ? this.config.local.modelId : this.config.cloud.modelId,
      route,
      escalated,
      reason
    });
  }

  private markEscalated(): void {
    if (this.config.sticky ?? true) this.escalatedSticky = true;
  }

  async doGenerate(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3GenerateResult> {
    const decision = this.decide(options);
    if (decision.route === "cloud") {
      if (decision.escalated) this.markEscalated();
      this.note("cloud", decision.escalated, decision.reason);
      return this.config.cloud.doGenerate(options);
    }
    try {
      const result = await this.config.local.doGenerate(options);
      this.note("local", false, decision.reason);
      return result;
    } catch (error) {
      const why = classify(error);
      this.markEscalated();
      const reason = `local model failed (${why}): ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.note("cloud", true, reason);
      return this.config.cloud.doGenerate(options);
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3StreamResult> {
    const decision = this.decide(options);
    if (decision.route === "cloud") {
      if (decision.escalated) this.markEscalated();
      this.note("cloud", decision.escalated, decision.reason);
      return this.config.cloud.doStream(options);
    }
    try {
      const result = await this.config.local.doStream(options);
      this.note("local", false, decision.reason);
      return result;
    } catch (error) {
      const why = classify(error);
      this.markEscalated();
      const reason = `local model failed to start streaming (${why}): ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.note("cloud", true, reason);
      return this.config.cloud.doStream(options);
    }
  }
}

/** Create an escalating local-first model. */
export function handoffModel(config: HandoffModelConfig): HandoffModel {
  return new HandoffModel(config);
}

/**
 * The golden-shape composition for the model half: attach `h.model` to a
 * continuation context. Routing decisions land in the context's trace as
 * `model.routed` events, and escalations make triggers.modelEscalated()
 * fire for `h.needs(...)`.
 */
export function withModel<H extends Handoff>(
  h: H,
  config: Omit<HandoffModelConfig, "onDecision">
): H & { model: HandoffModel } {
  const model = handoffModel({
    ...config,
    onDecision: (decision) => h.noteModelDecision(decision)
  });
  return Object.assign(h, { model });
}
