import { contextFor } from "@routekit/cli-core";
import type { RouterConfig } from "@routekit/gateway";
import type { Command } from "commander";

import { accountsStatus } from "../accounts.js";
import { readServiceRecord } from "../state.js";

import { loaded } from "./context.js";

type PublicServiceStatus = {
  running: boolean;
  url?: string;
  pid?: number;
  startedAt?: string;
};

function serviceStatus(kind: "gateway" | "accounts"): PublicServiceStatus {
  const record = readServiceRecord(kind);
  return record === undefined
    ? { running: false }
    : {
        running: true,
        url: record.url,
        pid: record.pid,
        startedAt: record.startedAt
      };
}

export async function collectRouteKitStatus(config: RouterConfig) {
  const accountState = await accountsStatus(config);
  return {
    ready:
      accountState.accounts.every(
        (account) => account.credentialValid && account.configured
      ),
    services: {
      gateway: serviceStatus("gateway"),
      accounts: serviceStatus("accounts")
    },
    accounts: accountState.accounts,
    usage: accountState.usage ?? null
  };
}

export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("show RouteKit service, account, and usage status")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = await collectRouteKitStatus(loaded(command).config);
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      for (const [kind, service] of Object.entries(status.services)) {
        ctx.presenter.status(
          service.running ? "ok" : "pending",
          `${kind} service`,
          service.running ? service.url : "not running"
        );
      }
      for (const account of status.accounts) {
        ctx.presenter.status(
          account.credentialValid && account.configured ? "ok" : "pending",
          `${account.subscriptionKind}/${account.label}`,
          !account.credentialValid
            ? "credential invalid"
            : account.configured
              ? "configured"
              : "routing disabled"
        );
      }
      if (status.usage === null) {
        ctx.presenter.note(
          "usage unavailable; start `routekit accounts serve` to expose pooled subscription usage"
        );
      }
    });

  program
    .command("usage")
    .description("show pooled subscription usage without credential data")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = await accountsStatus(loaded(command).config);
      const result = {
        available: status.usage !== undefined,
        usage: status.usage ?? null,
        accounts: status.accounts.map((account) => ({
          subscriptionKind: account.subscriptionKind,
          label: account.label,
          configured: account.configured,
          credentialValid: account.credentialValid
        }))
      };
      if (ctx.json) {
        ctx.emit(result);
        return;
      }
      if (result.usage === null) {
        ctx.presenter.note(
          "usage unavailable; start `routekit accounts serve` and retry"
        );
        return;
      }
      ctx.presenter.table(
        Object.entries(result.usage).map(([name, value]) => [
          name,
          JSON.stringify(value)
        ])
      );
    });
}
