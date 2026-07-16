/**
 * The hardware-aware catalog of local MLX models for the `fusionkit init`
 * picker and `fusionkit models` command.
 *
 * Local models run on Apple Silicon via the owned MLX env. The catalog data
 * lives in the registry (spec/registry/local-catalog.json), refreshed from the
 * HuggingFace hub by `scripts/generate-local-catalog.mjs`: sizes are the
 * on-disk download footprint; `minRamGB` is a conservative floor for loading
 * the weights with headroom for the KV cache and the OS — not just the file
 * size.
 */
import { totalmem } from "node:os";

import { LOCAL_CATALOG_ENTRIES, PREFERRED_LOCAL_MODELS } from "@routekit/registry";
import type { LocalCatalogModel, LocalModelRole } from "@routekit/registry";

export type ModelRole = LocalModelRole;

export type LocalCatalogEntry = LocalCatalogModel;

/**
 * The curated catalog, ordered small -> large. The preferred entries double as
 * the default local trio and run on virtually any Apple Silicon Mac.
 */
export const LOCAL_CATALOG: readonly LocalCatalogEntry[] = LOCAL_CATALOG_ENTRIES;

/** The host's relevant capabilities for local model fit. */
export type HostInfo = {
  platform: NodeJS.Platform;
  arch: string;
  /** Total physical memory in GB. */
  totalRamGB: number;
  /** macOS on Apple Silicon — the only place the MLX runtime works. */
  appleSilicon: boolean;
};

/** Detect the current host's capabilities. */
export function detectHost(): HostInfo {
  const platform = process.platform;
  const arch = process.arch;
  return {
    platform,
    arch,
    totalRamGB: totalmem() / 1024 ** 3,
    appleSilicon: platform === "darwin" && arch === "arm64"
  };
}

/**
 * Fraction of total RAM we let the local panel collectively occupy. The rest is
 * reserved for the OS, the coding agent, and slack — local panel members run as
 * separate resident MLX servers, so what matters is their *combined* footprint.
 */
export const USABLE_RAM_FRACTION = 0.8;

/** Memory (GB) available to the local panel as a whole on this host. */
export function usableRamGB(host: HostInfo): number {
  return host.totalRamGB * USABLE_RAM_FRACTION;
}

/**
 * A model "fits" the machine when its memory floor is within the usable budget
 * (i.e. it could run as the sole local model). Multi-model panels are gated by
 * the *cumulative* budget via {@link affordable}.
 */
export function fits(entry: LocalCatalogEntry, host: HostInfo): boolean {
  return entry.minRamGB <= usableRamGB(host);
}

/**
 * Whether a model still fits given `remainingGB` of unclaimed budget — used to
 * stop a panel's local members from collectively exceeding available memory.
 */
export function affordable(entry: LocalCatalogEntry, remainingGB: number): boolean {
  return entry.minRamGB <= remainingGB;
}

export type CatalogRecommendation = LocalCatalogEntry & { fits: boolean };

/**
 * The catalog ranked for a host: fitting models first (smallest -> largest),
 * then the rest (also smallest -> largest) flagged as not fitting. Keeping the
 * too-big ones visible (greyed out by the caller) is more honest than hiding
 * them.
 */
export function recommendFor(host: HostInfo): CatalogRecommendation[] {
  const annotated = LOCAL_CATALOG.map((entry) => ({ ...entry, fits: fits(entry, host) }));
  return annotated.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    return a.sizeGB - b.sizeGB;
  });
}

/**
 * A sensible default local panel for a host: greedily fill up to three small
 * all-rounders within the host's *cumulative* memory budget (preferring the
 * three classic small models, then the smallest remaining general models). Never
 * returns a panel whose combined footprint exceeds available memory; falls back
 * to the single smallest model so there is always something to run.
 */
export function defaultTrioFor(host: HostInfo): LocalCatalogEntry[] {
  const budget = usableRamGB(host);
  const byRepo = new Map(LOCAL_CATALOG.map((entry) => [entry.repo, entry]));
  // Preferred defaults are catalog metadata (spec/registry/local-catalog.json).
  const preferredRepos = PREFERRED_LOCAL_MODELS.map((entry) => entry.repo);

  const chosen: LocalCatalogEntry[] = [];
  let used = 0;
  const consider = (entry: LocalCatalogEntry): void => {
    if (chosen.length >= 3 || chosen.includes(entry)) return;
    if (used + entry.minRamGB <= budget) {
      chosen.push(entry);
      used += entry.minRamGB;
    }
  };

  for (const repo of preferredRepos) {
    const entry = byRepo.get(repo);
    if (entry !== undefined) consider(entry);
  }
  for (const entry of [...LOCAL_CATALOG]
    .filter((entry) => entry.role === "general")
    .sort((a, b) => a.minRamGB - b.minRamGB)) {
    consider(entry);
  }
  if (chosen.length > 0) return chosen;

  // Nothing fits the budget cleanly (very low-memory host): offer the single
  // smallest model so there is still something to try.
  const smallest = [...LOCAL_CATALOG].sort((a, b) => a.minRamGB - b.minRamGB)[0];
  return smallest !== undefined ? [smallest] : [];
}

/** Look up a catalog entry by repo id. */
export function catalogEntry(repo: string): LocalCatalogEntry | undefined {
  return LOCAL_CATALOG.find((entry) => entry.repo === repo);
}

/** The default local panel repos as plain ids (catalog order: small first). */
export const LOCAL_CATALOG_REPOS: readonly string[] = LOCAL_CATALOG.map((entry) => entry.repo);
