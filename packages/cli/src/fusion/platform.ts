/**
 * Cross-platform capability gating (WS8).
 *
 * The ensemble has two model substrates with very different platform reach:
 *
 * - **Cloud panels** (OpenAI / Anthropic / Google / any openai-compatible
 *   endpoint) are pure HTTP and work on every platform — Linux, Windows, macOS.
 *   The cloud run path has no hard MLX dependency at runtime: `MlxBackend` is
 *   only constructed for panel members whose provider is `mlx`.
 * - **Local MLX panels** run on Apple Silicon only (the MLX runtime is
 *   macOS/arm64). The vLLM/TGI backend for Linux+NVIDIA is intentionally
 *   deferred, so off Apple Silicon a local panel must fail early with a clear
 *   pointer at the cloud path rather than crash deep in the stack.
 */
import { detectHost } from "./local-catalog.js";
import type { HostInfo } from "./local-catalog.js";
import type { PanelModelSpec } from "./env.js";

/** True when any panel member runs on the local MLX runtime. */
export function panelUsesLocalMlx(models: readonly PanelModelSpec[]): boolean {
  return models.some((spec) => (spec.provider ?? "mlx") === "mlx");
}

/** The early-failure message shown when a local MLX panel is requested off Apple Silicon. */
export function localPanelUnsupportedMessage(host: HostInfo): string {
  return (
    `local MLX models need Apple Silicon (macOS arm64); this host is ${host.platform}/${host.arch}. ` +
    "Drop --local (and any mlx panel members) to run the cross-platform cloud panel " +
    "(OpenAI + Anthropic + Google, or any --model PROVIDER:MODEL / --model-endpoint), " +
    "which works everywhere. The Linux/NVIDIA local backend (vLLM/TGI) is not yet available. " +
    "See docs/model-catalog.md for choosing panel models."
  );
}

/**
 * Throw early (before any stack is spawned) when a local MLX panel is requested
 * on a host the MLX runtime can't run on. The cloud path is unaffected.
 */
export function ensureLocalPanelSupported(
  models: readonly PanelModelSpec[],
  host: HostInfo = detectHost()
): void {
  if (panelUsesLocalMlx(models) && !host.appleSilicon) {
    throw new Error(localPanelUnsupportedMessage(host));
  }
}

/** A single platform-capability row for `doctor` / `setup`. */
export type CapabilityLine = { label: string; ok: boolean; detail: string };

/**
 * Per-platform capability summary: cloud ensembles everywhere, local MLX on
 * Apple Silicon only. Pure (host injected) so it is trivially testable.
 */
export function platformCapabilities(host: HostInfo = detectHost()): CapabilityLine[] {
  const where = `${host.platform}/${host.arch}`;
  return [
    {
      label: "cloud ensembles",
      ok: true,
      detail: `all platforms (this host: ${where})`
    },
    {
      label: "local MLX ensembles",
      ok: host.appleSilicon,
      detail: host.appleSilicon
        ? `Apple Silicon detected (${where})`
        : `Apple Silicon only — not available on ${where}`
    }
  ];
}
