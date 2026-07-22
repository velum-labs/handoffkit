import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FusionConfig, FusionTool } from "@fusionkit/config";
import {
  DEFAULT_ENSEMBLE_NAME,
  FUSION_CONFIG_VERSION,
  FusionConfigError,
  fusionConfigPath,
  writeFusionConfig
} from "@fusionkit/config";
import {
  DEFAULT_ROUTER_CONFIG,
  loadRouterConfig,
  writeRouterConfig
} from "@routekit/config";
import { canPromptInteractively, confirm, done, note, select } from "@routekit/cli-ui";
import { startRouter } from "@routekit/router";

import { toolSelectOptions } from "./fusion-quickstart.js";

export type InitOverwriteResolution =
  | { action: "proceed"; force: boolean }
  | { action: "keep" }
  | { action: "refuse" };

export async function resolveInitOverwrite(options: {
  configPath: string;
  force: boolean;
}): Promise<InitOverwriteResolution> {
  if (!existsSync(options.configPath) || options.force) {
    return { action: "proceed", force: options.force };
  }
  if (!canPromptInteractively()) return { action: "refuse" };
  const replace = await confirm({
    message: `${options.configPath} already exists. Replace it?`,
    defaultValue: false
  });
  return replace ? { action: "proceed", force: true } : { action: "keep" };
}

export async function runFusionInit(input: {
  repoRoot?: string;
  force?: boolean;
}): Promise<number> {
  if (input.repoRoot === undefined) {
    process.stderr.write(
      "error: not inside a git repository; cd into a repo or pass --repo <dir>\n"
    );
    return 1;
  }
  const configPath = fusionConfigPath(input.repoRoot);
  const overwrite = await resolveInitOverwrite({
    configPath,
    force: input.force === true
  });
  if (overwrite.action === "keep") return 0;
  if (overwrite.action === "refuse") {
    process.stderr.write(
      `error: ${configPath} already exists (pass --force to replace it)\n`
    );
    return 1;
  }

  const routerPath = join(input.repoRoot, ".routekit", "router.yaml");
  const createdRouter = !existsSync(routerPath);
  if (createdRouter) {
    writeRouterConfig(routerPath, DEFAULT_ROUTER_CONFIG);
    note(
      `created ${routerPath}; verify the provider and live model before launching`
    );
  }
  const loaded = loadRouterConfig({ configPath: routerPath });
  let routekitModelIds: string[];
  if (createdRouter && loaded.config.defaultModel !== undefined) {
    routekitModelIds = [loaded.config.defaultModel];
  } else {
    const router = await startRouter({
      config: loaded.config,
      host: "127.0.0.1",
      port: 0
    });
    try {
      const response = await fetch(`${router.url}/v1/models`, {
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        throw new Error(`RouteKit model discovery returned HTTP ${response.status}`);
      }
      const catalog = (await response.json()) as { data?: Array<{ id?: unknown }> };
      routekitModelIds = (catalog.data ?? []).flatMap((entry) =>
        typeof entry.id === "string" ? [entry.id] : []
      );
    } finally {
      await router.close();
    }
  }
  if (routekitModelIds.length === 0) {
    process.stderr.write(`error: ${routerPath} providers discovered no models\n`);
    return 1;
  }
  const defaultModel = loaded.config.defaultModel ?? routekitModelIds[0]!;
  const tool = canPromptInteractively()
    ? await select<FusionTool>({
        message: "Default coding agent",
        options: toolSelectOptions().filter((option) => option.value !== "serve"),
        defaultIndex: 0
      })
    : "codex";
  const config: FusionConfig = {
    version: FUSION_CONFIG_VERSION,
    router: { config: ".routekit/router.yaml" },
    tool,
    ensembles: {
      [DEFAULT_ENSEMBLE_NAME]: {
        members: [defaultModel],
        judge: defaultModel
      }
    }
  };
  try {
    writeFusionConfig(input.repoRoot, config, { force: overwrite.force });
  } catch (error) {
    if (error instanceof FusionConfigError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  done(`wrote ${configPath}`);
  note(
    "FusionKit stores only namespaced RouteKit model ids; provider credentials stay in RouteKit"
  );
  return 0;
}
