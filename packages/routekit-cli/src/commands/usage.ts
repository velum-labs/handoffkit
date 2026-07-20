import { SubscriptionProxyClient } from "@routekit/accounts";
import type { SubscriptionUsageResponse } from "@routekit/accounts";
import { CliError, contextFor } from "@routekit/cli-core";
import { renderErrorPanelLines, watch } from "@routekit/cli-ui";
import type { Command } from "commander";

import { readServiceRecord } from "../state.js";
import { renderUsageLines } from "../usage-format.js";

const TRY_ACCOUNTS_SERVE = "routekit accounts serve";

function unavailable(message: string): CliError {
  return new CliError({
    code: "accounts_proxy_unavailable",
    message,
    hint: "Usage is reported by the local accounts proxy.",
    tryCommand: TRY_ACCOUNTS_SERVE
  });
}

export async function fetchSubscriptionUsage(): Promise<SubscriptionUsageResponse> {
  const record = readServiceRecord("accounts");
  if (record === undefined) throw unavailable("The accounts proxy is not running.");
  if (record.authToken === undefined) {
    throw unavailable("The accounts proxy service record has no authentication token.");
  }
  try {
    return await SubscriptionProxyClient.open({
      baseUrl: record.url,
      token: record.authToken
    }).usage();
  } catch (error) {
    throw unavailable(
      `Could not read usage from ${record.url}: ${error instanceof Error ? error.message : String(error)}`
    );
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
    hint: "Usage is reported by the local accounts proxy.",
    tryCommand: TRY_ACCOUNTS_SERVE
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
        await watch(
          ctx.presenter,
          watchInterval(options.watch),
          async () => renderUsageLines(await fetchSubscriptionUsage()),
          { errorFrame: usageErrorLines }
        );
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
