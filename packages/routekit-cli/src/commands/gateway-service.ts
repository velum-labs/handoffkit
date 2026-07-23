import { createReadStream, statSync } from "node:fs";

import { contextFor, CliError } from "@velum-labs/routekit-cli-core";
import {
  acquireLifecycleLock,
  detectSupervisor,
  readLogTail,
  spawnTool,
  supervisorController,
  supervisorOperationTimeoutMs,
  systemdUnitName,
  waitForProcessExit,
  waitForServiceReady
} from "@velum-labs/routekit-runtime";
import type { SupervisorController } from "@velum-labs/routekit-runtime";
import type { Command } from "commander";

import {
  controlClientForRecord,
  daemonLifecycleLockPath,
  daemonLogPath,
  daemonRecordHealthy,
  daemonServeArgs,
  ensureDaemonDataToken,
  ensureDaemon,
  readDaemonRecord
} from "../client.js";
import { globalRouterConfigPath, loadRouterConfig, routekitHome } from "../config.js";
import {
  daemonUnitSpec,
  missingServiceCredentialVariables,
  removeServiceEnvFile,
  ROUTEKIT_PRODUCT,
  serviceEnvironment
} from "../daemon.js";

import { attachServeOptions, drainGraceMs } from "./serve-options.js";
import type { GatewayServeCliOptions } from "./serve-options.js";

export function daemonSupervisorController(
  kind: "systemd" | "launchd"
): SupervisorController {
  return supervisorController(kind, ROUTEKIT_PRODUCT, "daemon");
}

export async function platformSupervisor(): Promise<SupervisorController | undefined> {
  return await detectSupervisor(ROUTEKIT_PRODUCT, "daemon");
}

function registerInstall(group: Command): void {
  attachServeOptions(
    group
      .command("install")
      .description(
        "install the daemon as an OS-supervised service (systemd/launchd)"
      )
  ).action(async (options: GatewayServeCliOptions, command: Command) => {
    const ctx = contextFor(command);
    const configPath = globalRouterConfigPath();
    const result = loadRouterConfig({ configPath });
    const missingCredentials = missingServiceCredentialVariables(result.config);
    if (missingCredentials.length > 0) {
      throw new CliError({
        message:
          `cannot install the RouteKit daemon: set ` +
          `${missingCredentials.join(" or ")} for the configured provider`
      });
    }
    const graceMs = drainGraceMs(options.drainGrace);
    const authTokenFile = ensureDaemonDataToken(options.authToken);
    const serveArgs = daemonServeArgs({
      configPath,
      host: options.host,
      port: Number.parseInt(options.port, 10),
      authTokenFile,
      ...(options.portless !== undefined ? { portless: options.portless } : {}),
      drainGraceMs: graceMs
    });
    const controller = await platformSupervisor();
    if (controller === undefined) {
      // No init supervisor (container, WSL without a systemd user session):
      // fall back to the detached daemon so the service still starts, but be
      // explicit that crash/reboot restarts are not guaranteed here.
      ctx.presenter.warn(
        "no OS supervisor is available; starting a detached daemon instead " +
          "(it will not restart after a crash or reboot)"
      );
      const started = await ensureDaemon({
        configPath,
        port: Number.parseInt(options.port, 10),
        ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
        ...(options.portless !== undefined ? { portless: options.portless } : {}),
        drainGraceMs: graceMs
      });
      const status = await started.client.call("daemon.status", {});
      if (ctx.json) ctx.emit({ installed: false, fallback: "detached", ...status });
      else ctx.presenter.success(`RouteKit daemon started at ${status.dataUrl}`);
      return;
    }
    const lock = await acquireLifecycleLock(daemonLifecycleLockPath(), {
      timeoutMs: supervisorOperationTimeoutMs(graceMs)
    });
    try {
      const previous = readDaemonRecord();
      // An unsupervised daemon on the same record/port must hand over first.
      if (previous !== undefined && previous.supervisor === "detached") {
        await controlClientForRecord(previous).call(
          "daemon.prepareShutdown",
          { reason: "restart" },
          { idempotencyKey: `service-install-${previous.generation ?? previous.pid}` }
        );
        if (
          !(await waitForProcessExit(
            previous.pid,
            supervisorOperationTimeoutMs(previous.drainGraceMs),
            previous.processIdentity
          ))
        ) {
          throw new Error(`RouteKit daemon pid ${previous.pid} did not drain`);
        }
      }
      const spec = daemonUnitSpec({
        args: serveArgs,
        supervisor: controller.kind,
        env: serviceEnvironment(result.config),
        drainGraceMs: graceMs
      });
      await controller.install(spec);
      const record = await waitForServiceReady({
        home: routekitHome(),
        product: ROUTEKIT_PRODUCT,
        kind: "daemon",
        timeoutMs: supervisorOperationTimeoutMs(graceMs),
        ...(previous !== undefined ? { previousPid: previous.pid } : {}),
        logFile: daemonLogPath(),
        ready: daemonRecordHealthy
      });
      if (ctx.json) {
        ctx.emit({
          installed: true,
          supervisor: controller.kind,
          unit: controller.unitName,
          unitPath: controller.unitPath,
          url: record.dataUrl,
          pid: record.pid,
          version: record.version
        });
        return;
      }
      ctx.presenter.success(`RouteKit daemon installed as ${controller.unitName} (${controller.kind})`);
      ctx.presenter.line(`  listening at ${record.dataUrl} (pid ${record.pid})`);
      ctx.presenter.note(
        controller.kind === "systemd"
          ? `logs: journalctl --user -u ${controller.unitName} (or \`routekit daemon logs\`)`
          : `logs: ${daemonLogPath()} (or \`routekit daemon logs\`)`
      );
    } finally {
      lock.release();
    }
  });
}

