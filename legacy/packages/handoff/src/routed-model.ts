import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";
import { z } from "zod";

import type { Handoff } from "./handoff.js";

import { attachModel } from "./model.js";

/**
 * UniRoute routing over a pool of models (arXiv:2502.08773).
 *
 * The router is a *router card* — a portable `uniroute.router.v1` JSON
 * artifact produced offline by the Python `uniroute-mlx` package (see
 * python/uniroute-mlx): a prompt-cluster assignment map plus, per candidate
 * model, its per-cluster error vector Psi and per-prompt cost. Routing a
 * call is: embed the prompt, derive cluster weights, and pick
 * argmin_m [ Phi(x) . Psi(m) + lambda * cost(m) ].
 *
 * All fitting and evaluation lives in Python; this file only ports that
 * one online rule. Candidates are ordinary LanguageModelV3 instances —
 * typically `mlxServer(...)` managed processes plus a cloud model — so the
 * existing lifecycle (lazy start, scale-to-zero, crash recovery) is reused
 * untouched.
 *
 * Honest semantics, mirroring HandoffModel: a failed call on the chosen
 * model falls back to the next-best candidate *between* calls; once a
 * stream has started emitting, it belongs to the model that produced it.
 */

const cardModelSchema = z.object({
  id: z.string().min(1),
  psi: z.array(z.number()).min(1),
  cost: z.number().nonnegative()
});

const routerCardSchema = z.object({
  version: z.literal("uniroute.router.v1"),
  embedder: z.object({ model: z.string().min(1), dims: z.number().int().positive() }),
  lambda: z.number().nonnegative(),
  assignment: z.union([
    z.object({ type: z.literal("centroids"), centroids: z.array(z.array(z.number())).min(1) }),
    z.object({ type: z.literal("softmax"), theta: z.array(z.array(z.number())).min(1) })
  ]),
  models: z.array(cardModelSchema).min(1)
});

export type RouterCard = z.infer<typeof routerCardSchema>;

/** Parse and structurally validate a router card (e.g. from readFile + JSON.parse). */
export function loadRouterCard(data: unknown): RouterCard {
  const card = routerCardSchema.parse(data);
  const rows = card.assignment.type === "centroids"
    ? card.assignment.centroids
    : card.assignment.theta;
  // softmax theta carries a trailing bias column on top of the embedding dims.
  const expectedWidth =
    card.assignment.type === "centroids" ? card.embedder.dims : card.embedder.dims + 1;
  for (const row of rows) {
    if (row.length !== expectedWidth) {
      throw new Error(
        `router card assignment width ${row.length} does not match embedder dims ${card.embedder.dims}`
      );
    }
  }
  const clusters = rows.length;
  for (const model of card.models) {
    if (model.psi.length !== clusters) {
      throw new Error(
        `router card model ${model.id} has psi length ${model.psi.length}, expected ${clusters}`
      );
    }
  }
  return card;
}

/** One routing decision, reported for every call (including fallbacks). */
export type RouteDecision = {
  /** Chosen model id (a card model id). */
  model: string;
  /** Predicted error probability gamma for the chosen model. */
  predictedError: number;
  /** The chosen model's per-prompt cost from the card. */
  cost: number;
  /** gamma + lambda * cost, the quantity that was minimised. */
  score: number;
  /** True when this call fell back after a better-ranked candidate failed. */
  fallback: boolean;
  /** Human-readable explanation. */
  reason: string;
};

export type RoutedModelConfig = {
  /** The fitted router (see loadRouterCard). */
  card: RouterCard;
  /** Card model id -> the model that serves it (e.g. an mlxServer instance). */
  candidates: Record<string, LanguageModelV3>;
  /**
   * Embed the prompt text in the card's embedding space. Must be the same
   * embedder the card was fitted with (card.embedder.model); the vector
   * length is checked against card.embedder.dims on every call.
   */
  embed: (text: string) => Promise<number[]>;
  /** Override the card's default lambda (cost/quality trade-off). */
  lambda?: number;
  /** Try the next-best candidate when a call fails. Defaults to true. */
  fallback?: boolean;
  /** Observer for every routing decision (withRoutedModel wires h.trace). */
  onDecision?: (decision: RouteDecision) => void;
};

/** Cluster weights Phi(x): one-hot nearest centroid, or the learned softmax. */
function clusterWeights(card: RouterCard, embedding: number[]): number[] {
  if (embedding.length !== card.embedder.dims) {
    throw new Error(
      `embedding has ${embedding.length} dims, the router card expects ${card.embedder.dims}`
    );
  }
  const assignment = card.assignment;
  switch (assignment.type) {
    case "centroids": {
      let best = 0;
      let bestDistance = Infinity;
      for (let k = 0; k < assignment.centroids.length; k++) {
        const centroid = assignment.centroids[k] ?? [];
        let distance = 0;
        for (let d = 0; d < centroid.length; d++) {
          const diff = (embedding[d] ?? 0) - (centroid[d] ?? 0);
          distance += diff * diff;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          best = k;
        }
      }
      return assignment.centroids.map((_, k) => (k === best ? 1 : 0));
    }
    case "softmax": {
      const features = [...embedding, 1];
      const logits = assignment.theta.map((row) =>
        row.reduce((sum, weight, d) => sum + weight * (features[d] ?? 0), 0)
      );
      const max = Math.max(...logits);
      const exps = logits.map((logit) => Math.exp(logit - max));
      const total = exps.reduce((sum, value) => sum + value, 0);
      return exps.map((value) => value / total);
    }
    default: {
      const exhausted: never = assignment;
      throw new Error(`unknown assignment type: ${JSON.stringify(exhausted)}`);
    }
  }
}

