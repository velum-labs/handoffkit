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
  if (!existsSync(routerPath)) {
    writeRouterConfig(routerPath, DEFAULT_ROUTER_CONFIG);
    note(
      `created ${routerPath}; edit its placeholder endpoint or use \`routekit endpoints add\``
    );
  }
  const loaded = loadRouterConfig({ configPath: routerPath });
  const endpointIds = [
    ...new Set(loaded.config.endpoints.map((endpoint) => endpoint.endpointId))
  ];
  if (endpointIds.length === 0) {
    process.stderr.write(
      `error: ${routerPath} has no endpoints; configure RouteKit first\n`
    );
    return 1;
  }
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
        members: endpointIds,
        judge: endpointIds[0] as string
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
    "FusionKit stores only opaque endpoint ids; provider credentials stay in .routekit/router.yaml"
  );
  return 0;
}
