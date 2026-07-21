import { contextFor } from "@routekit/cli-core";
import { randomId } from "@routekit/runtime";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

export function registerTelemetry(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("inspect and control anonymous telemetry");
  telemetry
    .command("status", { isDefault: true })
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const result = await (await routekitClient()).call("telemetry.get", {});
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.status(
          result.enabled ? "ok" : "pending",
          "telemetry",
          result.enabled ? "on" : "off"
        );
      }
    });
  telemetry.command("on").action(async (_options: unknown, command: Command) => {
    const ctx = contextFor(command);
    const result = await (await routekitClient()).call(
      "telemetry.set",
      { enabled: true },
      { idempotencyKey: `telemetry-on-${randomId(16)}` }
    );
    if (ctx.json) ctx.emit(result);
    else ctx.presenter.success("telemetry enabled");
  });
  telemetry.command("off").action(async (_options: unknown, command: Command) => {
    const ctx = contextFor(command);
    const result = await (await routekitClient()).call(
      "telemetry.set",
      { enabled: false },
      { idempotencyKey: `telemetry-off-${randomId(16)}` }
    );
    if (ctx.json) ctx.emit(result);
    else ctx.presenter.success("telemetry disabled");
  });
}
