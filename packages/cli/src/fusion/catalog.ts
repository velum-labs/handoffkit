import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CatalogModel = {
  id: string;
  label?: string;
};

type CatalogFile = {
  version: 1;
  models: CatalogModel[];
  fetchedAt: number;
};

const MLX_COMMUNITY_URL =
  "https://huggingface.co/api/models?author=mlx-community&pipeline_tag=text-generation&sort=downloads&direction=-1&limit=200";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function catalogCachePath(): string {
  return (
    process.env.FUSIONKIT_CATALOG_PATH ??
    join(homedir(), ".fusionkit", "mlx-catalog.json")
  );
}

function readCache(): CatalogFile | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(catalogCachePath(), "utf8")
    ) as CatalogFile;
    return parsed.version === 1 && Array.isArray(parsed.models)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(models: CatalogModel[]): void {
  try {
    const path = catalogCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ version: 1, models, fetchedAt: Date.now() }, null, 2)}\n`
    );
  } catch {
    // Local model catalog caching is best effort.
  }
}

export function cachedCatalog(provider: "mlx"): CatalogModel[] {
  void provider;
  return readCache()?.models ?? [];
}

export async function refreshCatalog(provider: "mlx"): Promise<CatalogModel[]> {
  void provider;
  const response = await fetch(MLX_COMMUNITY_URL, {
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error(`${MLX_COMMUNITY_URL} -> HTTP ${response.status}`);
  }
  const body = (await response.json()) as Array<{ id?: unknown }>;
  const models = (Array.isArray(body) ? body : []).flatMap((entry) =>
    typeof entry.id === "string" && entry.id.length > 0
      ? [{ id: entry.id }]
      : []
  );
  writeCache(models);
  return models;
}

export async function catalogFor(provider: "mlx"): Promise<CatalogModel[]> {
  const cached = cachedCatalog(provider);
  const cache = readCache();
  if (cache !== undefined && Date.now() - cache.fetchedAt <= CACHE_TTL_MS) {
    return cached;
  }
  try {
    return await refreshCatalog(provider);
  } catch {
    return cached;
  }
}
