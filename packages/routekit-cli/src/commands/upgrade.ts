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
import { routekitVersion } from "../state.js";

import { drainGraceMs } from "./serve-options.js";
import { daemonSupervisorController } from "./gateway-service.js";

/**
 * Rebuild the recorded serve argv with a different `--port` value: a
 * blue-green replacement must bind a fresh ephemeral port (0) while the
 * stable route is re-pointed to it.
 */
export function argsWithPort(args: readonly string[], port: string): string[] {
  const rebuilt = [...args];
  const index = rebuilt.indexOf("--port");
  if (index >= 0 && index + 1 < rebuilt.length) rebuilt[index + 1] = port;
  else rebuilt.push("--port", port);
  return rebuilt;
}

export function registerUpgrade(program: Command): void {
  program
    .command("upgrade")
    .description("upgrade the running daemon to the installed CLI version")
    .option("--force", "restart even when versions already match (e.g. after a config change)")
    .option("--drain-grace <seconds>", "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)")
    .action(async (options: { force?: boolean; drainGrace?: string }, command: Command) => {
      const ctx = contextFor(command);
      const version = routekitVersion();
      const record = readDaemonRecord();
      const requestedGrace =
        options.drainGrace === undefined
          ? record?.drainGraceMs
          : drainGraceMs(options.drainGrace);
      if (record === undefined) {
        throw new CliError({
          message: "RouteKit daemon is not running",
          tryCommand: "routekit daemon start"
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
      if (record.version === version && options.force !== true) {
        if (ctx.json) ctx.emit({ action: "up-to-date", version, pid: record?.pid });
        else ctx.presenter.success(`RouteKit daemon is already running v${version}`);
        return;
      }
      const currentBin = process.argv[1];
      if (
        record.binPath !== undefined &&
        currentBin !== undefined &&
        record.binPath !== currentBin &&
        (record.supervisor === "systemd" || record.supervisor === "launchd")
      ) {
        throw new CliError({
          message:
            `the installed CLI (${currentBin}) is not the binary the daemon unit runs (${record.binPath})`,
          hint: "re-run `routekit daemon service install` to rewrite the unit"
        });
      }
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      let replacement;
      try {
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
          const timeoutMs = supervisorOperationTimeoutMs(requestedGrace);
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
          replacement = {
            record: supervisedRecord,
            client: controlClientForRecord(supervisedRecord)
          };
        } else {
          await controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "upgrade" },
            { idempotencyKey: `upgrade-${record.generation ?? record.pid}` }
          );
          if (
            !(await waitForProcessExit(
              record.pid,
              supervisorOperationTimeoutMs(requestedGrace),
              record.processIdentity
            ))
          ) {
            throw new Error(`RouteKit daemon pid ${record.pid} did not drain`);
          }
          replacement = await ensureDaemon({
            ...(record.host !== undefined ? { host: record.host } : {}),
            port: record.dataPort ?? 8080,
            ...(record.portless !== undefined ? { portless: record.portless } : {}),
            ...(requestedGrace !== undefined
              ? { drainGraceMs: requestedGrace }
              : {}),
            lifecycleLockHeld: true
          });
        }
      } finally {
        lock.release();
      }
      if (replacement === undefined) throw new Error("RouteKit daemon upgrade did not produce a successor");
      const status = await replacement.client.call("daemon.status", {});
      const result = {
        action:
          record.supervisor === "systemd" || record.supervisor === "launchd"
            ? "supervisor-restart"
            : "drain-restart",
        url: status.dataUrl,
        pid: status.pid,
        previousPid: record.pid,
        from: record.version,
        to: status.packageVersion
      };
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      ctx.presenter.success(
        `RouteKit daemon upgraded to v${status.packageVersion} (${result.action})`
      );
      ctx.presenter.note(`pid ${status.pid} · url ${status.dataUrl}`);
    });
}
