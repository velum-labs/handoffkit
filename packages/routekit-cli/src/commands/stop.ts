import { contextFor } from "@routekit/cli-core";
import {
  acquireLifecycleLock,
  processAlive,
  stopDaemonProcess,
  supervisorController,
  supervisorOperationTimeoutMs,
  waitForProcessExit
} from "@routekit/runtime";
import type { Command } from "commander";

import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  readDaemonRecord
} from "../client.js";

export function registerStop(program: Command): void {
  program
    .command("stop")
    .description("gracefully stop RouteKit")
    .option("--force", "SIGKILL a detached daemon if its control plane cannot drain")
    .action(async (options: { force?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      try {
        const record = readDaemonRecord();
        if (record === undefined) {
          if (ctx.json) ctx.emit({ stopped: false });
          else ctx.presenter.note("RouteKit is not running");
          return;
        }
        let requested = false;
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
          // Let the supervisor own termination. A direct SIGKILL while the
          // unit is still active can be immediately undone by its restart
          // policy, so --force only applies to detached processes.
          await supervisorController(
            record.supervisor,
            "routekit",
            "daemon"
          ).stop({
            timeoutMs: supervisorOperationTimeoutMs(record.drainGraceMs)
          });
          requested = true;
        } else {
          try {
            await controlClientForRecord(record).call(
              "daemon.prepareShutdown",
              { reason: "stop" },
              { idempotencyKey: `stop-${record.generation ?? record.pid}` }
            );
            requested = true;
          } catch (error) {
            if (options.force !== true) throw error;
          }
        }
        let stopped = await waitForProcessExit(
          record.pid,
          supervisorOperationTimeoutMs(record.drainGraceMs),
          record.processIdentity
        );
        if (!stopped && options.force === true) {
          await stopDaemonProcess(record, { graceMs: 0 });
          stopped = !processAlive(record.pid);
        }
        if (!stopped) {
          throw new Error(`RouteKit daemon pid ${record.pid} did not stop`);
        }
        if (ctx.json) ctx.emit({ stopped: true, requested, pid: record.pid });
        else ctx.presenter.success("stopped RouteKit");
      } finally {
        lock.release();
      }
    });
}