function registerUninstall(group: Command): void {
  group
    .command("uninstall")
    .description("stop the supervised daemon and remove its unit")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      try {
        const record = readDaemonRecord();
        const kind =
          record?.supervisor === "systemd" || record?.supervisor === "launchd"
            ? record.supervisor
            : undefined;
        const controller =
          kind !== undefined ? daemonSupervisorController(kind) : await platformSupervisor();
        let removed = false;
        let stopped = false;
        if (controller !== undefined) {
          removed = await controller.uninstall({
            timeoutMs: supervisorOperationTimeoutMs(record?.drainGraceMs)
          });
          if (
            removed &&
            record !== undefined &&
            (record.supervisor === "systemd" || record.supervisor === "launchd")
          ) {
            stopped = await waitForProcessExit(
              record.pid,
              supervisorOperationTimeoutMs(record.drainGraceMs),
              record.processIdentity
            );
            if (!stopped) throw new Error(`RouteKit daemon pid ${record.pid} did not stop`);
          }
        }
        if (record !== undefined && record.supervisor === "detached") {
          await controlClientForRecord(record).call(
            "daemon.prepareShutdown",
            { reason: "stop" },
            { idempotencyKey: `service-uninstall-${record.generation ?? record.pid}` }
          );
          stopped = await waitForProcessExit(
            record.pid,
            supervisorOperationTimeoutMs(record.drainGraceMs),
            record.processIdentity
          );
          if (!stopped) throw new Error(`RouteKit daemon pid ${record.pid} did not stop`);
        }
        const stopResult = { stopped, pid: record?.pid };
        if (removed || stopped) removeServiceEnvFile("daemon");
        if (ctx.json) {
          ctx.emit({ uninstalled: removed, service: stopResult });
          return;
        }
        if (removed) ctx.presenter.success("removed the RouteKit daemon service");
        else if (stopResult.stopped) ctx.presenter.success("stopped the RouteKit daemon");
        else ctx.presenter.note("no RouteKit daemon service is installed");
      } finally {
        lock.release();
      }
    });
}

