/**
 * `fusionkit install codex` / `fusionkit uninstall codex` — additive
 * registration of FusionKit into the user's real Codex configuration.
 *
 * Unlike `fusionkit codex` (which launches Codex behind the fusion panel in an
 * ephemeral CODEX_HOME), this writes a managed block into `~/.codex/config.toml`
 * that adds the FusionKit gateway as an EXTRA model provider plus one launch
 * profile per fusion ensemble — the user's default model/provider, MCP
 * servers, and instructions stay untouched, and plain `codex` behaves exactly
 * as before. `codex --profile fusion-panel` then starts a fused session
 * against a running `fusionkit serve`; inside it the gateway's Codex backend
 * relay keeps the full model picker (fusion + panel + the user's own stock
 * models, live).
 */
import type { Command } from "commander";

import { bold, cyan, dim, done, note, uiStream } from "@fusionkit/cli-ui";
import { DEFAULT_ENSEMBLE_NAME, fusionModelId, trimTrailingSlashes } from "@fusionkit/tools";
import { installCodexIntegration, uninstallCodexIntegration } from "@fusionkit/tool-codex";
import type { CodexInstallProfile } from "@fusionkit/tool-codex";

import { loadFusionConfig } from "../fusion-config.js";
import { gitToplevel } from "../fusion/env.js";
import { fail } from "../shared/errors.js";
import { parsePort } from "../shared/options.js";

import { registerPaletteAction } from "./palette.js";

type InstallOpts = {
  gatewayUrl?: string;
  port?: string;
  repo?: string;
  codexHome?: string;
};

/** Resolve the gateway URL the installed provider points at. */
function resolveGatewayUrl(opts: InstallOpts): string {
  if (opts.gatewayUrl !== undefined && opts.gatewayUrl.length > 0) return trimTrailingSlashes(opts.gatewayUrl);
  if (opts.port !== undefined) return `http://127.0.0.1:${parsePort(opts.port, 0)}`;
  throw fail(
    "a gateway address is required: pass --port <n> (pair it with `fusionkit serve --port <n>`) or --gateway-url <url>"
  );
}

/** One profile per configured fusion ensemble (session default first). */
function resolveProfiles(opts: InstallOpts): CodexInstallProfile[] {
  const repo = opts.repo ?? gitToplevel(process.cwd()) ?? process.cwd();
  const config = loadFusionConfig(repo);
  const names = Object.keys(config?.ensembles ?? {});
  const ensembleNames = names.length > 0 ? names : [DEFAULT_ENSEMBLE_NAME];
  return ensembleNames.map((name) => ({ ensembleName: name, modelId: fusionModelId(name) }));
}

function runInstallCodex(opts: InstallOpts): number {
  const gatewayUrl = resolveGatewayUrl(opts);
  const profiles = resolveProfiles(opts);
  const result = installCodexIntegration({
    gatewayUrl,
    profiles,
    ...(opts.codexHome !== undefined ? { codexHome: opts.codexHome } : {})
  });
  const write = (line: string): void => void uiStream().write(`${line}\n`);
  done(
    `${result.action === "installed" ? "installed" : "updated"} the FusionKit block in ${result.configPath}`
  );
  write(dim("your default Codex model/provider and everything else in that file are untouched."));
  write("");
  write(bold("use it:"));
  const port = /:(\d+)/.exec(gatewayUrl)?.[1];
  write(`  1. start the gateway:  ${cyan(`fusionkit serve${port !== undefined ? ` --port ${port}` : ""}`)}`);
  write(`  2. launch fused Codex: ${cyan(`codex --profile ${result.profiles[0] ?? "fusion-panel"}`)}`);
  if (result.profiles.length > 1) {
    write(dim(`     other ensembles: ${result.profiles.slice(1).join(", ")}`));
  }
  write(
    dim(
      "     in that session, /model lists the fused ensembles, the panel members, and your own Codex models (relayed live)."
    )
  );
  write(dim(`  remove any time: fusionkit uninstall codex`));
  return 0;
}

function runUninstallCodex(opts: Pick<InstallOpts, "codexHome">): number {
  const result = uninstallCodexIntegration(
    opts.codexHome !== undefined ? { codexHome: opts.codexHome } : {}
  );
  if (result.removed) done(`removed the FusionKit block from ${result.configPath}`);
  else note(`no FusionKit block found in ${result.configPath}; nothing to remove`);
  return 0;
}

const INSTALL_TOOLS = ["codex"] as const;

function assertKnownTool(tool: string): void {
  if (!(INSTALL_TOOLS as readonly string[]).includes(tool)) {
    throw fail(`unknown install target: ${tool} (supported: ${INSTALL_TOOLS.join(", ")})`);
  }
}

export function registerInstall(program: Command): void {
  registerPaletteAction({
    label: "Install FusionKit into Codex (provider + profiles)",
    hint: "fusionkit install codex --port <n>",
    argv: ["install", "codex"]
  });
  program
    .command("install <tool>")
    .description("register FusionKit inside a tool's own config (codex: extra provider + one profile per ensemble)")
    .option("--gateway-url <url>", "running fusionkit gateway base URL (e.g. http://127.0.0.1:4114)")
    .option("--port <n>", "shorthand for --gateway-url http://127.0.0.1:<n> (pair with `fusionkit serve --port <n>`)")
    .option("--repo <dir>", "repo whose .fusionkit/fusion.json defines the ensembles (default: current git repo)")
    .option("--codex-home <dir>", "Codex home directory (default: ~/.codex)")
    .action((tool: string, opts: InstallOpts) => {
      assertKnownTool(tool);
      process.exitCode = runInstallCodex(opts);
    });
  program
    .command("uninstall <tool>")
    .description("remove FusionKit's managed block from a tool's own config")
    .option("--codex-home <dir>", "Codex home directory (default: ~/.codex)")
    .action((tool: string, opts: Pick<InstallOpts, "codexHome">) => {
      assertKnownTool(tool);
      process.exitCode = runUninstallCodex(opts);
    });
}
