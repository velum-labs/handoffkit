import { contextFor, CliError } from "@routekit/cli-core";
import {
  acquireLifecycleLock,
  waitForProcessExit
} from "@routekit/runtime";
import type { Command } from "commander";

import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  ensureDaemon,
  readDaemonRecord
} from "../client.js";
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
    .description("replace the running gateway with the installed CLI version, draining in-flight requests")
    .option("--force", "restart even when versions already match (e.g. after a config change)")
    .option("--drain-grace <seconds>", "grace for in-flight requests (default: $ROUTEKIT_DRAIN_GRACE or 30)")
    .action(async (options: { force?: boolean; drainGrace?: string }, command: Command) => {
      const ctx = contextFor(command);
      const version = routekitVersion();
      const record = readDaemonRecord();
      drainGraceMs(options.drainGrace);
      if (record === undefined) {
        throw new CliError({
          message: "RouteKit daemon is not running",
          tryCommand: "routekit gateway start"
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
      try {
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
          await daemonSupervisorController(record.supervisor).restart();
        } else {
          await controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "upgrade" },
            { idempotencyKey: `upgrade-${record.generation ?? record.pid}` }
          );
          if (!(await waitForProcessExit(record.pid, 45_000))) {
            throw new Error(`RouteKit daemon pid ${record.pid} did not drain`);
          }
        }
      } finally {
        lock.release();
      }
      const replacement = await ensureDaemon({
        port: record.dataPort ?? 8080,
        ...(record.authToken !== undefined ? { authToken: record.authToken } : {})
      });
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
