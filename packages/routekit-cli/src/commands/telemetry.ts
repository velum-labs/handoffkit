import { contextFor } from "@routekit/cli-core";
import { telemetryStatusMetadata } from "@routekit/telemetry-core";
import type { Command } from "commander";

import {
  disableTelemetry,
  enableTelemetry,
  resolveTelemetry,
  TELEMETRY_FIELDS,
  telemetryPath
} from "../telemetry.js";

export function registerTelemetry(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("inspect and control anonymous telemetry");
  telemetry
    .command("status", { isDefault: true })
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const decision = resolveTelemetry();
      const status = telemetryStatusMetadata(decision, TELEMETRY_FIELDS);
      const result = {
        enabled: status.enabled,
        source: status.source,
        installId: status.installId,
        path: telemetryPath(),
        fields: status.fields
      };
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.status(
          decision.enabled ? "ok" : "pending",
          "telemetry",
          decision.enabled ? "on" : "off"
        );
        ctx.presenter.note(`decided by: ${decision.source}`);
      }
    });
  telemetry.command("on").action((_options: unknown, command: Command) => {
    const ctx = contextFor(command);
    const result = enableTelemetry();
    if (ctx.json) ctx.emit({ enabled: true, installId: result.installId });
    else ctx.presenter.success("telemetry enabled");
  });
  telemetry.command("off").action((_options: unknown, command: Command) => {
    const ctx = contextFor(command);
    disableTelemetry();
    if (ctx.json) ctx.emit({ enabled: false });
    else ctx.presenter.success("telemetry disabled");
  });
}
