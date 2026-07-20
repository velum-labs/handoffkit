import { contextFor, CliError } from "@routekit/cli-core";
import { startDaemon, waitForServiceReady } from "@routekit/runtime";
import type { StartDaemonResult } from "@routekit/runtime";
import type { Command } from "commander";

import { gatewayDaemonSpec, gatewayLogPath, ROUTEKIT_PRODUCT } from "../daemon.js";
import { routekitHome } from "../config.js";
import { readServiceRecord, stopService } from "../state.js";

import { configOverride, loaded } from "./context.js";
import { attachServeOptions, drainGraceMs, serveArgvFrom } from "./serve-options.js";
import type { GatewayServeCliOptions } from "./serve-options.js";
import { gatewaySupervisorController } from "./gateway-service.js";

const READY_TIMEOUT_MS = 60_000;

export function emitStarted(
  ctx: ReturnType<typeof contextFor>,
  result: StartDaemonResult
): void {
  if (ctx.json) {
    ctx.emit({
      alreadyRunning: result.alreadyRunning,
      url: result.record.url,
      port: result.record.port,
      pid: result.record.pid,
      version: result.record.version,
      supervisor: result.record.supervisor,
      logFile: result.logFile
    });
    return;
  }
  if (result.alreadyRunning) {
    ctx.presenter.success(`RouteKit gateway already running at ${result.record.url}`);
  } else {
    ctx.presenter.success(`RouteKit gateway started at ${result.record.url}`);
  }
  ctx.presenter.note(`pid ${result.record.pid} · logs: ${result.logFile}`);
}

export function registerStart(program: Command): void {
  attachServeOptions(
    program
      .command("start")
      .description("start the model router as a background service")
  ).action(async (options: GatewayServeCliOptions, command: Command) => {
    const ctx = contextFor(command);
    // Validate the config before daemonizing so failures surface here, not
    // in a background log.
    loaded(command);
    drainGraceMs(options.drainGrace);
    const spec = gatewayDaemonSpec({
      args: serveArgvFrom({
        options,
        ...(configOverride(command) !== undefined ? { configPath: configOverride(command) } : {})
      })
    });
    const result = await startDaemon(spec, { readyTimeoutMs: READY_TIMEOUT_MS });
    emitStarted(ctx, result);
  });
}

export function registerRestart(program: Command): void {
  program
    .command("restart")
    .description("restart the running gateway service (drains in-flight requests)")
    .option("--drain-grace <seconds>", "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)")
    .action(async (options: { drainGrace?: string }, command: Command) => {
      const ctx = contextFor(command);
      const record = readServiceRecord("gateway");
      if (record === undefined) {
        throw new CliError({
          message: "RouteKit gateway is not running",
          tryCommand: "routekit gateway start"
        });
      }
      const graceMs = drainGraceMs(options.drainGrace);
      if (record.supervisor === "systemd" || record.supervisor === "launchd") {
        const controller = gatewaySupervisorController(record.supervisor);
        await controller.restart();
        const restarted = await waitForServiceReady({
          home: routekitHome(),
          product: ROUTEKIT_PRODUCT,
          kind: "gateway",
          previousPid: record.pid,
          timeoutMs: READY_TIMEOUT_MS,
          logFile: gatewayLogPath()
        });
        if (ctx.json) ctx.emit({ restarted: true, url: restarted.url, pid: restarted.pid });
        else ctx.presenter.success(`RouteKit gateway restarted at ${restarted.url}`);
        return;
      }
      if (record.args === undefined) {
        throw new CliError({
          message: "the running gateway did not record its launch arguments",
          hint: "stop it and start it again with `routekit gateway start`"
        });
      }
      await stopService("gateway", { graceMs: graceMs + 10_000 });
      const spec = gatewayDaemonSpec({
        args: record.args,
        ...(record.binPath !== undefined ? { binPath: record.binPath } : {}),
        ...(record.cwd !== undefined ? { cwd: record.cwd } : {})
      });
      const result = await startDaemon(spec, { readyTimeoutMs: READY_TIMEOUT_MS });
      emitStarted(ctx, result);
    });
}
