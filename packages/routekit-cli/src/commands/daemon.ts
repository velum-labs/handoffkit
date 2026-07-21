import { Command } from "commander";

import { contextFor, parsePort } from "@routekit/cli-core";
import { readFileSync } from "node:fs";
import { startRouteKitDaemon } from "@routekit/daemon";
import {
  acquireLifecycleLock,
  processAlive,
  stopDaemonProcess,
  supervisorController,
  supervisorOperationTimeoutMs,
  waitForProcessExit
} from "@routekit/runtime";

import {
  controlClientForRecord,
  connectDaemon,
  daemonLifecycleLockPath,
  daemonDataTokenPath,
  ensureDaemon,
  readDaemonRecord
} from "../client.js";
import { routekitVersion } from "../state.js";
import { registerDaemonService, registerLogs } from "./gateway-service.js";
import { registerRestart, registerStart } from "./start.js";
import { registerUpgrade } from "./upgrade.js";

function registerRun(group: Command): void {
  const run = new Command("run")
    .description("run the singleton RouteKit daemon in the foreground (internal)")
    .requiredOption("--config-path <path>", "canonical global router config")
    .option("--host <host>", "data-plane bind host", "127.0.0.1")
    .option("--port <port>", "data-plane bind port", "8080")
    .option("--auth-token-file <path>", "private data-plane token file")
    .option("--no-portless", "disable the stable local route")
    .option("--drain-grace-ms <ms>", "in-flight drain grace in milliseconds", "30000")
    .action(
      async (
        options: {
          configPath: string;
          host: string;
          port: string;
          authTokenFile?: string;
          portless?: boolean;
          drainGraceMs: string;
        },
        command: Command
      ) => {
        const ctx = contextFor(command);
        let running: Awaited<ReturnType<typeof startRouteKitDaemon>> | undefined;
        let shutdownRequested = false;
        const requestShutdown = (): void => {
          if (shutdownRequested) return;
          shutdownRequested = true;
          setImmediate(() => {
            void running?.close().finally(() => process.exit(0));
          });
        };
        running = await startRouteKitDaemon({
          packageVersion: routekitVersion(),
          configPath: options.configPath,
          host: options.host,
          port: parsePort(options.port, 8080),
          ...(options.authTokenFile !== undefined
            ? { authTokenFile: options.authTokenFile }
            : {}),
          ...(options.portless !== undefined ? { portless: options.portless } : {}),
          drainGraceMs: Number.parseInt(options.drainGraceMs, 10),
          onShutdownRequested: requestShutdown
        });
        if (ctx.json) {
          ctx.emit({
            event: "listening",
            controlUrl: running.controlUrl,
            dataUrl: running.dataUrl,
            pid: running.record.pid,
            generation: running.record.generation
          });
        } else {
          ctx.presenter.success(`RouteKit daemon listening at ${running.dataUrl}`);
          ctx.presenter.note(`control: ${running.controlUrl} · pid ${running.record.pid}`);
          ctx.presenter.note("Press Ctrl+C to stop.");
        }
        await new Promise<never>(() => undefined);
      }
    );
  group.addCommand(run, { hidden: true });
}

function registerStatus(group: Command): void {
  group
    .command("status")
    .description("show singleton daemon and data-plane status")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const connected = await connectDaemon();
      if (connected === undefined) {
        const record = readDaemonRecord();
        if (ctx.json) {
          ctx.emit({
            running: record !== undefined,
            healthy: false,
            ...(record !== undefined ? { pid: record.pid } : {})
          });
        } else {
          ctx.presenter.note(
            record === undefined ? "RouteKit daemon is stopped" : "RouteKit daemon is unhealthy"
          );
        }
        return;
      }
      const status = await connected.client.call("daemon.status", {});
      if (ctx.json) ctx.emit(status);
      else {
        ctx.presenter.success(
          `RouteKit daemon v${status.packageVersion} is running (pid ${status.pid})`
        );
        ctx.presenter.line(`  gateway: ${status.dataUrl}`);
        ctx.presenter.line(
          `  generation ${status.generation} · config revision ${status.configRevision} · ` +
            `account revision ${status.accountRevision}`
        );
      }
    });
}

function registerReload(group: Command): void {
  group
    .command("reload")
    .description("transactionally reload the canonical config and accounts")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const { client } = await ensureDaemon();
      const result = await client.call(
        "daemon.reload",
        {},
        { idempotencyKey: `reload-${Date.now()}` }
      );
      if (ctx.json) ctx.emit(result);
      else {
        ctx.presenter.success(
          `RouteKit daemon reloaded (config revision ${result.configRevision})`
        );
      }
    });
}

function registerStop(group: Command): void {
  group
    .command("stop")
    .description("gracefully stop the singleton RouteKit daemon")
    .option("--force", "SIGKILL if the control plane cannot drain")
    .action(async (options: { force?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const lock = await acquireLifecycleLock(daemonLifecycleLockPath());
      try {
        const record = readDaemonRecord();
        if (record === undefined) {
          if (ctx.json) ctx.emit({ stopped: false });
          else ctx.presenter.note("RouteKit daemon is not running");
          return;
        }
        let requested = false;
        if (record.supervisor === "systemd" || record.supervisor === "launchd") {
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
        else ctx.presenter.success("stopped RouteKit daemon");
      } finally {
        lock.release();
      }
    });
}

function registerAuth(group: Command): void {
  const auth = group.command("auth").description("manage daemon data-plane authentication");
  auth
    .command("show")
    .description("explicitly print the private data-plane token")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const token = readFileSync(daemonDataTokenPath(), "utf8").trim();
      if (ctx.json) ctx.emit({ token });
      else process.stdout.write(`${token}\n`);
    });
}

export function registerDaemon(program: Command): void {
  const group = program
    .command("daemon")
    .description("manage the singleton RouteKit daemon");
  registerRun(group);
  registerStart(group);
  registerRestart(group);
  registerUpgrade(group);
  registerStatus(group);
  registerReload(group);
  registerStop(group);
  registerAuth(group);
  registerLogs(group);
  registerDaemonService(group);
}
