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
  /**
   * Override the overflow classifier. Providers do not standardize
   * context-overflow errors, so the default is a message heuristic; supply
   * a provider-specific predicate when you know the exact error shape.
   */
  isContextOverflow?: (error: unknown) => boolean;
};

// Providers report context overflow as free-text error messages with no
// standard code, so a message heuristic is the only provider-agnostic
// default. Either reason escalates to cloud; the classification only
// affects the recorded reason. Override via config.isContextOverflow.
const OVERFLOW_PATTERN = /context|token|length|too.?(long|large)/i;

function classify(
  error: unknown,
  isOverflow?: (error: unknown) => boolean
): EscalationReason {
  if (isOverflow) return isOverflow(error) ? "context-overflow" : "local-error";
  const message = error instanceof Error ? error.message : String(error);
  return OVERFLOW_PATTERN.test(message) ? "context-overflow" : "local-error";
}

/**
 * Deterministic proxy for prompt size: the byte length of the serialized
 * prompt. The threshold gate needs a cheap, stable measure that correlates
 * with token count, not an exact tokenizer (which would be model-specific).
 */
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

  /**
   * The one dispatch shared by doGenerate and doStream: route per `decide`,
   * try local, classify a local failure, escalate to cloud, and report
   * every decision. The two entry points differ only in which provider
   * method runs and how a local failure is phrased.
   */
  private async dispatch<T>(
    options: LanguageModelV3CallOptions,
    call: (model: LanguageModelV3) => PromiseLike<T>,
    localFailurePhrase: string
  ): Promise<T> {
    const decision = this.decide(options);
    if (decision.route === "cloud") {
      if (decision.escalated) this.markEscalated();
      this.note("cloud", decision.escalated, decision.reason);
      return call(this.config.cloud);
    }
    try {
      const result = await call(this.config.local);
      this.note("local", false, decision.reason);
      return result;
    } catch (error) {
      const why = classify(error, this.config.isContextOverflow);
      this.markEscalated();
      const reason = `${localFailurePhrase} (${why}): ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.note("cloud", true, reason);
      return call(this.config.cloud);
    }
  }

  async doGenerate(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3GenerateResult> {
    return this.dispatch(options, (model) => model.doGenerate(options), "local model failed");
  }

  async doStream(
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3StreamResult> {
    return this.dispatch(
      options,
      (model) => model.doStream(options),
      "local model failed to start streaming"
    );
  }
}

/** Create an escalating local-first model. */
export function handoffModel(config: HandoffModelConfig): HandoffModel {
  return new HandoffModel(config);
}

/**
 * Attach a model to a continuation context as `h.model`. The single
 * golden-shape attach used by both `withModel` and `withRoutedModel`;
 * decision-to-trace mapping stays with each adapter, the composition does
 * not.
 */
export function attachModel<H extends Handoff, M>(h: H, model: M): H & { model: M } {
  return Object.assign(h, { model });
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
  return attachModel(
    h,
    handoffModel({
      ...config,
      onDecision: (decision) => h.noteModelDecision(decision)
    })
  );
}
