import { join, resolve } from "node:path";

import { Command } from "commander";

import { bold, cyan, dim, glyph, gray, green, red, uiStream } from "@fusionkit/cli-ui";

import {
  codexConfigSnippet,
  gatewaySetupSnippets,
  installRegistryAdapters,
  runGatewayAcceptance,
  runGatewayAcp,
  startConfiguredGateway
} from "../gateway.js";
import type { GatewayRunnerConfig } from "../gateway.js";
import { fail } from "../shared/errors.js";
import {
  collect,
  ensembleModels,
  parsePort,
  parseTimeoutMs,
  unifiedHarnessKinds
} from "../shared/options.js";
import { toolRegistry } from "../tools.js";

type GatewayOpts = {
  fusionBackend?: string;
  harness?: string[];
  command?: string;
  repo?: string;
  out?: string;
  model?: string[];
  judgeModel?: string;
  timeoutMs?: string;
  fusionApiKey?: string;
  host?: string;
  port?: string;
  authToken?: string;
  sentinel?: string;
};

function addCommonGatewayOptions(cmd: Command): Command {
  return cmd
    .option("--fusion-backend <url>", "FusionKit/OpenAI-compatible backend URL")
    .option("--harness <target>", "mock | command | codex | claude-code | cursor-acp (repeatable)", collect)
    .option("--command <cmd>", "command harness script")
    .option("--repo <dir>", "workspace repository", ".")
    .option("--out <dir>", "output directory")
    .option("--model <spec>", "panel model mapping ID=MODEL (repeatable)", collect)
    .option("--judge-model <model>", "model used for judge synthesis")
    .option("--timeout-ms <n>", "candidate timeout")
    .option("--fusion-api-key <key>", "API key for the fusion backend");
}

function gatewayConfig(opts: GatewayOpts): GatewayRunnerConfig {
  const fusionBackendUrl = opts.fusionBackend;
  if (!fusionBackendUrl) fail("--fusion-backend is required");
  const timeoutMs = parseTimeoutMs(opts.timeoutMs, 120000);
  return {
    fusionBackendUrl,
    repo: resolve(opts.repo ?? "."),
    outputRoot: resolve(opts.out ?? ".warrant/gateway"),
    harnesses: unifiedHarnessKinds(opts.harness),
    models: ensembleModels(opts.model),
    timeoutMs,
    ...(opts.command !== undefined ? { command: opts.command } : {}),
    ...(opts.judgeModel !== undefined ? { judgeModel: opts.judgeModel } : {}),
    ...(opts.fusionApiKey !== undefined ? { fusionApiKey: opts.fusionApiKey } : {})
  };
}

export function buildGatewayCommand(): Command {
  const gateway = new Command("gateway").description(
    "advanced/maintainer: harness gateway development tools"
  );

  const serve = addCommonGatewayOptions(new Command("serve"))
    .description("serve the fusion harness gateway over the provider wire protocols")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <n>", "bind port", "8787")
    .option("--auth-token <token>", "require a bearer token on the gateway")
    .action(async (opts: GatewayOpts) => {
      const config = gatewayConfig(opts);
      const host = opts.host ?? "127.0.0.1";
      const port = parsePort(opts.port, 8787);
      const instance = await startConfiguredGateway({
        config,
        host,
        port,
        ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {})
      });
      uiStream().write(
        `${green(glyph.tick())} ${bold("fusion harness gateway")} ${cyan(instance.url())}\n\n`
      );
      uiStream().write(gatewaySetupSnippets(instance.url(), "http://127.0.0.1:<cursorkit-port>") + "\n");
    });
  gateway.addCommand(serve, { isDefault: true });

  gateway.addCommand(
    addCommonGatewayOptions(new Command("acp"))
      .description("ACP local agent over JSON-RPC stdio")
      .action(async (opts: GatewayOpts) => {
        await runGatewayAcp(gatewayConfig(opts));
      })
  );

  const acpRegistry = new Command("acp-registry").description("registry-backed ACP adapters");
  acpRegistry
    .command("install [ids...]")
    .description("install registry-backed ACP adapters")
    .option("--install-dir <dir>", "adapter metadata dir", ".warrant/acp-registry")
    .action(async (ids: string[], opts: { installDir: string }) => {
      const defaultAgentIds = toolRegistry
        .list()
        .map((tool) => tool.acpAdapterId)
        .filter((id): id is string => id !== undefined);
      const agentIds = ids.length > 0 ? ids : defaultAgentIds;
      const installed = await installRegistryAdapters({
        agentIds,
        installDir: resolve(opts.installDir)
      });
      uiStream().write(`${green(glyph.tick())} installed ${installed.length} ACP registry adapter(s)\n`);
      for (const line of installed) uiStream().write(`  ${gray(glyph.bullet())} ${line}\n`);
    });
  gateway.addCommand(acpRegistry);

  gateway.addCommand(
    addCommonGatewayOptions(new Command("test"))
      .description("unified front-door acceptance suite")
      .option("--host <host>", "bind host", "127.0.0.1")
      .option("--sentinel <text>", "expected substring", "FUSION_OK")
      .action(async (opts: GatewayOpts) => {
        const config = gatewayConfig(opts);
        const sentinel = opts.sentinel ?? "FUSION_OK";
        const outPath = resolve(opts.out ?? ".warrant/front-door-e2e/front-door-report.json");
        // The report path and the per-run gateway output root must not collide.
        const acceptanceConfig: GatewayRunnerConfig = {
          ...config,
          outputRoot: join(resolve(outPath, ".."), "gateway-runs")
        };
        const { reportPath, failed } = await runGatewayAcceptance({
          config: acceptanceConfig,
          sentinel,
          host: opts.host ?? "127.0.0.1",
          outPath
        });
        uiStream().write(
          failed
            ? `${red(glyph.cross())} front-door acceptance failed ${dim(`— report: ${reportPath}`)}\n`
            : `${green(glyph.tick())} front-door acceptance passed ${dim(`— report: ${reportPath}`)}\n`
        );
        if (failed) process.exitCode = 1;
      })
  );

  gateway
    .command("codex-config")
    .description("print Codex provider config snippet")
    .option("--fusion-backend <url>", "FusionKit/OpenAI-compatible backend URL")
    .option("--host <host>", "bind host", "127.0.0.1")
    .option("--port <n>", "bind port", "8787")
    .action((opts: { fusionBackend?: string; host: string; port: string }) => {
      const base = opts.fusionBackend ?? `http://${opts.host}:${opts.port}`;
      // The snippet is a machine payload (meant to be piped into config.toml).
      process.stdout.write(codexConfigSnippet(base) + "\n");
    });

  return gateway;
}