/** Serialize the prompt's user-visible text for embedding. */
function promptText(options: LanguageModelV3CallOptions): string {
  const parts: string[] = [];
  for (const message of options.prompt) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    for (const piece of message.content) {
      if (piece.type === "text") parts.push(piece.text);
    }
  }
  return parts.join("\n");
}

type RankedCandidate = {
  id: string;
  model: LanguageModelV3;
  gamma: number;
  cost: number;
  score: number;
};

export class RoutedModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "warrant-uniroute";
  readonly modelId: string;
  private readonly config: RoutedModelConfig;

  constructor(config: RoutedModelConfig) {
    const cardIds = new Set(config.card.models.map((model) => model.id));
    const missing = [...cardIds].filter((id) => !(id in config.candidates));
    if (missing.length > 0) {
      throw new Error(`router card models without candidates: ${missing.join(", ")}`);
    }
    this.config = config;
    this.modelId = `uniroute(${config.card.models.map((model) => model.id).join(" | ")})`;
  }

  get supportedUrls(): LanguageModelV3["supportedUrls"] {
    return {};
  }

  /** Candidates ordered by cost-adjusted predicted error (best first). */
  private async rank(options: LanguageModelV3CallOptions): Promise<RankedCandidate[]> {
    const { card } = this.config;
    const lambda = this.config.lambda ?? card.lambda;
    const embedding = await this.config.embed(promptText(options));
    const weights = clusterWeights(card, embedding);
    const ranked = card.models.map((model) => {
      const gamma = model.psi.reduce(
        (sum, error, k) => sum + error * (weights[k] ?? 0),
        0
      );
      return {
        id: model.id,
        model: this.config.candidates[model.id] as LanguageModelV3,
        gamma,
        cost: model.cost,
        score: gamma + lambda * model.cost
      };
    });
    // Ties break toward the cheaper model, matching the Python rule.
    return ranked.sort((a, b) => a.score - b.score || a.cost - b.cost);
  }

  private note(candidate: RankedCandidate, fallback: boolean, reason: string): void {
    this.config.onDecision?.({
      model: candidate.id,
      predictedError: candidate.gamma,
      cost: candidate.cost,
      score: candidate.score,
      fallback,
      reason
    });
  }

  private async dispatch<T>(
    options: LanguageModelV3CallOptions,
    call: (model: LanguageModelV3) => PromiseLike<T>
  ): Promise<T> {
    const ranked = await this.rank(options);
    const allowFallback = this.config.fallback ?? true;
    let lastError: unknown;
    for (let i = 0; i < ranked.length; i++) {
      const candidate = ranked[i] as RankedCandidate;
      const fallback = i > 0;
      const reason = fallback
        ? `fallback: ${(lastError as Error)?.message ?? String(lastError)}`
        : `lowest cost-adjusted predicted error (gamma=${candidate.gamma.toFixed(4)}, cost=${candidate.cost.toFixed(4)})`;
      try {
        const result = await call(candidate.model);
        this.note(candidate, fallback, reason);
        return result;
      } catch (error) {
        lastError = error;
        this.note(
          candidate,
          fallback,
          `call failed: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!allowFallback) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`every candidate failed: ${String(lastError)}`);
  }

  doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    return this.dispatch(options, (model) => model.doGenerate(options));
  }

  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    // A stream that fails to *start* falls back; one that dies mid-flight
    // belongs to the model that produced it (same semantics as HandoffModel).
    return this.dispatch(options, (model) => model.doStream(options));
  }
}

/** Create a UniRoute-routed model over a candidate pool. */
export function routedModel(config: RoutedModelConfig): RoutedModel {
  return new RoutedModel(config);
}

/**
 * Attach a routed model to a continuation context as `h.model`, recording
 * every routing decision as a `model.routed` trace event (the analog of
 * withModel for pools). `localModels` lists candidate ids served locally;
 * everything else is reported as a cloud route, and fallbacks surface as
 * escalations so triggers.modelEscalated() fires.
 */
export function withRoutedModel<H extends Handoff>(
  h: H,
  config: Omit<RoutedModelConfig, "onDecision"> & { localModels?: string[] }
): H & { model: RoutedModel } {
  const { localModels, ...rest } = config;
  const local = new Set(localModels ?? []);
  return attachModel(
    h,
    routedModel({
      ...rest,
      onDecision: (decision) => {
        h.noteModelDecision({
          model: decision.model,
          route: local.has(decision.model) ? "local" : "cloud",
          escalated: decision.fallback,
          reason: decision.reason
        });
      }
    })
  );
}
