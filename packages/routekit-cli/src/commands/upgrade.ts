import { contextFor, CliError } from "@routekit/cli-core";
import {
  planUpgrade,
  upgradeDetachedDaemon,
  waitForServiceReady
} from "@routekit/runtime";
import type { ServiceDaemonSpec } from "@routekit/runtime";
import type { Command } from "commander";

import { routekitHome } from "../config.js";
import { gatewayDaemonSpec, gatewayLogPath, ROUTEKIT_PRODUCT } from "../daemon.js";
import { readServiceRecord, routekitVersion } from "../state.js";
import type { RouteKitServiceRecord } from "../state.js";

import { drainGraceMs } from "./serve-options.js";
import { gatewaySupervisorController } from "./gateway-service.js";

const READY_TIMEOUT_MS = 60_000;

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

function replacementSpec(
  record: RouteKitServiceRecord,
  strategy: "blue-green" | "drain-restart"
): ServiceDaemonSpec {
  if (record.args === undefined) {
    throw new CliError({
      message: "the running gateway did not record its launch arguments",
      hint: "stop it and start it again with `routekit gateway start`"
    });
  }
  // The replacement always launches through the CURRENT entry script (the
  // stable bin shim), which is exactly what an upgrade must pick up.
  return gatewayDaemonSpec({
    args: strategy === "blue-green" ? argsWithPort(record.args, "0") : [...record.args],
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {})
  });
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
      const record = readServiceRecord("gateway");
      const strategy = planUpgrade({ record, version, force: options.force });
      const graceMs = drainGraceMs(options.drainGrace);

      if (strategy === "up-to-date") {
        if (ctx.json) ctx.emit({ action: "up-to-date", version, pid: record?.pid });
        else ctx.presenter.success(`RouteKit gateway is already running v${version}`);
        return;
      }

      if (strategy === "start") {
        throw new CliError({
          message: "RouteKit gateway is not running",
          tryCommand: "routekit gateway start"
        });
      }

      if (strategy === "supervisor-restart") {
        const running = record as RouteKitServiceRecord;
        const supervisor = running.supervisor as "systemd" | "launchd";
        const controller = gatewaySupervisorController(supervisor);
        // The unit's ExecStart points at the stable bin shim, so a restart is
        // enough unless the shim itself moved (e.g. a different install
        // prefix); then the unit must be rewritten via `service install`.
        const currentBin = process.argv[1];
        if (running.binPath !== undefined && currentBin !== undefined && running.binPath !== currentBin) {
          throw new CliError({
            message:
              `the installed CLI (${currentBin}) is not the binary the service unit runs (${running.binPath})`,
            hint: "re-run `routekit gateway service install` to rewrite the unit for the new location"
          });
        }
        await controller.restart();
        const restarted = await waitForServiceReady({
          home: routekitHome(),
          product: ROUTEKIT_PRODUCT,
          kind: "gateway",
          previousPid: running.pid,
          timeoutMs: READY_TIMEOUT_MS,
          logFile: gatewayLogPath()
        });
        if (ctx.json) {
          ctx.emit({
            action: "supervisor-restart",
            supervisor,
            url: restarted.url,
            pid: restarted.pid,
            from: running.version,
            to: restarted.version
          });
        } else {
          ctx.presenter.success(
            `RouteKit gateway upgraded to v${restarted.version ?? version} via ${supervisor} restart`
          );
        }
        return;
      }

      const running = record as RouteKitServiceRecord;
      const result = await upgradeDetachedDaemon({
        record: running,
        strategy,
        spec: replacementSpec(running, strategy),
        drainGraceMs: graceMs,
        readyTimeoutMs: READY_TIMEOUT_MS,
        ...(ctx.json ? {} : { log: (line) => ctx.presenter.note(line) })
      });
      if (ctx.json) {
        ctx.emit({
          action: result.strategy,
          url: result.record.url,
          pid: result.record.pid,
          previousPid: result.previousPid,
          from: running.version,
          to: result.record.version
        });
        return;
      }
      ctx.presenter.success(
        result.strategy === "blue-green"
          ? `RouteKit gateway upgraded to v${result.record.version ?? version} with zero downtime (stable route re-pointed)`
          : `RouteKit gateway upgraded to v${result.record.version ?? version} (drain-restart on port ${result.record.port})`
      );
      ctx.presenter.note(`pid ${result.record.pid} · url ${result.record.url}`);
    });
}
