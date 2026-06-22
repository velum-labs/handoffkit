/**
 * Lightweight Ollama availability probe for `fusionkit init`.
 */

/** Default Ollama tags API (not the OpenAI-compat `/v1` surface). */
export const OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags";

/** Result of probing a local Ollama daemon. */
export type OllamaProbeResult = {
  /** Whether the Ollama tags endpoint responded in time. */
  reachable: boolean;
  /** Model names reported by Ollama when reachable. */
  models: string[];
};

type OllamaTagsResponse = {
  models?: Array<{ name?: string }>;
};

/**
 * Probe `http://127.0.0.1:11434/api/tags` for installed Ollama models.
 */
export async function probeOllama(
  options: { timeoutMs?: number; tagsUrl?: string } = {}
): Promise<OllamaProbeResult> {
  const timeoutMs = options.timeoutMs ?? 500;
  const tagsUrl = options.tagsUrl ?? OLLAMA_TAGS_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(tagsUrl, { signal: controller.signal });
    if (!response.ok) {
      return { reachable: false, models: [] };
    }
    const body = (await response.json()) as OllamaTagsResponse;
    const models = (body.models ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
