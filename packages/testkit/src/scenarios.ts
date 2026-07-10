/**
 * High-level scenario scripting (mirrors `fusionkit_testkit.scenarios`).
 *
 * Encodes FusionKit's fusion call graph — panel fanout, then judge analysis,
 * then synthesizer answer, with judge and synthesizer often the same endpoint
 * consumed FIFO — so a test scripts a whole fused turn in one call.
 */

import { asBehavior } from "./behaviors.js";
import type { SimBehaviorInput } from "./behaviors.js";
import type { ProviderSimHandle } from "./provider-sim.js";

/** A well-formed judge analysis JSON reply (the judge model's first fuse-step turn). */
export function judgeAnalysis(overrides: {
  consensus?: string[];
  contradictions?: string[];
  unique_insights?: string[];
  coverage_gaps?: string[];
  likely_errors?: string[];
  recommended_final_structure?: string[];
  best_trajectory?: string;
} = {}): string {
  return JSON.stringify({
    consensus: overrides.consensus ?? ["candidates agree"],
    contradictions: overrides.contradictions ?? [],
    unique_insights: overrides.unique_insights ?? [],
    coverage_gaps: overrides.coverage_gaps ?? [],
    likely_errors: overrides.likely_errors ?? [],
    recommended_final_structure: overrides.recommended_final_structure ?? [],
    ...(overrides.best_trajectory !== undefined ? { best_trajectory: overrides.best_trajectory } : {})
  });
}

export type FusedTurnScript = {
  /** Provider model name -> panel candidate reply (what the journal records). */
  candidates: Record<string, SimBehaviorInput>;
  /** The judge endpoint's provider model name. */
  judgeModel: string;
  /** The synthesizer's final answer (second judge-endpoint turn by default). */
  answer: SimBehaviorInput;
  /** Judge analysis JSON; defaults to a well-formed {@link judgeAnalysis}. */
  analysis?: string;
  /** Set when the synthesizer is a different endpoint than the judge. */
  synthesizerModel?: string;
};

/** Script one full fused turn: panel candidates, judge analysis, synthesis. */
export async function scriptFusedTurn(sim: ProviderSimHandle, script: FusedTurnScript): Promise<void> {
  for (const [model, reply] of Object.entries(script.candidates)) {
    await sim.queue(model, [reply]);
  }
  const analysis = { reply: script.analysis ?? judgeAnalysis() };
  if (script.synthesizerModel === undefined || script.synthesizerModel === script.judgeModel) {
    await sim.queue(script.judgeModel, [analysis, asBehavior(script.answer)]);
    return;
  }
  await sim.queue(script.judgeModel, [analysis]);
  await sim.queue(script.synthesizerModel, [asBehavior(script.answer)]);
}
