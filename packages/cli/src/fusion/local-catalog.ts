/**
 * A hand-maintained, hardware-aware catalog of local MLX models for the
 * `fusionkit init` picker and `fusionkit models` command.
 *
 * Local models run on Apple Silicon via the owned MLX env. There is no reliable
 * "recommended models" API upstream, so this is a curated shortlist of
 * mlx-community 4-bit builds that run well on a Mac. Sizes are the on-disk
 * download footprint (approximate, from the published repos); `minRamGB` is a
 * conservative floor for loading the weights with headroom for the KV cache and
 * the OS — not just the file size.
 */
import { totalmem } from "node:os";

export type ModelRole = "general" | "coder";

export type LocalCatalogEntry = {
  /** Hugging Face repo id loaded by the MLX server. */
  repo: string;
  /** Short human label for the picker. */
  label: string;
  /** Parameter count, human form (e.g. "1.7B"). */
  params: string;
  /** Quantization (e.g. "4bit"). */
  quant: string;
  /** Approximate on-disk download size in GB. */
  sizeGB: number;
  /** Conservative unified-memory floor in GB to run it comfortably. */
  minRamGB: number;
  /** One-line description. */
  blurb: string;
  /** What it's best at. */
  role: ModelRole;
};

/**
 * The curated catalog, ordered small -> large. The first three doubled as the
 * historical `DEFAULT_TRIO` and run on virtually any Apple Silicon Mac.
 */
export const LOCAL_CATALOG: readonly LocalCatalogEntry[] = [
  {
    repo: "mlx-community/Llama-3.2-1B-Instruct-4bit",
    label: "Llama 3.2 1B Instruct",
    params: "1B",
    quant: "4bit",
    sizeGB: 0.7,
    minRamGB: 4,
    blurb: "tiny and fast; great for low-memory machines and quick panels",
    role: "general"
  },
  {
    repo: "mlx-community/gemma-3-1b-it-4bit",
    label: "Gemma 3 1B Instruct",
    params: "1B",
    quant: "4bit",
    sizeGB: 0.8,
    minRamGB: 4,
    blurb: "small Google model; a strong, diverse panel voice",
    role: "general"
  },
  {
    repo: "mlx-community/Qwen3-1.7B-4bit",
    label: "Qwen3 1.7B",
    params: "1.7B",
    quant: "4bit",
    sizeGB: 1.0,
    minRamGB: 6,
    blurb: "capable small all-rounder; a good default panel member",
    role: "general"
  },
  {
    repo: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    label: "Llama 3.2 3B Instruct",
    params: "3B",
    quant: "4bit",
    sizeGB: 1.8,
    minRamGB: 8,
    blurb: "noticeably stronger than 1B while still light",
    role: "general"
  },
  {
    repo: "mlx-community/Qwen3-4B-4bit",
    label: "Qwen3 4B",
    params: "4B",
    quant: "4bit",
    sizeGB: 2.3,
    minRamGB: 10,
    blurb: "well-rounded mid-size model; good quality-to-size ratio",
    role: "general"
  },
  {
    repo: "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
    label: "Qwen2.5 Coder 7B",
    params: "7B",
    quant: "4bit",
    sizeGB: 4.2,
    minRamGB: 16,
    blurb: "code-specialized; a strong local coding panelist",
    role: "coder"
  },
  {
    repo: "mlx-community/Qwen3-8B-4bit",
    label: "Qwen3 8B",
    params: "8B",
    quant: "4bit",
    sizeGB: 4.5,
    minRamGB: 16,
    blurb: "high-quality general model for 16GB+ machines",
    role: "general"
  },
  {
    repo: "mlx-community/Qwen3-14B-4bit",
    label: "Qwen3 14B",
    params: "14B",
    quant: "4bit",
    sizeGB: 8.0,
    minRamGB: 24,
    blurb: "frontier-ish local quality; needs a roomy machine",
    role: "general"
  },
  {
    repo: "mlx-community/Qwen2.5-Coder-32B-Instruct-4bit",
    label: "Qwen2.5 Coder 32B",
    params: "32B",
    quant: "4bit",
    sizeGB: 18.0,
    minRamGB: 36,
    blurb: "the strongest local coder here; for 36GB+ Macs",
    role: "coder"
  }
];

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
  const preferredRepos = [
    "mlx-community/Qwen3-1.7B-4bit",
    "mlx-community/gemma-3-1b-it-4bit",
    "mlx-community/Llama-3.2-1B-Instruct-4bit"
  ];

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
