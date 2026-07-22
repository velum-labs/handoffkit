/**
 * Sidecar-config builder for simulator-backed tests. The simulator acts as the
 * RouteKit-compatible upstream; the Python process receives only its URL and
 * stable namespaced RouteKit model IDs, matching the production boundary.
 */

import { stringify } from "yaml";

/**
 * Retained for full-stack tests whose Node RouteKit gateway exercises Codex
 * subscription auth against the simulator.
 */
export const CODEX_TEST_TOKEN_ENV = "FUSIONKIT_TESTKIT_CODEX_TOKEN";

/** One namespaced model exposed by the simulator acting as RouteKit. */
export type SimModelSpec = {
  /** Stable RouteKit model id (what sidecar requests name in `model`). */
  id: string;
  /** Provider model name used when a Node RouteKit gateway fronts the simulator. */
  model: string;
  /** Provider wire dialect used by full-stack Node gateway tests. */
  provider?: "openai" | "anthropic" | "google" | "codex" | "openai-compatible" | "openrouter";
  timeoutS?: number;
};

export function simSidecarConfigYaml(input: {
  /** RouteKit-compatible simulator base URL (from `startProviderSim`). */
  simUrl: string;
  members: readonly SimModelSpec[];
  /** Judge/synthesizer RouteKit model id; defaults to the first member. */
  judgeId?: string;
  synthesizerId?: string;
  /**
   * Panel member RouteKit model ids for internal native-run tests.
   */
  panelIds?: readonly string[];
  prompts?: { judge_system?: string; synthesizer_system?: string };
}): string {
  const first = input.members[0];
  if (first === undefined) throw new Error("at least one member model is required");
  const judgeId = input.judgeId ?? first.id;
  const synthesizerId = input.synthesizerId ?? judgeId;
  const defaultPanel = input.members
    .map((member) => member.id)
    .filter((id) => id !== judgeId && id !== synthesizerId);
  const panelIds = input.panelIds ?? (defaultPanel.length > 0 ? defaultPanel : [first.id]);
  return (
    stringify({
      routekit_url: input.simUrl,
      routekit_model_ids: input.members.map((member) => member.id),
      default_model: judgeId,
      judge_model: judgeId,
      synthesizer_model: synthesizerId,
      default_mode: "panel",
      panel_models: [...panelIds],
      sampling: { temperature: 0.2, top_p: 0.9, max_tokens: 8192 },
      ...(input.prompts !== undefined ? { prompts: input.prompts } : {})
    }) + "\n"
  );
}
