import { contextFor } from "@routekit/cli-core";
import {
  PROVIDER_IDS,
  splitNamespacedModel,
  type ProviderId
} from "@routekit/gateway";
import type { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { routekitClient } from "../client.js";
import {
  isLaunchProviderId,
  LAUNCH_PROVIDER_IDS,
  type LaunchProviderId
} from "../launch-support.js";

import { numberOption } from "./context.js";

function normalizedProvider(value: string): string {
  return value === "claude" || value === "claudeCode" ? "claude-code" : value;
}

function parseKnownProvider(value: string): ProviderId {
  const normalized = normalizedProvider(value);
  if (!PROVIDER_IDS.includes(normalized as ProviderId)) {
    throw new Error(
      `unknown provider ${JSON.stringify(value)}; first-launch providers: ` +
        LAUNCH_PROVIDER_IDS.join(", ")
    );
  }
  return normalized as ProviderId;
}

function parseLaunchProvider(value: string): LaunchProviderId {
  const normalized = normalizedProvider(value);
  if (!isLaunchProviderId(normalized)) {
    throw new Error(
      `provider ${JSON.stringify(value)} is not offered at first launch; ` +
        `supported providers: ${LAUNCH_PROVIDER_IDS.join(", ")}`
    );
  }
  return normalized;
}

function rawProviders(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function registerProviders(program: Command): void {
  const providers = program
    .command("providers")
    .description("manage explicit model providers");

  providers
    .command("add <provider>")
    .description("enable a first-launch supported provider")
    .option(
      "--strategy <strategy>",
      "sticky | round_robin | capacity_weighted"
    )
    .option("--switch-threshold <ratio>", "proactive utilization threshold")
    .option("--probe-interval <milliseconds>", "usage probe interval")
    .option("--fallback-cooldown <seconds>", "fallback cooldown")
    .option("--default-model <provider/model>", "set the namespaced default model")
    .action(
      async (
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
        const provider = parseLaunchProvider(value);
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
        const client = await routekitClient();
        const current = await client.call("config.get", {});
        const draft = (parseYaml(current.document) ?? {}) as Record<string, unknown>;
        const configured = rawProviders(draft.providers);
        draft.providers = {
          ...configured,
          [provider]: {
            ...rawProviders(configured[provider]),
            ...policy
          }
        };
        if (options.defaultModel !== undefined) draft.defaultModel = options.defaultModel;
        const updated = await client.call(
          "config.update",
          { expectedRevision: current.revision, document: stringifyYaml(draft) },
          { idempotencyKey: `provider-add-${provider}-${current.revision}` }
        );
        const ctx = contextFor(command);
        if (ctx.json) {
          ctx.emit({
            path: updated.path,
            provider,
            added: true,
            revision: updated.revision
          });
        } else {
          ctx.presenter.success(`enabled ${provider} in ${updated.path}`);
        }
      }
    );

  providers
    .command("remove <provider>")
    .description("disable a provider")
    .action(async (value: string, _options: unknown, command: Command) => {
      const provider = parseKnownProvider(value);
      const client = await routekitClient();
      const current = await client.call("config.get", {});
      const draft = (parseYaml(current.document) ?? {}) as Record<string, unknown>;
      const configured = rawProviders(draft.providers);
      if (configured[provider] === undefined) {
        throw new Error(`provider is not configured: ${provider}`);
      }
      if (Object.keys(configured).length === 1) {
        throw new Error("cannot remove the only configured provider");
      }
      const next = { ...configured };
      delete next[provider];
      draft.providers = next;
      if (
        typeof draft.defaultModel === "string" &&
        draft.defaultModel.startsWith(`${provider}/`)
      ) {
        delete draft.defaultModel;
      }
      const updated = await client.call(
        "config.update",
        { expectedRevision: current.revision, document: stringifyYaml(draft) },
        { idempotencyKey: `provider-remove-${provider}-${current.revision}` }
      );
      const ctx = contextFor(command);
      if (ctx.json) {
        ctx.emit({
          path: updated.path,
          provider,
          removed: true,
          revision: updated.revision
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
        const response = await (await routekitClient()).call("providers.status", {
          live: true
        });
        const statuses =
          value === undefined
            ? response.providers
            : response.providers.filter(
                (entry) => entry.provider === parseKnownProvider(value)
              );
        if (value !== undefined && statuses.length === 0) {
          throw new Error(`provider is not configured: ${value}`);
        }
        const ctx = contextFor(command);
        if (ctx.json) {
          ctx.emit({ providers: statuses });
        } else {
          for (const status of statuses) {
            ctx.presenter.status(
              status.credentialAvailable && status.error === undefined ? "ok" : "fail",
              status.provider,
              status.error ??
                `${status.models?.length ?? 0} live model(s); ` +
                  `${status.credentialAvailable ? "credential available" : "credential missing"}`
            );
          }
        }
        if (
          statuses.some(
            (status) => !status.credentialAvailable || status.error !== undefined
          )
        ) {
          process.exitCode = 1;
        }
      }
    );
}
