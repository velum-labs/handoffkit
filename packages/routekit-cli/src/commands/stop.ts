import { contextFor } from "@routekit/cli-core";
import {
  acquireLifecycleLock,
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
    .description("stop the RouteKit gateway")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      let result: { stopped: boolean; pid?: number };
      try {
        const record = readDaemonRecord();
        if (record === undefined) result = { stopped: false };
        else {
          if (record.supervisor === "systemd" || record.supervisor === "launchd") {
            await supervisorController(
              record.supervisor,
              "routekit",
              "daemon"
            ).stop({
              timeoutMs: supervisorOperationTimeoutMs(record.drainGraceMs)
            });
          } else {
            await controlClientForRecord(record).call(
              "daemon.prepareShutdown",
              { reason: "stop" },
              { idempotencyKey: `gateway-stop-${record.generation ?? record.pid}` }
            );
          }
          const stopped = await waitForProcessExit(
            record.pid,
            supervisorOperationTimeoutMs(record.drainGraceMs)
          );
          if (!stopped) throw new Error(`RouteKit daemon pid ${record.pid} did not drain`);
          result = { stopped: true, pid: record.pid };
        }
      } finally {
        lock.release();
      }
      if (ctx.json) ctx.emit({ service: result });
      else {
        if (result.stopped) ctx.presenter.success("stopped RouteKit daemon");
        else ctx.presenter.note("RouteKit daemon is not running");
      }
    });
}
