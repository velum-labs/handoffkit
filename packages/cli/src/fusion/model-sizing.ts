/**
 * Real memory sizing for local MLX models, computed from ground truth rather
 * than hand-authored guesses:
 *
 *   - weight footprint = the actual summed byte size of the repo's
 *     `*.safetensors` files (HF Hub tree API),
 *   - KV-cache footprint = derived from the repo's real `config.json`
 *     (layers x kv-heads x head-dim x dtype x context),
 *   - plus a fixed runtime/activation overhead.
 *
 * Everything is fetched over plain HTTPS from the public Hub, so it works during
 * onboarding before the Python venv exists. When the Hub is unreachable (offline
 * or a private/unknown repo) it falls back to the static catalog estimate, and
 * for an unsized unknown repo it reports `unknown` (which callers treat as
 * "can't verify — don't block").
 */
const GIB = 1024 ** 3;

/**
 * Context length used to budget the KV cache. The fusion router runs with an 8K
 * max-tokens sampling budget and coding prompts can be large, so we size the KV
 * cache for a full 8K window — the dominant non-weight memory cost.
 */
export const KV_CONTEXT_TOKENS = 8192;

/** KV cache is kept in fp16 by the MLX server (2 bytes per element). */
const KV_DTYPE_BYTES = 2;

/** Fixed headroom for the runtime, activations, and framework overhead. */
const RUNTIME_OVERHEAD_BYTES = 1.5 * GIB;

const DEFAULT_TIMEOUT_MS = 5000;

export type SizingSource = "hub" | "catalog" | "unknown";

export type ModelSizing = {
  /** Memory (GB) needed to run the model: weights + KV cache + overhead. */
  requiredGB: number;
  /** Weight-only footprint (GB), when known — the download size. */
  weightGB?: number;
  /** Where the numbers came from. */
  source: SizingSource;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Sum the byte size of every `*.safetensors` file in an HF tree listing. LFS
 * files (the weights) report their true size under `lfs.size`; fall back to the
 * plain `size` for non-LFS entries.
 */
export function sumSafetensorBytes(tree: unknown): number {
  if (!Array.isArray(tree)) return 0;
  let total = 0;
  for (const item of tree) {
    if (!isRecord(item)) continue;
    const path = item.path;
    if (typeof path !== "string" || !path.endsWith(".safetensors")) continue;
    const lfs = isRecord(item.lfs) ? finiteNumber(item.lfs.size) : undefined;
    const size = lfs ?? finiteNumber(item.size) ?? 0;
    total += size;
  }
  return total;
}

/**
 * KV-cache bytes for `contextTokens`, derived from a model `config.json`:
 * 2 (K+V) x layers x kv-heads x head-dim x dtype x tokens. Returns 0 when the
 * config lacks the dimensions needed to compute it (so callers fall back to a
 * weights-plus-overhead estimate rather than guessing).
 */
export function kvCacheBytes(config: unknown, contextTokens: number): number {
  if (!isRecord(config)) return 0;
  const layers = finiteNumber(config.num_hidden_layers);
  const heads = finiteNumber(config.num_attention_heads);
  const hidden = finiteNumber(config.hidden_size);
  const explicitHeadDim = finiteNumber(config.head_dim);
  if (layers === undefined || heads === undefined) return 0;
  const headDim = explicitHeadDim ?? (hidden !== undefined ? hidden / heads : undefined);
  if (headDim === undefined) return 0;
  const kvHeads = finiteNumber(config.num_key_value_heads) ?? heads;
  return 2 * layers * kvHeads * headDim * KV_DTYPE_BYTES * contextTokens;
}

/** Total required GB = weights + KV cache (from config) + runtime overhead. */
export function requiredGBFrom(
  weightBytes: number,
  config: unknown,
  contextTokens: number = KV_CONTEXT_TOKENS
): number {
  return (weightBytes + kvCacheBytes(config, contextTokens) + RUNTIME_OVERHEAD_BYTES) / GIB;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<unknown | undefined> {
  try {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) return undefined;
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Fetch real weight + config sizing from the Hub; undefined on any failure. */
async function fetchHubSizing(
  repo: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  contextTokens: number
): Promise<{ requiredGB: number; weightGB: number } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const tree = await fetchJson(
      `https://huggingface.co/api/models/${repo}/tree/main?recursive=1`,
      fetchImpl,
      controller.signal
    );
    const weightBytes = sumSafetensorBytes(tree);
    if (weightBytes <= 0) return undefined;
    const config = await fetchJson(
      `https://huggingface.co/${repo}/resolve/main/config.json`,
      fetchImpl,
      controller.signal
    );
    return {
      weightGB: weightBytes / GIB,
      requiredGB: requiredGBFrom(weightBytes, config, contextTokens)
    };
  } finally {
    clearTimeout(timer);
  }
}

export type EstimateOptions = {
  /** Static catalog floor (GB) to fall back to when the Hub is unreachable. */
  catalogFallbackGB?: number;
  /** Injectable fetch + timeout + context, for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  contextTokens?: number;
};

const sizingCache = new Map<string, ModelSizing>();

/** Clear the per-process sizing cache (tests only). */
export function clearSizingCacheForTests(): void {
  sizingCache.clear();
}

/**
 * Estimate the memory a model needs to run, preferring real Hub-derived numbers
 * and falling back to the static catalog floor (then `unknown`) when offline.
 * Results are memoized per repo for the process.
 */
export async function estimateModelSizing(repo: string, options: EstimateOptions = {}): Promise<ModelSizing> {
  const cached = sizingCache.get(repo);
  if (cached !== undefined) return cached;

  const hub = await fetchHubSizing(
    repo,
    options.fetchImpl ?? fetch,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.contextTokens ?? KV_CONTEXT_TOKENS
  );

  let result: ModelSizing;
  if (hub !== undefined) {
    result = { requiredGB: hub.requiredGB, weightGB: hub.weightGB, source: "hub" };
  } else if (options.catalogFallbackGB !== undefined) {
    result = { requiredGB: options.catalogFallbackGB, source: "catalog" };
  } else {
    result = { requiredGB: 0, source: "unknown" };
  }
  sizingCache.set(repo, result);
  return result;
}
