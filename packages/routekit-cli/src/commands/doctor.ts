import { contextFor, probeBinaryVersion } from "@routekit/cli-core";
import { commandOnPath } from "@routekit/runtime";
import type { Command } from "commander";

import { routekitClient } from "../client.js";
import { routekitToolRegistry } from "../launch.js";

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
      try {
        const client = await routekitClient();
        const daemon = await client.call("doctor.run", {});
        for (const check of daemon.checks) {
          checks.push({
            label: check.name,
            ok: check.ok,
            ...(check.detail !== undefined ? { detail: check.detail } : {})
          });
        }
        const providers = await client.call("providers.status", { live: true });
        for (const provider of providers.providers) {
          checks.push({
            label: `${provider.provider} provider`,
            ok: provider.credentialAvailable && provider.error === undefined,
            detail:
              provider.error ??
              `${provider.models?.length ?? 0} model(s); ` +
                (provider.credentialAvailable ? "credential available" : "credential missing")
          });
        }
      } catch (error) {
        checks.push({
          label: "RouteKit daemon",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          tryCommand: "routekit daemon status"
        });
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
