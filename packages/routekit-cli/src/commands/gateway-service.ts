import { createReadStream, statSync } from "node:fs";

import { contextFor, CliError } from "@routekit/cli-core";
import {
  detectSupervisor,
  readLogTail,
  spawnTool,
  startDaemon,
  supervisorController,
  systemdUnitName,
  waitForServiceReady
} from "@routekit/runtime";
import type { SupervisorController } from "@routekit/runtime";
import type { Command } from "commander";

import { routekitHome } from "../config.js";
import {
  gatewayDaemonSpec,
  gatewayLogPath,
  gatewayUnitSpec,
  removeServiceEnvFile,
  ROUTEKIT_PRODUCT,
  serviceEnvironment
} from "../daemon.js";
import { readServiceRecord, stopService } from "../state.js";

import { configOverride, loaded } from "./context.js";
import { attachServeOptions, drainGraceMs, serveArgvFrom } from "./serve-options.js";
import type { GatewayServeCliOptions } from "./serve-options.js";
import { emitStarted } from "./start.js";

const READY_TIMEOUT_MS = 60_000;

export function gatewaySupervisorController(
  kind: "systemd" | "launchd"
): SupervisorController {
  return supervisorController(kind, ROUTEKIT_PRODUCT, "gateway");
}

export async function platformSupervisor(): Promise<SupervisorController | undefined> {
  return await detectSupervisor(ROUTEKIT_PRODUCT, "gateway");
}

function registerInstall(group: Command): void {
  attachServeOptions(
    group
      .command("install")
      .description(
        "install the gateway as an OS-supervised service (systemd/launchd) that restarts on crash and reboot"
      )
  ).action(async (options: GatewayServeCliOptions, command: Command) => {
    const ctx = contextFor(command);
    const result = loaded(command);
    const graceMs = drainGraceMs(options.drainGrace);
    const serveArgs = serveArgvFrom({
      options,
      ...(configOverride(command) !== undefined ? { configPath: configOverride(command) } : {})
    });
    const controller = await platformSupervisor();
    const previous = readServiceRecord("gateway");
    if (controller === undefined) {
      // No init supervisor (container, WSL without a systemd user session):
      // fall back to the detached daemon so the service still starts, but be
      // explicit that crash/reboot restarts are not guaranteed here.
      ctx.presenter.warn(
        "no OS supervisor is available; starting a detached daemon instead " +
          "(it will not restart after a crash or reboot)"
      );
      const started = await startDaemon(gatewayDaemonSpec({ args: serveArgs }), {
        readyTimeoutMs: READY_TIMEOUT_MS
      });
      emitStarted(ctx, started);
      return;
    }
    // An unsupervised daemon on the same record/port must hand over first.
    if (previous !== undefined && previous.supervisor === "detached") {
      await stopService("gateway", { graceMs: graceMs + 10_000 });
    }
    const spec = gatewayUnitSpec({
      args: serveArgs,
      supervisor: controller.kind,
      env: serviceEnvironment(result.config),
      drainGraceMs: graceMs
    });
    await controller.install(spec);
    const record = await waitForServiceReady({
      home: routekitHome(),
      product: ROUTEKIT_PRODUCT,
      kind: "gateway",
      timeoutMs: READY_TIMEOUT_MS,
      ...(previous !== undefined ? { previousPid: previous.pid } : {}),
      logFile: gatewayLogPath()
    });
    if (ctx.json) {
      ctx.emit({
        installed: true,
        supervisor: controller.kind,
        unit: controller.unitName,
        unitPath: controller.unitPath,
        url: record.url,
        pid: record.pid,
        version: record.version
      });
      return;
    }
    ctx.presenter.success(`RouteKit gateway installed as ${controller.unitName} (${controller.kind})`);
    ctx.presenter.line(`  listening at ${record.url} (pid ${record.pid})`);
    ctx.presenter.note(
      controller.kind === "systemd"
        ? `logs: journalctl --user -u ${controller.unitName} (or \`routekit gateway logs\`)`
        : `logs: ${gatewayLogPath()} (or \`routekit gateway logs\`)`
    );
  });
}

function registerUninstall(group: Command): void {
  group
    .command("uninstall")
    .description("stop the supervised gateway service and remove its unit")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const record = readServiceRecord("gateway");
      const kind =
        record?.supervisor === "systemd" || record?.supervisor === "launchd"
          ? record.supervisor
          : undefined;
      const controller =
        kind !== undefined ? gatewaySupervisorController(kind) : await platformSupervisor();
      let removed = false;
      if (controller !== undefined) removed = await controller.uninstall();
      // Reap the record/portless route (and any detached fallback daemon).
      const stopResult = await stopService("gateway");
      removeServiceEnvFile("gateway");
      if (ctx.json) {
        ctx.emit({ uninstalled: removed, service: stopResult });
        return;
      }
      if (removed) ctx.presenter.success("removed the RouteKit gateway service");
      else if (stopResult.stopped) ctx.presenter.success("stopped the RouteKit gateway daemon");
      else ctx.presenter.note("no RouteKit gateway service is installed");
    });
}

function registerServiceStatus(group: Command): void {
  group
    .command("status")
    .description("show the OS supervisor state of the gateway service")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const record = readServiceRecord("gateway");
      const kind =
        record?.supervisor === "systemd" || record?.supervisor === "launchd"
          ? record.supervisor
          : undefined;
      const controller =
        kind !== undefined ? gatewaySupervisorController(kind) : await platformSupervisor();
      const status = controller === undefined ? undefined : await controller.status();
      if (ctx.json) {
        ctx.emit({
          supervisor: controller?.kind,
          unit: controller?.unitName,
          unitPath: controller?.unitPath,
          installed: status?.installed ?? false,
          active: status?.active ?? false,
          record
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
          `gateway running at ${record.url} (pid ${record.pid}` +
            `${record.version !== undefined ? `, v${record.version}` : ""}` +
            `, ${record.supervisor ?? "detached"})`
        );
      } else {
        ctx.presenter.line("gateway is not running");
      }
    });
}

export function registerGatewayService(program: Command): void {
  const group = program
    .command("service")
    .description("manage the gateway as a persistent OS service");
  registerInstall(group);
  registerUninstall(group);
  registerServiceStatus(group);
}

export function registerLogs(program: Command): void {
  program
    .command("logs")
    .description("show the gateway service logs")
    .option("-n, --lines <count>", "number of trailing lines", "50")
    .option("-f, --follow", "keep printing new log lines")
    .action(async (options: { lines: string; follow?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (ctx.json) {
        throw new CliError({ message: "`gateway logs` is a live human view and cannot be combined with --json" });
      }
      const lines = Number.parseInt(options.lines, 10);
      if (!Number.isInteger(lines) || lines <= 0) {
        throw new CliError({ message: "--lines must be a positive integer" });
      }
      const record = readServiceRecord("gateway");
      if (record?.supervisor === "systemd") {
        // A systemd-supervised gateway logs to the journal, not the log file.
        const args = [
          "--user",
          "-u",
          systemdUnitName(ROUTEKIT_PRODUCT, "gateway"),
          "-n",
          String(lines)
        ];
        if (options.follow === true) args.push("-f");
        process.exitCode = await spawnTool("journalctl", args, {});
        return;
      }
      const path = gatewayLogPath();
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
