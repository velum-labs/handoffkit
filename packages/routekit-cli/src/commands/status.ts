import { contextFor, CliError } from "@routekit/cli-core";
import { glyph, watch } from "@routekit/cli-ui";
import type { Command } from "commander";

import { connectDaemon, readDaemonRecord } from "../client.js";
import { routekitVersion } from "../state.js";

function stateMark(ok: boolean): string {
  return ok ? glyph.tick() : glyph.pending();
}

function interval(value: string | boolean): number {
  if (value === true) return 5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 86_400) {
    throw new CliError({ message: "watch interval must be between 0.1 and 86400 seconds" });
  }
  return parsed;
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("show services, providers, accounts, and cached models at a glance")
    .option("--watch [seconds]", "refresh continuously (default: 5 seconds)")
    .action(async (options: { watch?: string | boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (options.watch !== undefined && ctx.json) {
        throw new CliError({
          message: "`status --watch` is a live human view and cannot be combined with --json"
        });
      }
      const collect = async () => {
        const connected = await connectDaemon();
        if (connected === undefined) {
          const record = readDaemonRecord();
          const unhealthy = record !== undefined;
          return {
            observedAt: new Date().toISOString(),
            cliVersion: routekitVersion(),
            daemon: {
              running: unhealthy,
              healthy: false,
              ...(record !== undefined ? { pid: record.pid } : {})
            },
            services: [
              { kind: "gateway", running: unhealthy, reachable: false },
              { kind: "accounts", running: unhealthy, reachable: false }
            ],
            providers: [],
            accounts: { running: false, accounts: [] },
            models: { count: 0, cached: false },
            catalog: { models: [] }
          };
        }
        const client = connected.client;
        const [daemon, providers, accounts, models] = await Promise.all([
          client.call("daemon.status", {}),
          client.call("providers.status", {}),
          client.call("accounts.status", {}),
          client.call("models.list", {})
        ]);
        const observedAt = new Date().toISOString();
        return {
          observedAt,
          cliVersion: routekitVersion(),
          daemon,
          services: [
            {
              kind: "gateway",
              running: true,
              url: daemon.dataUrl,
              pid: daemon.pid,
              startedAt: daemon.startedAt,
              uptimeSeconds: Math.max(
                0,
                Math.round((Date.now() - Date.parse(daemon.startedAt)) / 1000)
              ),
              reachable: true,
              version: daemon.packageVersion,
              supervisor: daemon.supervisor
            },
            {
              kind: "accounts",
              running: true,
              url: daemon.dataUrl,
              pid: daemon.pid,
              startedAt: daemon.startedAt,
              uptimeSeconds: Math.max(
                0,
                Math.round((Date.now() - Date.parse(daemon.startedAt)) / 1000)
              ),
              reachable: true,
              version: daemon.packageVersion,
              supervisor: daemon.supervisor
            }
          ],
          providers: providers.providers.map((provider) => ({
            ...provider,
            configured: true as const,
            credential: provider.credentialAvailable
              ? "available"
              : "missing",
            lastCheck: {
              ok: provider.error === undefined,
              ...(provider.error !== undefined ? { error: provider.error } : {}),
              models: provider.models?.length ?? 0
            }
          })),
          accounts: {
            running: true,
            url: daemon.dataUrl,
            pid: daemon.pid,
            accounts: accounts.accounts,
            revision: accounts.revision
          },
          models: {
            count: models.models.length,
            ...(models.defaultModel !== undefined
              ? { defaultModel: models.defaultModel }
              : {}),
            cached: false
          },
          catalog: models
        };
      };
      if (options.watch !== undefined) {
        await watch(ctx.presenter, interval(options.watch), async () =>
          renderDaemonOverviewLines(await collect())
        );
        return;
      }
      const overview = await collect();
      if (ctx.json) ctx.emit(overview);
      else for (const line of renderDaemonOverviewLines(overview)) ctx.presenter.line(line);
    });
}

function renderDaemonOverviewLines(
  overview: {
    daemon: {
      running?: boolean;
      healthy?: boolean;
      pid?: number;
      packageVersion?: string;
      dataUrl?: string;
      generation?: number;
      configRevision?: number;
    };
    providers: Array<{
        provider: string;
        credentialAvailable: boolean;
        models?: readonly string[];
        error?: string;
      }>;
    accounts: {
      accounts: Array<{
        subscriptionKind: string;
        label: string;
        credentialValid: boolean;
        configured?: boolean;
        relayOpen?: boolean;
      }>;
    };
    models: { count: number; defaultModel?: string };
    catalog: { models: Array<{ id: string }>; defaultModel?: string };
  }
): string[] {
  if (overview.daemon.running === false) {
    return ["RouteKit status", "", `  ${stateMark(false)} daemon stopped`];
  }
  if (overview.daemon.healthy === false) {
    return ["RouteKit status", "", `  ${stateMark(false)} daemon unhealthy`];
  }
  const lines = [
    "RouteKit status",
    "",
    `  ${stateMark(true)} daemon v${overview.daemon.packageVersion} · pid ${overview.daemon.pid} · generation ${overview.daemon.generation}`,
    `  ${stateMark(true)} gateway ${overview.daemon.dataUrl}`,
    `  ${stateMark(true)} config revision ${overview.daemon.configRevision}`,
    "",
    "Providers"
  ];
  for (const provider of overview.providers) {
    const ok = provider.credentialAvailable && provider.error === undefined;
    lines.push(
      `  ${stateMark(ok)} ${provider.provider} · ${
        provider.error ??
        `${provider.models?.length ?? 0} model(s) · ${
          provider.credentialAvailable ? "credential ready" : "credential missing"
        }`
      }`
    );
  }
  lines.push("", "Accounts");
  if (overview.accounts.accounts.length === 0) lines.push("  no enrolled accounts");
  for (const account of overview.accounts.accounts) {
    lines.push(
      `  ${stateMark(
        account.credentialValid &&
          account.configured !== false &&
          account.relayOpen !== false
      )} ${account.subscriptionKind}/${account.label}` +
        (account.configured === false
          ? " · routing disabled"
          : account.relayOpen === false
            ? " · relay unavailable or cooling"
            : "")
    );
  }
  lines.push(
    "",
    `Models`,
    `  ${stateMark(overview.catalog.models.length > 0)} ${overview.catalog.models.length} live model(s)` +
      (overview.catalog.defaultModel === undefined
        ? ""
        : ` · default ${overview.catalog.defaultModel}`)
  );
  return lines;
}
