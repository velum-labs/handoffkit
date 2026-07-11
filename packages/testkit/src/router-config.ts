/**
 * Router-config builder for simulator-backed stacks: the `fusionkit serve`
 * YAML (the contract `fusionkit_core.config.load_config` parses, the same
 * document shape `routerConfigYaml` in `packages/cli/src/fusion/stack.ts`
 * emits in production) with every endpoint pointed at the provider simulator.
 */

import { stringify } from "yaml";

/**
 * The env var the codex provider's subscription token is read from in tests
 * (mirrors `fusionkit_testkit.endpoints.CODEX_TEST_TOKEN_ENV`); `startEngine`
 * seeds a fake value so no real ChatGPT login is ever touched.
 */
export const CODEX_TEST_TOKEN_ENV = "FUSIONKIT_TESTKIT_CODEX_TOKEN";

/** One simulator-backed router endpoint. */
export type SimEndpointSpec = {
  /** Router endpoint id (what requests name in `model`). */
  id: string;
  /** Provider model name (what the simulator journal records). */
  model: string;
  /**
   * Which real wire client (and simulator dialect) the engine uses for it.
   * Defaults to `openai`. `codex` authenticates from {@link CODEX_TEST_TOKEN_ENV}.
   */
  provider?: "openai" | "anthropic" | "google" | "codex" | "openai-compatible" | "openrouter";
  timeoutS?: number;
};

export function simRouterConfigYaml(input: {
  /** Provider simulator base URL (from `startProviderSim`). */
  simUrl: string;
  members: readonly SimEndpointSpec[];
  /** Judge/synthesizer endpoint id; defaults to the first member. */
  judgeId?: string;
  synthesizerId?: string;
  /**
   * Panel member endpoint ids for the engine's own `fusionkit/panel` mode.
   * Defaults to every member except the judge/synthesizer (a judge that is
   * also a panel member would consume its own scripted behaviors as a
   * candidate before the fuse step reaches it).
   */
  panelIds?: readonly string[];
  prompts?: { judge_system?: string; synthesizer_system?: string };
}): string {
  const first = input.members[0];
  if (first === undefined) throw new Error("at least one member endpoint is required");
  const judgeId = input.judgeId ?? first.id;
  const synthesizerId = input.synthesizerId ?? judgeId;
  const defaultPanel = input.members
    .map((member) => member.id)
    .filter((id) => id !== judgeId && id !== synthesizerId);
  const panelIds = input.panelIds ?? (defaultPanel.length > 0 ? defaultPanel : [first.id]);
  return (
    stringify({
      endpoints: input.members.map((member) => ({
        id: member.id,
        model: member.model,
        provider: member.provider ?? "openai",
        base_url: input.simUrl,
        api_key: `sk-test-${member.id}`,
        timeout_s: member.timeoutS ?? 30,
        ...(member.provider === "codex"
          ? { auth: { mode: "codex", token_env: CODEX_TEST_TOKEN_ENV } }
          : {})
      })),
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
