import { detectHost } from "./local-catalog.js";
import type { HostInfo } from "./local-catalog.js";

export type CapabilityLine = { label: string; ok: boolean; detail: string };

export function localPanelUnsupportedMessage(host: HostInfo): string {
  return (
    `local MLX lifecycle tools need Apple Silicon (macOS arm64); this host is ` +
    `${host.platform}/${host.arch}. Configure a local endpoint through RouteKit on a supported host.`
  );
}

export function platformCapabilities(
  host: HostInfo = detectHost()
): CapabilityLine[] {
  const where = `${host.platform}/${host.arch}`;
  return [
    {
      label: "RouteKit-backed fusion",
      ok: true,
      detail: `all platforms (this host: ${where})`
    },
    {
      label: "local MLX lifecycle",
      ok: host.appleSilicon,
      detail: host.appleSilicon
        ? `Apple Silicon detected (${where})`
        : `Apple Silicon only — not available on ${where}`
    }
  ];
}
