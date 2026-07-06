/**
 * `fusionkit telemetry` — inspect and control opt-in product telemetry.
 *
 *   telemetry status    effective state, which layer decided it, install id,
 *                       and the complete field list
 *   telemetry on        opt in (mints the anonymous install id)
 *   telemetry off       opt out (deletes the install id)
 *   telemetry inspect   print the exact events a session would send, sending
 *                       nothing
 *
 * Telemetry is off by default and honors DO_NOT_TRACK and
 * FUSIONKIT_TELEMETRY=0 above any stored consent. See docs/privacy.md for
 * the published field list.
 */
import type { Command } from "commander";

import { bold, dim, green, yellow } from "@fusionkit/cli-ui";

import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import {
  disableTelemetry,
  enableTelemetry,
  resolveTelemetry,
  telemetryPath
} from "../telemetry/consent.js";
import {
  pendingSessionEventsForTest,
  telemetryHost,
  telemetryProjectKey
} from "../telemetry/telemetry.js";

import { registerPaletteAction } from "./palette.js";

/** The complete list of fields telemetry may send (the published contract). */
const FIELDS: Record<string, string[]> = {
  "cli.command": [
    "command",
    "cli_version",
    "os",
    "arch",
    "node_major",
    "duration_bucket",
    "exit_kind",
    "observe",
    "local",
    "is_ci"
  ],
  "fusion.session": [
    "panel_size",
    "providers",
    "harness",
    "judge_decision",
    "turn_count",
    "duration_bucket",
    "input_tokens",
    "output_tokens",
    "candidate_failures",
    "error_kind"
  ]
};

function sourceLabel(source: string): string {
  switch (source) {
    case "do-not-track":
      return "DO_NOT_TRACK environment variable";
    case "env":
      return "FUSIONKIT_TELEMETRY environment variable";
    case "config":
      return telemetryPath();
    default:
      return "default (never enabled)";
  }
}

function runStatus(ctx: CommandContext): number {
  const decision = resolveTelemetry();
  const key = telemetryProjectKey();
  if (ctx.json) {
    ctx.emit({
      enabled: decision.enabled,
      source: decision.source,
      installId: decision.installId ?? null,
      endpointConfigured: key !== undefined,
      host: telemetryHost(),
      fields: FIELDS
    });
    return 0;
  }
  const { presenter } = ctx;
  presenter.blank();
  presenter.header("telemetry");
  presenter.blank();
  presenter.keyValue([
    { label: "state", value: decision.enabled ? green("on") : bold("off") },
    { label: "decided by", value: sourceLabel(decision.source) },
    { label: "install id", value: decision.installId ?? dim("none (created on opt-in)") },
    {
      label: "endpoint",
      value:
        key !== undefined ? telemetryHost() : dim("not configured — nothing is sent even when on")
    }
  ]);
  presenter.blank();
  presenter.line(dim("fields (the complete list; never prompts, code, paths, or outputs):"));
  for (const [event, fields] of Object.entries(FIELDS)) {
    presenter.line(`  ${bold(event)}: ${fields.join(", ")}`);
  }
  presenter.blank();
  presenter.line(dim("toggle: fusionkit telemetry on | off · kill switch: DO_NOT_TRACK=1"));
  return 0;
}

function runOn(ctx: CommandContext): number {
  const file = enableTelemetry();
  const decision = resolveTelemetry();
  if (ctx.json) {
    ctx.emit({ enabled: decision.enabled, installId: file.installId });
    return 0;
  }
  ctx.presenter.line(`${green("telemetry on")} ${dim(`(anonymous install id ${file.installId})`)}`);
  if (!decision.enabled) {
    ctx.presenter.line(yellow(`note: ${sourceLabel(decision.source)} currently overrides this to off`));
  }
  ctx.presenter.line(dim("see the exact field list with: fusionkit telemetry status"));
  return 0;
}

function runOff(ctx: CommandContext): number {
  disableTelemetry();
  if (ctx.json) {
    ctx.emit({ enabled: false });
    return 0;
  }
  ctx.presenter.line(`${bold("telemetry off")} ${dim("(install id deleted)")}`);
  return 0;
}

function runInspect(ctx: CommandContext): number {
  const pending = pendingSessionEventsForTest();
  if (ctx.json) {
    ctx.emit({ pending });
    return 0;
  }
  if (pending.length === 0) {
    ctx.presenter.line(dim("no pending session events in this process"));
    return 0;
  }
  for (const event of pending) {
    ctx.presenter.line(JSON.stringify(event, null, 2));
  }
  return 0;
}

export function registerTelemetry(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("inspect and control opt-in, anonymous product telemetry (off by default)");

  telemetry
    .command("status", { isDefault: true })
    .description("effective state, deciding layer, install id, and the field list")
    .option("--json", "emit machine-readable JSON")
    .action(async function (this: Command) {
      const ctx = contextFor(this);
      process.exitCode = runStatus(ctx);
    });

  telemetry
    .command("on")
    .description("opt in to anonymous telemetry (mints a random install id)")
    .option("--json", "emit machine-readable JSON")
    .action(async function (this: Command) {
      const ctx = contextFor(this);
      process.exitCode = runOn(ctx);
    });

  telemetry
    .command("off")
    .description("opt out and delete the install id")
    .option("--json", "emit machine-readable JSON")
    .action(async function (this: Command) {
      const ctx = contextFor(this);
      process.exitCode = runOff(ctx);
    });

  telemetry
    .command("inspect")
    .description("print the events this process would send, sending nothing")
    .option("--json", "emit machine-readable JSON")
    .action(async function (this: Command) {
      const ctx = contextFor(this);
      process.exitCode = runInspect(ctx);
    });

  registerPaletteAction({
    label: "Check telemetry status",
    hint: "fusionkit telemetry status",
    argv: ["telemetry", "status"]
  });
}
