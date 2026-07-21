import { contextFor, CliError } from "@routekit/cli-core";
import {
  acquireLifecycleLock,
  waitForProcessExit
} from "@routekit/runtime";
import type { Command } from "commander";

import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  daemonLogPath,
  ensureDaemon,
  readDaemonRecord
} from "../client.js";

import { attachServeOptions, drainGraceMs } from "./serve-options.js";
import type { GatewayServeCliOptions } from "./serve-options.js";
import { daemonSupervisorController } from "./gateway-service.js";

export function registerStart(program: Command): void {
  attachServeOptions(
    program
      .command("start")
      .description("start the model router as a background service")
  ).action(async (options: GatewayServeCliOptions, command: Command) => {
    const ctx = contextFor(command);
    const running = await ensureDaemon({
      host: options.host,
      port: Number.parseInt(options.port, 10),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.portless !== undefined ? { portless: options.portless } : {}),
      drainGraceMs: drainGraceMs(options.drainGrace)
    });
    const status = await running.client.call("daemon.status", {});
    const result = {
      alreadyRunning: running.start?.alreadyRunning ?? true,
      url: status.dataUrl,
      port: status.dataPort,
      pid: status.pid,
      version: status.packageVersion,
      supervisor: status.supervisor,
      logFile: daemonLogPath()
    };
    if (ctx.json) ctx.emit(result);
    else {
      ctx.presenter.success(
        `${result.alreadyRunning ? "RouteKit daemon already running" : "RouteKit daemon started"} at ${result.url}`
      );
      ctx.presenter.note(`pid ${result.pid} · logs: ${result.logFile}`);
    }
  });
}

export function registerRestart(program: Command): void {
  program
    .command("restart")
    .description("restart the running gateway service (drains in-flight requests)")
    .option("--drain-grace <seconds>", "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)")
    .action(async (options: { drainGrace?: string }, command: Command) => {
      const ctx = contextFor(command);
      const record = readDaemonRecord();
      if (record === undefined) {
        throw new CliError({
          message: "RouteKit daemon is not running",
          tryCommand: "routekit gateway start"
        });
      }
      drainGraceMs(options.drainGrace);
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      try {
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
          await daemonSupervisorController(record.supervisor).restart();
        } else {
          await controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "restart" },
            { idempotencyKey: `restart-${record.generation ?? record.pid}` }
          );
          if (!(await waitForProcessExit(record.pid, 45_000))) {
            throw new Error(`RouteKit daemon pid ${record.pid} did not drain`);
          }
        }
      } finally {
        lock.release();
      }
      const restarted = await ensureDaemon({
        ...(record.host !== undefined ? { host: record.host } : {}),
        port: record.dataPort ?? 8080,
        ...(record.portless !== undefined ? { portless: record.portless } : {}),
        ...(record.authToken !== undefined ? { authToken: record.authToken } : {}),
        drainGraceMs: options.drainGrace === undefined
          ? record.drainGraceMs
          : drainGraceMs(options.drainGrace)
      });
      const status = await restarted.client.call("daemon.status", {});
      if (ctx.json) ctx.emit({ restarted: true, url: status.dataUrl, pid: status.pid });
      else ctx.presenter.success(`RouteKit daemon restarted at ${status.dataUrl}`);
    });
}
