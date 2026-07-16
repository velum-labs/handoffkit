import { contextFor, probeBinaryVersion } from "@routekit/cli-core";
import { commandOnPath } from "@routekit/runtime";
import type { Command } from "commander";

import { routekitToolRegistry } from "../launch.js";

import { loaded } from "./context.js";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check config, credentials, and coding-agent binaries")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const checks: Array<{ label: string; ok: boolean; detail?: string }> = [];
      try {
        const result = loaded(command);
        checks.push({ label: "router config", ok: true, detail: result.path });
        for (const name of new Set(
          result.config.endpoints
            .map((entry) => entry.apiKeyEnv)
            .filter((entry): entry is string => entry !== undefined)
        )) {
          checks.push({
            label: name,
            ok: process.env[name] !== undefined && process.env[name]!.length > 0,
            detail: process.env[name] !== undefined ? "set" : "not set"
          });
        }
      } catch (error) {
        checks.push({
          label: "router config",
          ok: false,
          detail: error instanceof Error ? error.message : String(error)
        });
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
