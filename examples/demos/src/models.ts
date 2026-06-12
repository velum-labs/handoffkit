/**
 * Live-model resolution for the demo series. The demos run with scripted
 * mock models by default so the whole series is deterministic and needs no
 * API keys; set these environment variables to run them against real
 * models through any OpenAI-compatible endpoint:
 *
 *   Local (e.g. Ollama, LM Studio, mlx_lm.server on Apple Silicon):
 *     WARRANT_DEMO_LOCAL_URL     e.g. http://localhost:11434/v1
 *     WARRANT_DEMO_LOCAL_MODEL   e.g. qwen3:8b
 *     WARRANT_DEMO_LOCAL_API_KEY optional (Ollama and MLX ignore it)
 *
 * For a local MLX server whose lifecycle (Python env, process, scale to
 * zero) is owned by Warrant instead of run by hand, see mlxServer() in
 * @warrant/adapter-ai-sdk.
 *
 *   Cloud (e.g. OpenAI, a gateway, OpenRouter):
 *     WARRANT_DEMO_CLOUD_URL     default https://api.openai.com/v1
 *     WARRANT_DEMO_CLOUD_MODEL   e.g. gpt-5.5-mini (no default: name it explicitly)
 *     WARRANT_DEMO_CLOUD_API_KEY or OPENAI_API_KEY
 *
 * The mock fallback is not a lesser mode — it is what keeps the series
 * runnable in CI and on fresh clones. Live mode changes which model
 * produces the words; the governance (contracts, sessions, receipts) is
 * identical in both.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV3 } from "@ai-sdk/provider";

const DEFAULT_CLOUD_BASE_URL = "https://api.openai.com/v1";

export type LiveModels = {
  source: "live";
  local?: LanguageModelV3;
  cloud?: LanguageModelV3;
  /** The model demos should drive loops with (cloud preferred). */
  loop: LanguageModelV3;
  description: string;
};

export type MockModels = {
  source: "mock";
  description: string;
};

export type DemoModels = LiveModels | MockModels;

export function resolveDemoModels(): DemoModels {
  const localUrl = process.env.WARRANT_DEMO_LOCAL_URL;
  const cloudKey =
    process.env.WARRANT_DEMO_CLOUD_API_KEY ?? process.env.OPENAI_API_KEY;

  let local: LanguageModelV3 | undefined;
  let localLabel = "";
  if (localUrl) {
    const modelId = process.env.WARRANT_DEMO_LOCAL_MODEL;
    if (!modelId) {
      throw new Error(
        "WARRANT_DEMO_LOCAL_URL is set but WARRANT_DEMO_LOCAL_MODEL is not; name the model explicitly"
      );
    }
    const provider = createOpenAICompatible({
      name: "warrant-demo-local",
      baseURL: localUrl,
      apiKey: process.env.WARRANT_DEMO_LOCAL_API_KEY ?? "not-needed"
    });
    local = provider(modelId);
    localLabel = `local ${modelId} @ ${localUrl}`;
  }

  // Naming the model is the explicit opt-in; an ambient OPENAI_API_KEY
  // alone (common in CI) must not flip the demos into live mode.
  let cloud: LanguageModelV3 | undefined;
  let cloudLabel = "";
  const cloudModelId = process.env.WARRANT_DEMO_CLOUD_MODEL;
  if (cloudModelId) {
    const modelId = cloudModelId;
    if (!cloudKey) {
      throw new Error(
        "WARRANT_DEMO_CLOUD_MODEL is set but no API key is (WARRANT_DEMO_CLOUD_API_KEY or OPENAI_API_KEY)"
      );
    }
    // Any OpenAI-compatible endpoint works; the OpenAI API URL is the
    // sensible default for the WARRANT_DEMO_CLOUD_MODEL opt-in, and
    // WARRANT_DEMO_CLOUD_URL points elsewhere (Azure, Together, vLLM, ...).
    const baseURL =
      process.env.WARRANT_DEMO_CLOUD_URL ?? DEFAULT_CLOUD_BASE_URL;
    const provider = createOpenAICompatible({
      name: "warrant-demo-cloud",
      baseURL,
      apiKey: cloudKey
    });
    cloud = provider(modelId);
    cloudLabel = `cloud ${modelId} @ ${baseURL}`;
  }

  const loop = cloud ?? local;
  if (!loop) {
    return {
      source: "mock",
      description:
        "scripted mock models (set WARRANT_DEMO_LOCAL_URL/_MODEL or an API key for real ones)"
    };
  }
  return {
    source: "live",
    ...(local ? { local } : {}),
    ...(cloud ? { cloud } : {}),
    loop,
    description: ["live models:", localLabel, cloudLabel]
      .filter((part) => part.length > 0)
      .join(" ")
  };
}
