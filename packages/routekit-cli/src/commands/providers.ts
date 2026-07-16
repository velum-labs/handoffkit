import { contextFor } from "@routekit/cli-core";
import {
  isSubscriptionProvider,
  PROVIDER_IDS,
  splitNamespacedModel,
  type ProviderId,
  type RouterConfig
} from "@routekit/gateway";
import { defaultKeyEnv } from "@routekit/registry";
import type { Command } from "commander";

import { discoverCatalog } from "../catalog.js";
import { updateEffectiveRouterConfig } from "../config.js";
import { writeStateSnapshot } from "../state.js";

import { configOverride, loaded, numberOption } from "./context.js";

function parseProvider(value: string): ProviderId {
  const normalized =
    value === "claude" || value === "claudeCode" ? "claude-code" : value;
  if (!PROVIDER_IDS.includes(normalized as ProviderId)) {
    throw new Error(`provider must be one of: ${PROVIDER_IDS.join(", ")}`);
  }
  return normalized as ProviderId;
}

function rawProviders(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type ProviderStatus = {
  provider: ProviderId;
  configured: true;
  ok: boolean;
  credential: string;
  models: readonly string[];
  error?: string;
};

async function providerStatus(
  provider: ProviderId,
  config: RouterConfig
): Promise<ProviderStatus> {
  const providerConfig = {
    providers: { [provider]: config.providers[provider] }
  };
  try {
    const catalog = await discoverCatalog(providerConfig as RouterConfig);
    return {
      provider,
      configured: true,
      ok: true,
      credential: isSubscriptionProvider(provider)
        ? "managed accounts"
        : (defaultKeyEnv(provider) ?? "registry managed"),
      models: catalog.models.map((model) => model.id)
    };
  } catch (error) {
    return {
      provider,
      configured: true,
      ok: false,
      credential: isSubscriptionProvider(provider)
        ? "managed accounts"
        : (defaultKeyEnv(provider) ?? "registry managed"),
      models: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function registerProviders(program: Command): void {
  const providers = program
    .command("providers")
    .description("manage explicit model providers");

  providers
    .command("add <provider>")
    .description("enable a provider from the RouteKit registry")
    .option(
      "--strategy <strategy>",
      "sticky | round_robin | capacity_weighted"
    )
    .option("--switch-threshold <ratio>", "proactive utilization threshold")
    .option("--probe-interval <milliseconds>", "usage probe interval")
    .option("--fallback-cooldown <seconds>", "fallback cooldown")
    .option("--default-model <provider/model>", "set the namespaced default model")
    .action(
      (
        value: string,
        options: {
          strategy?: string;
          switchThreshold?: string;
          probeInterval?: string;
          fallbackCooldown?: string;
          defaultModel?: string;
        },
        command: Command
      ) => {
        const provider = parseProvider(value);
        if (
          options.strategy !== undefined &&
          !["sticky", "round_robin", "capacity_weighted"].includes(
            options.strategy
          )
        ) {
          throw new Error(
            "strategy must be sticky, round_robin, or capacity_weighted"
          );
        }
        if (options.defaultModel !== undefined) {
          const selected = splitNamespacedModel(options.defaultModel);
          if (selected.provider !== provider) {
            throw new Error(
              `default model "${options.defaultModel}" does not belong to provider "${provider}"`
            );
          }
        }
        const policy = {
          ...(options.strategy !== undefined
            ? { strategy: options.strategy }
            : {}),
          ...(options.switchThreshold !== undefined
            ? {
                switchThreshold: numberOption(
                  options.switchThreshold,
                  "switch threshold",
                  { min: 0.01, max: 1 }
                )
              }
            : {}),
          ...(options.probeInterval !== undefined
            ? {
                probeIntervalMs: numberOption(
                  options.probeInterval,
                  "probe interval",
                  { min: 0, max: 86_400_000 }
                )
              }
            : {}),
          ...(options.fallbackCooldown !== undefined
            ? {
                fallbackCooldownSeconds: numberOption(
                  options.fallbackCooldown,
                  "fallback cooldown",
                  { min: 0, max: 86_400 }
                )
              }
            : {})
        };
        const updated = updateEffectiveRouterConfig(
          { configPath: configOverride(command) },
          (draft) => {
            const current = rawProviders(draft.providers);
            draft.providers = {
              ...current,
              [provider]: {
                ...rawProviders(current[provider]),
                ...policy
              }
            };
            if (options.defaultModel !== undefined) {
              draft.defaultModel = options.defaultModel;
            }
          }
        );
        const ctx = contextFor(command);
        if (ctx.json) {
          ctx.emit({
            path: updated.path,
            provider,
            added: true,
            config: updated.config
          });
        } else {
          ctx.presenter.success(`enabled ${provider} in ${updated.path}`);
        }
      }
    );

  providers
    .command("remove <provider>")
    .description("disable a provider")
    .action((value: string, _options: unknown, command: Command) => {
      const provider = parseProvider(value);
      const current = loaded(command).config;
      if (current.providers[provider] === undefined) {
        throw new Error(`provider is not configured: ${provider}`);
      }
      if (Object.keys(current.providers).length === 1) {
        throw new Error("cannot remove the only configured provider");
      }
      const updated = updateEffectiveRouterConfig(
        { configPath: configOverride(command) },
        (draft) => {
          const next = { ...rawProviders(draft.providers) };
          delete next[provider];
          draft.providers = next;
          if (
            typeof draft.defaultModel === "string" &&
            draft.defaultModel.startsWith(`${provider}/`)
          ) {
            delete draft.defaultModel;
          }
        }
      );
      const ctx = contextFor(command);
      if (ctx.json) {
        ctx.emit({
          path: updated.path,
          provider,
          removed: true,
          config: updated.config
        });
      } else {
        ctx.presenter.success(`disabled ${provider} in ${updated.path}`);
      }
    });

  providers
    .command("status [provider]")
    .description("run live discovery for configured providers")
    .action(
      async (
        value: string | undefined,
        _options: unknown,
        command: Command
      ) => {
        const config = loaded(command).config;
        const selected =
          value === undefined
            ? PROVIDER_IDS.filter(
                (provider) => config.providers[provider] !== undefined
              )
            : [parseProvider(value)];
        if (
          selected.length === 1 &&
          config.providers[selected[0]!] === undefined
        ) {
          throw new Error(`provider is not configured: ${selected[0]}`);
        }
        const statuses = await Promise.all(
          selected.map(async (provider) => await providerStatus(provider, config))
        );
        writeStateSnapshot("health", "providers", {
          checkedAt: new Date().toISOString(),
          providers: statuses
        });
        const ctx = contextFor(command);
        if (ctx.json) {
          ctx.emit({ providers: statuses });
        } else {
          for (const status of statuses) {
            ctx.presenter.status(
              status.ok ? "ok" : "fail",
              status.provider,
              status.ok
                ? `${status.models.length} live model(s); ${status.credential}`
                : status.error
            );
          }
        }
        if (statuses.some((status) => !status.ok)) process.exitCode = 1;
      }
    );
}
