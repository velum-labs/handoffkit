import { join } from "node:path";

import { createConsentManager } from "@routekit/telemetry-core";

import { routekitHome } from "./config.js";

export function telemetryPath(): string {
  const override = process.env.ROUTEKIT_TELEMETRY_PATH;
  return override !== undefined && override.length > 0
    ? override
    : join(routekitHome(), "telemetry.json");
}

const consent = createConsentManager({
  path: telemetryPath,
  environmentVariable: "ROUTEKIT_TELEMETRY"
});

export const resolveTelemetry = consent.resolve;
export const enableTelemetry = consent.enable;
export const disableTelemetry = consent.disable;

export const TELEMETRY_FIELDS = {
  "cli.command": [
    "command",
    "cli_version",
    "os",
    "arch",
    "node_major",
    "duration_bucket",
    "exit_kind",
    "is_ci"
  ]
} as const;
