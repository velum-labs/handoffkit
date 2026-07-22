import { contextFor, CliError } from "@routekit/cli-core";
import {
  acquireLifecycleLock,
  supervisorOperationTimeoutMs,
  waitForServiceReady,
  waitForProcessExit
} from "@routekit/runtime";
import type { Command } from "commander";

import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  daemonLogPath,
  daemonRecordHealthy,
  ensureDaemon,
  readDaemonRecord
} from "../client.js";
import { routekitHome } from "../config.js";

import { attachServeOptions, drainGraceMs } from "./serve-options.js";
import type { GatewayServeCliOptions } from "./serve-options.js";
import { daemonSupervisorController } from "./gateway-service.js";

export function registerStart(program: Command): void {
  attachServeOptions(
    program
      .command("start")
      .description("start RouteKit")
  ).action(async (options: GatewayServeCliOptions, command: Command) => {
    const ctx = contextFor(command);
    const running = await ensureDaemon({
      host: options.host,
      port: Number.parseInt(options.port, 10),
      ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
      ...(options.portless !== undefined ? { portless: options.portless } : {}),
      ...(
        options.drainGrace !== undefined ||
        process.env.ROUTEKIT_DRAIN_GRACE !== undefined
          ? { drainGraceMs: drainGraceMs(options.drainGrace) }
          : {}
      )
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
        `${result.alreadyRunning ? "RouteKit already running" : "RouteKit started"} at ${result.url}`
      );
      ctx.presenter.note(`pid ${result.pid} · logs: ${result.logFile}`);
    }
  });
}

export function registerRestart(program: Command): void {
  program
    .command("restart")
    .description("restart the singleton daemon (drains in-flight requests)")
    .option("--drain-grace <seconds>", "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)")
    .action(async (options: { drainGrace?: string }, command: Command) => {
      const ctx = contextFor(command);
      const record = readDaemonRecord();
      if (record === undefined) {
        throw new CliError({
          message: "RouteKit daemon is not running",
          tryCommand: "routekit start"
        });
      }
      if (
        options.drainGrace !== undefined &&
        (record.supervisor === "systemd" || record.supervisor === "launchd")
      ) {
        throw new CliError({
          message: "changing drain grace for a supervised daemon requires reinstalling its unit",
          tryCommand: `routekit daemon service install --drain-grace ${options.drainGrace}`
        });
      }
      drainGraceMs(options.drainGrace);
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      let restarted;
      try {
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
          const timeoutMs = supervisorOperationTimeoutMs(record.drainGraceMs);
          await daemonSupervisorController(record.supervisor).restart({ timeoutMs });
          const supervisedRecord = await waitForServiceReady({
            home: routekitHome(),
            product: "routekit",
            kind: "daemon",
            previousPid: record.pid,
            timeoutMs,
            logFile: daemonLogPath(),
            ready: daemonRecordHealthy
          });
          restarted = {
            record: supervisedRecord,
            client: controlClientForRecord(supervisedRecord)
          };
        } else {
          await controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "restart" },
            { idempotencyKey: `restart-${record.generation ?? record.pid}` }
          );
          if (
            !(await waitForProcessExit(
              record.pid,
              supervisorOperationTimeoutMs(record.drainGraceMs),
              record.processIdentity
            ))
          ) {
            throw new Error(`RouteKit daemon pid ${record.pid} did not drain`);
          }
          restarted = await ensureDaemon({
            ...(record.host !== undefined ? { host: record.host } : {}),
            port: record.dataPort ?? 8080,
            ...(record.portless !== undefined ? { portless: record.portless } : {}),
            drainGraceMs:
              options.drainGrace === undefined
                ? record.drainGraceMs
                : drainGraceMs(options.drainGrace),
            lifecycleLockHeld: true
          });
        }
      } finally {
        lock.release();
      }
      if (restarted === undefined) throw new Error("RouteKit daemon restart did not produce a successor");
      const status = await restarted.client.call("daemon.status", {});
      if (ctx.json) ctx.emit({ restarted: true, url: status.dataUrl, pid: status.pid });
      else ctx.presenter.success(`RouteKit daemon restarted at ${status.dataUrl}`);
    });
}
