import {
  openLocalSubscriptionUsage,
  SubscriptionProxyClient
} from "@routekit/accounts";
import type {
  SubscriptionUsageResponse,
  SubscriptionUsageSource
} from "@routekit/accounts";
import { CliError, contextFor } from "@routekit/cli-core";
import { renderErrorPanelLines, watch } from "@routekit/cli-ui";
import type { Command } from "commander";

import { readServiceRecord } from "../state.js";
import { renderUsageLines } from "../usage-format.js";

const TRY_DOCTOR = "routekit doctor";

function unavailable(message: string): CliError {
  return new CliError({
    code: "subscription_usage_unavailable",
    message,
    hint: "Check enrolled subscription accounts and provider connectivity.",
    tryCommand: TRY_DOCTOR
  });
}

function prefetchedUsageSource(
  client: SubscriptionProxyClient,
  first: SubscriptionUsageResponse
): SubscriptionUsageSource {
  let prefetched: SubscriptionUsageResponse | undefined = first;
  return {
    usage: async () => {
      if (prefetched !== undefined) {
        const usage = prefetched;
        prefetched = undefined;
        return usage;
      }
      return await client.usage();
    },
    close: async () => {}
  };
}

export async function openSubscriptionUsageSource(): Promise<SubscriptionUsageSource> {
  for (const kind of ["gateway", "accounts"] as const) {
    const record = readServiceRecord(kind);
    if (record === undefined) continue;
    const client = SubscriptionProxyClient.open({
      baseUrl: record.url,
      ...(record.authToken !== undefined ? { token: record.authToken } : {})
    });
    try {
      return prefetchedUsageSource(client, await client.usage());
    } catch {
      // Old, unreachable, or unhealthy services do not make usage unavailable:
      // try the next live service before opening the enrolled accounts locally.
    }
  }

  try {
    return await openLocalSubscriptionUsage();
  } catch (error) {
    throw unavailable(
      `Could not open enrolled subscription accounts: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function fetchSubscriptionUsage(): Promise<SubscriptionUsageResponse> {
  const source = await openSubscriptionUsageSource();
  try {
    return await source.usage();
  } finally {
    await source.close();
  }
}

function watchInterval(value: string | boolean): number {
  if (value === true) return 5;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 86_400) {
    throw new CliError({ message: "watch interval must be between 0.1 and 86400 seconds" });
  }
  return parsed;
}

function usageErrorLines(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  return renderErrorPanelLines({
    title: "usage unavailable",
    message,
    hint: "Check enrolled subscription accounts and provider connectivity.",
    tryCommand: TRY_DOCTOR
  });
}

export function registerUsage(program: Command): void {
  program
    .command("usage")
    .description("show account rate limits, credits, and reset windows")
    .option("--watch [seconds]", "refresh continuously (default: 5 seconds)")
    .action(async (options: { watch?: string | boolean }, command: Command) => {
      const ctx = contextFor(command);
      if (options.watch !== undefined && ctx.json) {
        throw new CliError({
          message: "`usage --watch` is a live human view and cannot be combined with --json"
        });
      }
      if (options.watch !== undefined) {
        const source = await openSubscriptionUsageSource();
        try {
          await watch(
            ctx.presenter,
            watchInterval(options.watch),
            async () => renderUsageLines(await source.usage()),
            { errorFrame: usageErrorLines }
          );
        } finally {
          await source.close();
        }
        return;
      }
      try {
        const usage = await fetchSubscriptionUsage();
        if (ctx.json) ctx.emit(usage);
        else for (const line of renderUsageLines(usage)) ctx.presenter.line(line);
      } catch (error) {
        if (ctx.json || !(error instanceof CliError)) throw error;
        ctx.presenter.errorPanel({
          message: error.message,
          hint: error.hint,
          tryCommand: error.tryCommand
        });
        process.exitCode = error.exitCode;
      }
    });
}
