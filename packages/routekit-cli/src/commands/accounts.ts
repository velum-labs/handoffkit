/**
 * Public enrollment is limited to the first-launch subscription contract.
 * Additional connector implementations remain available internally for
 * compatibility, but registry presence does not make them supported UX.
 */
import {
  captureLoginCredential,
  captureCliproxyLoginCredentials,
  defaultSubscriptionCredentialPath,
  parseAccountMode,
  resolveAccountKind
} from "@routekit/accounts";
import { contextFor } from "@routekit/cli-core";
import { resolveAccountConnector } from "@routekit/registry";
import { randomId } from "@routekit/runtime";
import type { Command } from "commander";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { routekitClient } from "../client.js";
import {
  isLaunchAccountKind,
  LAUNCH_ACCOUNT_KINDS
} from "../launch-support.js";

/** The router provider a subscription kind routes through. */
function providerForKind(kind: string, connector: "native" | "cliproxy"): string {
  return connector === "cliproxy" ? "cliproxy" : kind;
}

function isCliproxyAccount(entry: {
  subscriptionKind?: string;
  connector?: string;
}): boolean {
  if (entry.connector === "cliproxy") return true;
  if (entry.subscriptionKind === undefined) return false;
  return resolveAccountConnector(entry.subscriptionKind)?.info.connector === "cliproxy";
}

function activationKey(
  kind: string,
  accounts: Array<{ label: string; credential?: unknown }>
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ kind, accounts }))
    .digest("hex");
  return `account-enroll-activate-${fingerprint}`;
}

const LOCAL_ONLY_WARNING =
  "this connector reuses subscription OAuth tokens through reverse-engineered " +
  "endpoints; providers restrict that to personal/local use — do not expose it " +
  "through a shared gateway";

