/**
 * Graceful daemon upgrade.
 *
 * A running service and the installed CLI can skew while a product ships: the
 * record's `version` stamp detects that, and `upgradeDetachedDaemon` replaces
 * the process without severing in-flight work. Two strategies:
 *
 * - **blue-green** (stable non-loopback route, e.g. portless): start the new
 *   version on a fresh port first; when it is healthy it re-points the stable
 *   route to itself, then the old process is SIGTERMed and drains. Clients on
 *   the stable URL see zero downtime.
 * - **drain-restart** (fixed loopback port): the old process must release the
 *   port before the new one can bind it, so stop-with-drain first, then start.
 *   Unavailability is bounded by the drain grace plus startup.
 *
 * Supervised services (systemd/launchd) are not handled here: their init
 * system owns the restart, and the CLI delegates to the supervisor controller.
 */
import { isLoopbackHost } from "../url.js";

import { startDaemon, stopDaemonProcess } from "./daemon.js";
import type { ServiceDaemonSpec } from "./daemon.js";
import { createServiceRecordStore } from "./records.js";
import type { ServiceRecord } from "./records.js";

export type UpgradeStrategy =
  | "up-to-date"
  | "start"
  | "blue-green"
  | "drain-restart"
  | "supervisor-restart";

function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return true;
  }
}

/**
 * Decide how to bring a service to `version`. Also drives skew warnings in
 * status views: any result other than "up-to-date" means a restart is due.
 */
export function planUpgrade(input: {
  record: ServiceRecord | undefined;
  version: string;
  force?: boolean;
}): UpgradeStrategy {
  const { record } = input;
  if (record === undefined) return "start";
  if (record.version === input.version && input.force !== true) return "up-to-date";
  if (record.supervisor === "systemd" || record.supervisor === "launchd") {
    return "supervisor-restart";
  }
  return isLoopbackUrl(record.url) ? "drain-restart" : "blue-green";
}

export type UpgradeDaemonInput = {
  record: ServiceRecord;
  strategy: "blue-green" | "drain-restart";
  /**
   * Spec for the replacement process. For "blue-green" the command must bind a
   * fresh port (the stable route is re-pointed once healthy); "drain-restart"
   * reuses the recorded fixed port.
   */
  spec: ServiceDaemonSpec;
  /** Drain window granted to the old process (default 30s). */
  drainGraceMs?: number;
  readyTimeoutMs?: number;
  log?: (line: string) => void;
};

export type UpgradeDaemonResult = {
  strategy: "blue-green" | "drain-restart";
  record: ServiceRecord;
  previousPid: number;
};

export async function upgradeDetachedDaemon(
  input: UpgradeDaemonInput
): Promise<UpgradeDaemonResult> {
  const drainGraceMs = input.drainGraceMs ?? 30_000;
  const stopGraceMs = drainGraceMs + 10_000;
  const previousPid = input.record.pid;

  if (input.strategy === "blue-green") {
    const started = await startDaemon(input.spec, {
      previousPid,
      ...(input.readyTimeoutMs !== undefined ? { readyTimeoutMs: input.readyTimeoutMs } : {})
    });
    input.log?.(
      `new ${input.spec.product} ${input.spec.kind} is healthy (pid ${started.record.pid}); draining pid ${previousPid}`
    );
    await stopDaemonProcess(input.record, { graceMs: stopGraceMs });
    return { strategy: "blue-green", record: started.record, previousPid };
  }

  input.log?.(`draining ${input.spec.product} ${input.spec.kind} (pid ${previousPid})`);
  await stopDaemonProcess(input.record, { graceMs: stopGraceMs });
  // The old process removes its own record on clean shutdown; reap leftovers
  // from a forced kill so the new start does not read a stale record.
  createServiceRecordStore({ home: input.spec.home, product: input.spec.product }).remove(
    input.record.kind,
    { ifPid: previousPid }
  );
  const started = await startDaemon(input.spec, {
    ...(input.readyTimeoutMs !== undefined ? { readyTimeoutMs: input.readyTimeoutMs } : {})
  });
  return { strategy: "drain-restart", record: started.record, previousPid };
}
