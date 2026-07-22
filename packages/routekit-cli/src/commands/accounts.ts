/**
 * One account surface for every subscription kind. `accounts login <kind>`
 * dispatches to the connector the registry declares for that kind — the
 * native official-CLI capture (claude-code, codex) or the RouteKit-managed
 * CLIProxyAPI sidecar (gemini, grok, kimi) — enrolls the credential, enables
 * the matching provider, and verifies live model discovery. Users never
 * manage the connector machinery directly.
 */
import {
  captureLoginCredential,
  defaultSubscriptionCredentialPath,
  loginCliproxyAccount,
  parseAccountMode,
  resolveAccountKind
} from "@routekit/accounts";
import { contextFor } from "@routekit/cli-core";
import { accountKinds } from "@routekit/registry";
import { randomId } from "@routekit/runtime";
import type { Command } from "commander";
import { readFileSync } from "node:fs";

import { routekitClient } from "../client.js";

/** The router provider a subscription kind routes through. */
function providerForKind(kind: string, connector: "native" | "cliproxy"): string {
  return connector === "cliproxy" ? "cliproxy" : kind;
}

async function activateAccount(provider: string): Promise<string> {
  const client = await routekitClient();
  const updated = await client.call(
    "providers.set",
    { provider, enabled: true },
    { idempotencyKey: `account-activate-${provider}-${randomId(16)}` }
  );
  return updated.path;
}

const LOCAL_ONLY_WARNING =
  "this connector reuses subscription OAuth tokens through reverse-engineered " +
  "endpoints; providers restrict that to personal/local use — do not expose it " +
  "through a shared gateway";

export function registerAccounts(program: Command): void {
  const accounts = program.command("accounts").description("manage pooled provider subscriptions");

  accounts
    .command("login <subscription-kind>")
    .description(`enroll a subscription account (${accountKinds().join(", ")})`)
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
        const noBrowser = options.browser === false;
        if (resolved.localOnly) ctx.presenter.warn(`${resolved.kind}: ${LOCAL_ONLY_WARNING}`);
        const client = await routekitClient();
        let enrolledLabels: string[];
        if (resolved.connector === "native") {
          if (options.name === undefined) {
            throw new Error(
              `\`accounts login ${resolved.kind}\` requires --name <label>`
            );
          }
          const result = await captureLoginCredential(resolved.kind, options.name, {
            ...(noBrowser ? { noBrowser } : {})
          });
          await client.call(
            "accounts.enroll",
            {
              kind: result.subscriptionKind,
              label: result.label,
              credential: result.credential
            },
            { idempotencyKey: `account-login-${randomId(16)}` }
          );
          enrolledLabels = [result.label];
        } else {
          if (options.name !== undefined) {
            ctx.presenter.note(
              "--name is ignored for this kind; the account identity comes from the OAuth login"
            );
          }
          const result = await loginCliproxyAccount(resolved.kind, {
            ...(noBrowser ? { noBrowser } : {}),
            onProgress: (line) => ctx.presenter.note(line)
          });
          await client.call(
            "accounts.sync",
            {},
            { idempotencyKey: `account-sync-${randomId(16)}` }
          );
          enrolledLabels = result.added.map((entry) => entry.label);
        }
        const provider = providerForKind(resolved.kind, resolved.connector);
        const configPath = await activateAccount(provider);
        for (const label of enrolledLabels) {
          ctx.presenter.success(
            `logged in, enrolled, and enabled ${resolved.kind}/${label}`
          );
        }
        ctx.presenter.note(`config: ${configPath}`);
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
      const sourcePath = defaultSubscriptionCredentialPath(kind);
      const credential = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
      const client = await routekitClient();
      const enrolled = await client.call(
        "accounts.enroll",
        { kind, label, credential },
        { idempotencyKey: `account-add-${randomId(16)}` }
      );
      const configPath = await activateAccount(kind);
      const output = {
        subscriptionKind: kind,
        label,
        revision: enrolled.revision,
        activated: true,
        configPath
      };
      if (ctx.json) {
        ctx.emit(output);
      } else {
        ctx.presenter.success(
          `enrolled and enabled ${kind}/${label}`
        );
        ctx.presenter.note(`config: ${configPath}`);
      }
    });

  accounts
    .command("remove <subscription-kind> <name>")
    .description("remove an enrolled account from RouteKit-managed state")
    .action(async (provider: string, name: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const resolved = resolveAccountKind(provider);
      const result = await (await routekitClient()).call(
        "accounts.remove",
        { kind: resolved.kind, label: name },
        { idempotencyKey: `account-remove-${randomId(16)}` }
      );
      if (ctx.json) {
        ctx.emit({ ...result, subscriptionKind: resolved.kind, label: name });
      } else if (result.removed) {
        ctx.presenter.success(`removed ${resolved.kind}/${name}`);
        const remaining = await (await routekitClient()).call("accounts.list", {});
        if (
          (remaining.accounts as Array<{ subscriptionKind?: string }>).every(
            (entry) => entry.subscriptionKind !== resolved.kind
          )
        ) {
          const routerProvider = providerForKind(resolved.kind, resolved.connector);
          ctx.presenter.note(
            `run \`routekit providers remove ${routerProvider}\` to stop subscription routing`
          );
        }
      } else {
        ctx.presenter.note(`${resolved.kind}/${name} is not enrolled`);
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
      };
      if (ctx.json) {
        ctx.emit(status);
        return;
      }
      ctx.presenter.status("ok", "daemon account pool", `revision ${status.revision}`);
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
