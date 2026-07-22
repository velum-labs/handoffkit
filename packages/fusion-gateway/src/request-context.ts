import type { BackendRequestOptions } from "@routekit/gateway";

export const PANEL_DEPTH_HEADER = "x-fusionkit-panel-depth";

export function parsePanelDepth(value: string | readonly string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function panelDepthFromRequest(options: BackendRequestOptions): number {
  return parsePanelDepth(options.requestContext?.headers[PANEL_DEPTH_HEADER]);
}