function registerServiceStatus(group: Command): void {
  group
    .command("status")
    .description("show the OS supervisor state of the daemon")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const record = readDaemonRecord();
      const kind =
        record?.supervisor === "systemd" || record?.supervisor === "launchd"
          ? record.supervisor
          : undefined;
      const controller =
        kind !== undefined ? daemonSupervisorController(kind) : await platformSupervisor();
      const status = controller === undefined ? undefined : await controller.status();
      const healthy = record !== undefined && (await daemonRecordHealthy(record));
      if (ctx.json) {
        const publicRecord =
          record === undefined
            ? undefined
            : {
                product: record.product,
                kind: record.kind,
                pid: record.pid,
                dataUrl: record.dataUrl,
                dataPort: record.dataPort,
                startedAt: record.startedAt,
                version: record.version,
                protocolVersion: record.protocolVersion,
                generation: record.generation,
                supervisor: record.supervisor
              };
        ctx.emit({
          supervisor: controller?.kind,
          unit: controller?.unitName,
          unitPath: controller?.unitPath,
          installed: status?.installed ?? false,
          active: status?.active ?? false,
          healthy,
          record: publicRecord
        });
        return;
      }
      if (controller === undefined) {
        ctx.presenter.note("no OS supervisor is available on this system");
      } else {
        ctx.presenter.line(
          `${controller.unitName} (${controller.kind}): ` +
            `${status?.installed === true ? "installed" : "not installed"}, ` +
            `${status?.active === true ? "active" : "inactive"}`
        );
      }
      if (record !== undefined) {
        ctx.presenter.line(
          `daemon ${healthy ? "running" : "unhealthy"} at ${record.dataUrl ?? record.url} (pid ${record.pid}` +
            `${record.version !== undefined ? `, v${record.version}` : ""}` +
            `, ${record.supervisor ?? "detached"})`
        );
      } else {
        ctx.presenter.line("daemon is not running");
      }
    });
}

export function registerDaemonService(program: Command): void {
  const group = program
    .command("service")
    .description("manage the singleton daemon as a persistent OS service");
  registerInstall(group);
  registerUninstall(group);
  registerServiceStatus(group);
}

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("show the singleton daemon logs")
    .option("-n, --lines <count>", "number of trailing lines", "50")
    .option("-f, --follow", "keep printing new log lines")
    .action(async (options: { lines: string; follow?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (ctx.json) {
        throw new CliError({ message: "`daemon logs` is a live human view and cannot be combined with --json" });
      }
      const lines = Number.parseInt(options.lines, 10);
      if (!Number.isInteger(lines) || lines <= 0) {
        throw new CliError({ message: "--lines must be a positive integer" });
      }
      const record = readDaemonRecord();
      if (record?.supervisor === "systemd") {
        // A systemd-supervised daemon logs to the journal, not the log file.
        const args = [
          "--user",
          "-u",
          systemdUnitName(ROUTEKIT_PRODUCT, "daemon"),
          "-n",
          String(lines)
        ];
        if (options.follow === true) args.push("-f");
        process.exitCode = await spawnTool("journalctl", args, {});
        return;
      }
      const path = daemonLogPath();
      const tail = readLogTail(path);
      if (tail.length === 0) {
        ctx.presenter.note(`no logs at ${path}`);
        if (options.follow !== true) return;
      }
      const trailing = tail.split("\n").filter((line) => line.length > 0).slice(-lines);
      // Log content goes to stdout (pipeable), not the presenter (stderr).
      if (trailing.length > 0) process.stdout.write(`${trailing.join("\n")}\n`);
      if (options.follow !== true) return;
      // Poll-based follow: read appended bytes until interrupted.
      let offset = (() => {
        try {
          return statSync(path).size;
        } catch {
          return 0;
        }
      })();
      const { createReadStream } = await import("node:fs");
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          continue;
        }
        if (size < offset) offset = 0; // rotated
        if (size === offset) continue;
        const chunk: string = await new Promise((resolve) => {
          let data = "";
          createReadStream(path, { start: offset, end: size - 1, encoding: "utf8" })
            .on("data", (part: string | Buffer) => (data += part.toString()))
            .on("end", () => resolve(data))
            .on("error", () => resolve(data));
        });
        offset = size;
        process.stdout.write(chunk);
      }
    });
}