export function registerAccounts(program: Command): void {
  const accounts = program.command("accounts").description("manage pooled provider subscriptions");

  accounts
    .command("login <subscription-kind>")
    .description(`enroll a subscription account (${LAUNCH_ACCOUNT_KINDS.join(", ")})`)
    .option("--name <name>", "account label (native subscription kinds)")
    .option(
      "--no-browser",
      "prefer a browserless login flow (device code / copyable URL)"
    )
    .action(
      async (
        subscriptionKind: string,
        options: { name?: string; browser?: boolean },
        command: Command
      ) => {
        const ctx = contextFor(command);
        if (ctx.json || ctx.noInput) {
          throw new Error(
            "`accounts login` is interactive and does not support --json or --no-input"
          );
        }
        const resolved = resolveAccountKind(subscriptionKind);
        if (!isLaunchAccountKind(resolved.kind)) {
          throw new Error(
            `subscription kind ${JSON.stringify(subscriptionKind)} is not offered at first launch; ` +
              `supported kinds: ${LAUNCH_ACCOUNT_KINDS.join(", ")}`
          );
        }
        const noBrowser = options.browser === false;
        if (resolved.localOnly) ctx.presenter.warn(`${resolved.kind}: ${LOCAL_ONLY_WARNING}`);
        const client = await routekitClient();
        let enrolledAccounts: Array<{ label: string; credential?: unknown }>;
        if (resolved.connector === "native") {
          if (options.name === undefined) {
            throw new Error(
              `\`accounts login ${resolved.kind}\` requires --name <label>`
            );
          }
          const existing = (await client.call("accounts.status", {})).accounts.find(
            (entry) =>
              entry.subscriptionKind === resolved.kind &&
              entry.label === options.name
          );
          if (existing !== undefined) {
            enrolledAccounts = [{ label: options.name }];
          } else {
            const result = await captureLoginCredential(resolved.kind, options.name, {
              ...(noBrowser ? { noBrowser } : {})
            });
            enrolledAccounts = [
              { label: result.label, credential: result.credential }
            ];
          }
        } else {
          if (options.name !== undefined) {
            ctx.presenter.note(
              "--name is ignored for this kind; the account identity comes from the OAuth login"
            );
          }
          const result = await captureCliproxyLoginCredentials(resolved.kind, {
            ...(noBrowser ? { noBrowser } : {}),
            onProgress: (line) => ctx.presenter.note(line)
          });
          enrolledAccounts = result.accounts.map((entry) => ({
            label: entry.label,
            credential: entry.credential
          }));
        }
        const provider = providerForKind(resolved.kind, resolved.connector);
        const activated = await client.call(
          "accounts.enrollActivate",
          { kind: resolved.kind, accounts: enrolledAccounts },
          { idempotencyKey: activationKey(resolved.kind, enrolledAccounts) }
        );
        for (const { label } of enrolledAccounts) {
          ctx.presenter.success(
            `logged in, enrolled, and enabled ${resolved.kind}/${label}`
          );
        }
        ctx.presenter.note(`config: ${activated.configPath}`);
        const models = await client.call("models.list", { provider });
        if (models.models.length === 0) {
          ctx.presenter.warn(
            `no live ${provider} models discovered yet; check \`routekit accounts status\``
          );
        } else {
          ctx.presenter.note(`${models.models.length} live ${provider} model(s) available`);
        }
      }
    );

  accounts
    .command("add <subscription-kind>")
    .description("enroll the current official CLI login (claude-code, codex)")
    .option("--name <name>", "account label")
    .action(async (subscriptionKind: string, options: { name?: string }, command: Command) => {
      const ctx = contextFor(command);
      const kind = parseAccountMode(subscriptionKind);
      const label = options.name ?? `${kind}-default`;
      const client = await routekitClient();
      const existing = (await client.call("accounts.status", {})).accounts.find(
        (entry) => entry.subscriptionKind === kind && entry.label === label
      );
      const accounts =
        existing !== undefined
          ? [{ label }]
          : [
              {
                label,
                credential: JSON.parse(
                  readFileSync(defaultSubscriptionCredentialPath(kind), "utf8")
                ) as unknown
              }
            ];
      const enrolled = await client.call(
        "accounts.enrollActivate",
        { kind, accounts },
        { idempotencyKey: activationKey(kind, accounts) }
      );
      const output = {
        subscriptionKind: kind,
        label,
        revision: enrolled.accountRevision,
        activated: true,
        configPath: enrolled.configPath
      };
      if (ctx.json) {
        ctx.emit(output);
      } else {
        ctx.presenter.success(
          `enrolled and enabled ${kind}/${label}`
        );
        ctx.presenter.note(`config: ${enrolled.configPath}`);
      }
    });

  accounts
    .command("remove <subscription-kind> <name>")
    .description("remove an enrolled account from RouteKit-managed state")
    .action(async (provider: string, name: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const client = await routekitClient();
      const registryKind = resolveAccountConnector(provider);
      const kind = registryKind?.kind ?? provider;
      let connector = registryKind?.info.connector;
      if (connector === undefined) {
        const listed = await client.call("accounts.list", {});
        const rawEntry = (
          listed.accounts as Array<{
            subscriptionKind?: string;
            label?: string;
            connector?: string;
          }>
        ).find(
          (entry) =>
            entry.subscriptionKind === provider &&
            entry.label === name &&
            entry.connector === "cliproxy"
        );
        if (rawEntry === undefined) {
          throw new Error(`unknown subscription kind ${JSON.stringify(provider)}`);
        }
        connector = "cliproxy";
      }
      const result = await client.call(
        "accounts.remove",
        { kind, label: name },
        { idempotencyKey: `account-remove-${randomId(16)}` }
      );
      if (ctx.json) {
        ctx.emit({ ...result, subscriptionKind: kind, label: name });
      } else if (result.removed) {
        ctx.presenter.success(`removed ${kind}/${name}`);
        const remaining = await client.call("accounts.list", {});
        const accounts = remaining.accounts as Array<{
          subscriptionKind?: string;
          connector?: string;
        }>;
        const routerProvider = providerForKind(kind, connector);
        const shouldSuggestProviderRemove =
          connector === "cliproxy"
            ? !accounts.some((entry) => isCliproxyAccount(entry))
            : accounts.every((entry) => entry.subscriptionKind !== kind);
        if (shouldSuggestProviderRemove) {
          ctx.presenter.note(
            `run \`routekit providers remove ${routerProvider}\` to stop subscription routing`
          );
        }
      } else {
        ctx.presenter.note(`${kind}/${name} is not enrolled`);
      }
    });

  accounts
    .command("list")
    .description("list enrolled accounts without reading credential values")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const response = await (await routekitClient()).call("accounts.list", {});
      const entries = response.accounts as Array<{
        subscriptionKind: string;
        label: string;
      }>;
      if (ctx.json) ctx.emit({ accounts: entries });
      else {
        ctx.presenter.table(
          entries.map((entry) => [entry.subscriptionKind, entry.label])
        );
      }
    });

  accounts
    .command("status")
    .description("show pooled account and connector status")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const status = (await (await routekitClient()).call("accounts.status", {})) as {
        accounts: Array<{
          subscriptionKind: string;
          label: string;
          connector?: "native" | "cliproxy";
          localOnly?: boolean;
          credentialValid?: boolean;
          configured?: boolean;
          relayOpen?: boolean;
        }>;
        revision: number;
        recovery: {
          state: "clean" | "recovered";
          recovered: number;
          cleaned: number;
        };
      };
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.status("ok", "daemon account pool", `revision ${status.revision}`);
      if (status.recovery.recovered > 0) {
        ctx.presenter.note(
          `restored ${status.recovery.recovered} interrupted account activation(s)`
        );
      }
      for (const entry of status.accounts) {
        const ok =
          entry.credentialValid === true &&
          entry.configured === true &&
          entry.relayOpen === true;
        ctx.presenter.status(
          ok ? "ok" : "pending",
          `${entry.subscriptionKind}/${entry.label}`,
          (!entry.credentialValid
            ? "stored; credential invalid"
            : !entry.configured
              ? "stored; routing disabled"
              : !entry.relayOpen
                ? "stored; configured; relay unavailable or cooling"
                : "stored; configured; relay ready") +
            (entry.localOnly === true ? " · local-only" : "")
        );
      }
    });
}
