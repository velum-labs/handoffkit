import { homedir } from "node:os";
import { join } from "node:path";

import { createConsentManager } from "@velum-labs/routekit-telemetry-core";
import type { ConsentDecision, ConsentFile } from "@velum-labs/routekit-telemetry-core";

export type TelemetryFile = ConsentFile;
export type TelemetryDecision = ConsentDecision;

export function telemetryPath(): string {
  const override = process.env.FUSIONKIT_TELEMETRY_PATH;
  return override !== undefined && override.length > 0
    ? override
    : join(homedir(), ".fusionkit", "telemetry.json");
}

const consent = createConsentManager({
  path: telemetryPath,
  environmentVariable: "FUSIONKIT_TELEMETRY"
});

export const resolveTelemetry = consent.resolve;
export const enableTelemetry = consent.enable;
export const disableTelemetry = consent.disable;
export const clearTelemetryFile = consent.clear;
