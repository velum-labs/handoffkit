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

function installCommand(binary: string): string {
  switch (binary) {
    case "codex":
      return "npm install -g @openai/codex";
    case "claude":
      return "npm install -g @anthropic-ai/claude-code";
    case "cursor-agent":
      return "curl https://cursor.com/install -fsS | bash";
    case "opencode":
      return "npm install -g opencode-ai";
    default:
      return `command -v ${binary}`;
  }
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check config, credentials, and coding-agent binaries")
    .action(async (_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const checks: Array<{
        label: string;
        ok: boolean;
        detail?: string;
        tryCommand?: string;
      }> = [];
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
          detail: error instanceof Error ? error.message : String(error),
          tryCommand: "routekit config init"
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
                : "routing enabled but no valid enrolled account",
            ...(
              valid.length === 0
                ? { tryCommand: `routekit accounts login ${subscriptionKind} --name default` }
                : {}
            )
          });
        }
      }
      for (const tool of routekitToolRegistry.list()) {
        if (tool.binary === undefined) continue;
        const ok = commandOnPath(tool.binary);
        checks.push({
          label: tool.binary,
          ok,
          ...(ok
            ? { detail: probeBinaryVersion(tool.binary) ?? "installed" }
            : { tryCommand: installCommand(tool.binary) })
        });
      }
      for (const check of checks) {
        if (!check.ok && check.tryCommand === undefined) {
          check.tryCommand = check.label === "router config"
            ? "routekit config init"
            : check.label.endsWith("_API_KEY")
              ? `export ${check.label}='your-key'`
              : "routekit doctor";
        }
      }
      const summary = {
        ok: checks.filter((check) => check.ok).length,
        warn: 0,
        fail: checks.filter((check) => !check.ok).length
      };
      if (ctx.json) ctx.emit({ ready: summary.fail === 0, summary, checks });
      else {
        for (const check of checks) {
          ctx.presenter.status(check.ok ? "ok" : "fail", check.label, check.detail);
          if (!check.ok) {
            ctx.presenter.errorPanel({
              title: check.label,
              message: check.detail ?? `${check.label} failed`,
              tryCommand: check.tryCommand
            });
          }
        }
        ctx.presenter.box("doctor summary", [
          `${summary.ok} ok · ${summary.warn} warn · ${summary.fail} fail`
        ]);
      }
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    });
}
