import { resolve } from "node:path";

import type { Command } from "commander";

import { loadFusionConfig } from "@fusionkit/config";
import type { EnsembleConfig } from "@fusionkit/config";
import { loadRouterConfig } from "@routekit/config";
import { contextFor, probeBinaryVersion } from "@routekit/cli-core";
import { trimTrailingSlashes } from "@routekit/runtime";

import { gitToplevel } from "../fusion/env.js";
import { hasBinary, INSTALL_HINTS } from "../shared/preflight.js";
import { toolRegistry } from "../tools.js";
import { registerPaletteAction } from "./palette.js";

type DoctorEntry = {
  label: string;
  ok: boolean;
  required?: boolean;
  detail?: string;
  hint?: string;
};

function requiredEndpointIds(
  ensembles: Record<string, EnsembleConfig>
): Set<string> {
  return new Set(
    Object.values(ensembles).flatMap((ensemble) => [
      ...ensemble.members,
      ensemble.judge,
      ensemble.synthesizer ?? ensemble.judge
    ])
  );
}

async function runDoctor(command: Command): Promise<number> {
  const context = contextFor(command);
  const checks: DoctorEntry[] = [];
  let selectedTool = "codex";
  const repo = gitToplevel(process.cwd());
  checks.push({
    label: "git repository",
    ok: repo !== undefined,
    ...(repo !== undefined ? { detail: repo } : { hint: "cd into a git repository" })
  });
  checks.push({
    label: "uv / uvx",
    ok: hasBinary("uv") || hasBinary("uvx"),
    ...(!hasBinary("uv") && !hasBinary("uvx")
      ? { hint: INSTALL_HINTS.uvx }
      : {})
  });
  if (repo !== undefined) {
    try {
      const config = loadFusionConfig(repo);
      if (config === undefined) {
        checks.push({
          label: "FusionKit config",
          ok: false,
          hint: "run `fusionkit init`"
        });
      } else if (typeof config.router.config === "string") {
        selectedTool = config.tool ?? selectedTool;
        const path = resolve(repo, config.router.config);
        const routekit = loadRouterConfig({ configPath: path });
        const available = new Set(
          routekit.config.endpoints.map((endpoint) => endpoint.endpointId)
        );
        const required = requiredEndpointIds(config.ensembles);
        const missing = [...required].filter((id) => !available.has(id));
        checks.push({
          label: "embedded RouteKit config",
          ok: missing.length === 0,
          detail: path,
          ...(missing.length > 0
            ? { hint: `configure missing RouteKit endpoint ids: ${missing.join(", ")}` }
            : {})
        });
      } else {
        selectedTool = config.tool ?? selectedTool;
        const authToken =
          config.router.authEnv !== undefined
            ? process.env[config.router.authEnv]
            : undefined;
        const authReady =
          config.router.authEnv === undefined ||
          (authToken !== undefined && authToken.length > 0);
        if (config.router.authEnv !== undefined) {
          checks.push({
            label: config.router.authEnv,
            ok: authReady,
            hint: `export ${config.router.authEnv}=...`
          });
        }
        const root = trimTrailingSlashes(config.router.url.replace(/\/v1\/?$/, ""));
        const response = authReady
          ? await fetch(`${root}/v1/models`, {
              headers:
                authToken !== undefined
                  ? { authorization: `Bearer ${authToken}` }
                  : undefined,
              signal: AbortSignal.timeout(5000)
            })
          : undefined;
        const body =
          response?.ok === true
            ? ((await response.json()) as { data?: Array<{ id?: unknown }> })
            : undefined;
        const available = new Set(
          (body?.data ?? []).flatMap((entry) =>
            typeof entry.id === "string" ? [entry.id] : []
          )
        );
        const missing = [...requiredEndpointIds(config.ensembles)].filter(
          (id) => !available.has(id)
        );
        checks.push({
          label: "external RouteKit gateway",
          ok: response?.ok === true && missing.length === 0,
          detail:
            response === undefined
              ? config.router.url
              : `${config.router.url} (HTTP ${response.status})`,
          ...(response?.ok === true && missing.length > 0
            ? {
                hint: `external RouteKit is missing endpoint ids: ${missing.join(", ")}`
              }
            : response !== undefined && !response.ok
              ? { hint: "start RouteKit and verify router authentication" }
              : {})
        });
      }
    } catch (error) {
      checks.push({
        label: "FusionKit / RouteKit config",
        ok: false,
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }
  for (const tool of toolRegistry.list()) {
    if (tool.binary === undefined) continue;
    const ok = hasBinary(tool.binary);
    const required = tool.id === selectedTool;
    checks.push({
      label: tool.id,
      ok,
      required,
      ...(ok ? { detail: probeBinaryVersion(tool.binary) ?? "installed" } : {}),
      ...(!ok && required && tool.installHint !== undefined ? { hint: tool.installHint } : {}),
      ...(!ok && !required ? { detail: "optional, not installed" } : {})
    });
  }
  const ready = checks.every((check) => check.ok || check.required === false);
  if (context.json) context.emit({ ready, checks });
  else {
    for (const check of checks) {
      context.presenter.status(
        check.ok ? "ok" : check.required === false ? "pending" : "fail",
        check.label,
        check.detail,
        check.hint
      );
    }
  }
  return ready ? 0 : 1;
}

export function registerDoctor(program: Command): void {
  registerPaletteAction({
    label: "Check FusionKit",
    hint: "fusionkit doctor",
    argv: ["doctor"]
  });
  program
    .command("doctor")
    .description("check Fusion config, RouteKit connectivity, and coding tools")
    .option("--json")
    .action(async (_options: unknown, command: Command) => {
      process.exitCode = await runDoctor(command);
    });
}
