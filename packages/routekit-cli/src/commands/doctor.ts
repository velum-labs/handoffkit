import {
  CLIPROXY_API_KEY_ENV,
  cliproxyApiKey
} from "@routekit/accounts";
import { contextFor, probeBinaryVersion } from "@routekit/cli-core";
import { configuredProviderIds } from "@routekit/config";
import type { RouterConfig } from "@routekit/gateway";
import { defaultKeyEnv } from "@routekit/registry";
import { commandOnPath } from "@routekit/runtime";
import type { Command } from "commander";

import { accountsStatus } from "../accounts.js";
import { routekitToolRegistry } from "../launch.js";

import { loaded } from "./context.js";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check config, credentials, and coding-agent binaries")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
      let config: RouterConfig | undefined;
      try {
        const result = loaded(command);
        config = result.config;
        checks.push({ label: "router config", ok: true, detail: result.path });
        for (const name of new Set(
          configuredProviderIds(result.config).flatMap((provider) => {
            const keyEnv = defaultKeyEnv(provider);
            return keyEnv === undefined ? [] : [keyEnv];
          })
        )) {
          const credential =
            process.env[name] ??
            (name === CLIPROXY_API_KEY_ENV ? cliproxyApiKey() : undefined);
          checks.push({
            label: name,
            ok: credential !== undefined && credential.length > 0,
            detail: credential !== undefined ? "set" : "not set"
          });
        }
      } catch (error) {
        checks.push({
          label: "router config",
          ok: false,
          detail: error instanceof Error ? error.message : String(error)
        });
      }
      if (config !== undefined) {
        const status = await accountsStatus(config);
        for (const subscriptionKind of ["claude-code", "codex"] as const) {
          if (config.providers[subscriptionKind] === undefined) continue;
          const entries = status.accounts.filter(
            (entry) => entry.subscriptionKind === subscriptionKind
          );
          const valid = entries.filter((entry) => entry.credentialValid);
          checks.push({
            label: `${subscriptionKind} subscription`,
            ok: valid.length > 0,
            detail:
              valid.length > 0
                ? `${valid.length} valid account(s); routing enabled`
                : "routing enabled but no valid enrolled account"
          });
        }
        for (const account of status.accounts) {
          if (!account.credentialValid || account.configured) continue;
          checks.push({
            label: `${account.subscriptionKind}/${account.label} enrollment`,
            ok: false,
            detail:
              "credential is stored but routing is disabled; retry enrollment or remove the account"
          });
        }
      }
      for (const tool of routekitToolRegistry.list()) {
        if (tool.binary === undefined) continue;
        const ok = commandOnPath(tool.binary);
        checks.push({
          label: tool.binary,
          ok,
          ...(ok ? { detail: probeBinaryVersion(tool.binary) ?? "installed" } : {})
        });
      }
      if (ctx.json) ctx.emit({ ready: checks.every((check) => check.ok), checks });
      else {
        for (const check of checks) {
          ctx.presenter.status(check.ok ? "ok" : "fail", check.label, check.detail);
        }
      }
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    });
}
