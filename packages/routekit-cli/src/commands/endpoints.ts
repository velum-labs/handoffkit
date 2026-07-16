import { CLIPROXY_API_KEY_ENV, cliproxyApiKey } from "@routekit/accounts";
import { contextFor } from "@routekit/cli-core";
import { probeEndpointHealth } from "@routekit/gateway";
import type { Command } from "commander";

import { parseAccountMode } from "../accounts.js";
import { updateEffectiveRouterConfig } from "../config.js";
import { writeStateSnapshot } from "../state.js";

import { configOverride, loaded } from "./context.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function registerEndpoints(program: Command): void {
  const endpoints = program.command("endpoints").description("manage configured endpoints");

  endpoints
    .command("list")
    .description("list opaque endpoint ids")
    .action((_options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const entries = loaded(command).config.endpoints;
      if (ctx.json) {
        ctx.emit({ endpoints: entries });
        return;
      }
      ctx.presenter.table(
        entries.map((entry) => [
          entry.endpointId,
          entry.account ?? entry.provider ?? "custom",
          entry.account !== undefined ? "account" : entry.dialect,
          entry.account !== undefined ? "managed subscription" : entry.baseUrl,
          entry.account !== undefined ? "managed" : (entry.apiKeyEnv ?? "none")
        ]),
        { head: ["id", "provider", "dialect", "base URL", "credential env"] }
      );
    });

  endpoints
    .command("add <id>")
    .description("add a URL-backed or subscription-account endpoint")
    .requiredOption("--model <model>", "upstream model id")
    .option("--base-url <url>", "upstream API base URL")
    .option("--account <subscription-kind>", "claude-code | codex")
    .option("--provider <provider>", "provider label")
    .option("--dialect <dialect>", "openai | anthropic | google | codex")
    .option("--api-key-env <name>", "environment variable holding the credential")
    .option("--instance-id <id>", "pool instance id")
    .option("--default", "make this endpoint the default")
    .action(
      (
        id: string,
        options: {
          model: string;
          baseUrl?: string;
          account?: string;
          provider?: string;
          dialect?: string;
          apiKeyEnv?: string;
          instanceId?: string;
          default?: boolean;
        },
        command: Command
      ) => {
        if (options.account === undefined && options.baseUrl === undefined) {
          throw new Error("URL-backed endpoints require --base-url");
        }
        if (
          options.account !== undefined &&
          (options.baseUrl !== undefined ||
            options.provider !== undefined ||
            options.dialect !== undefined ||
            options.apiKeyEnv !== undefined ||
            options.instanceId !== undefined)
        ) {
          throw new Error(
            "account endpoints accept only --account, --model, and optional --default"
          );
        }
        const current = loaded(command).config;
        if (
          options.instanceId === undefined &&
          current.endpoints.some((entry) => entry.endpointId === id)
        ) {
          throw new Error(`endpoint already exists: ${id} (use --instance-id for a pool member)`);
        }
        const endpoint = {
          endpointId: id,
          model: options.model,
          ...(options.account !== undefined
            ? { account: parseAccountMode(options.account) }
            : {
                baseUrl: options.baseUrl,
                dialect: options.dialect ?? "openai",
                ...(options.provider !== undefined ? { provider: options.provider } : {}),
                ...(options.apiKeyEnv !== undefined
                  ? { apiKeyEnv: options.apiKeyEnv }
                  : {}),
                ...(options.instanceId !== undefined
                  ? { instanceId: options.instanceId }
                  : {})
              })
        };
        const next = updateEffectiveRouterConfig(
          { configPath: configOverride(command) },
          (draft) => {
            draft.endpoints = [...current.endpoints, endpoint];
            if (options.account !== undefined) {
              const subscriptionKind = parseAccountMode(options.account);
              const accounts = record(draft.accounts);
              draft.accounts = {
                ...accounts,
                [subscriptionKind]: {
                  ...record(accounts[subscriptionKind]),
                  enabled: true
                }
              };
            }
            if (options.default === true) draft.defaultEndpointId = id;
          }
        );
        const ctx = contextFor(command);
        if (ctx.json) ctx.emit({ path: next.path, endpointId: id, added: true });
        else ctx.presenter.success(`added ${id} to ${next.path}`);
      }
    );

  endpoints
    .command("remove <id>")
    .description("remove an endpoint and all of its pool members")
    .action((id: string, _options: unknown, command: Command) => {
      const current = loaded(command).config;
      const filtered = current.endpoints.filter((entry) => entry.endpointId !== id);
      if (filtered.length === current.endpoints.length) {
        throw new Error(`endpoint not found: ${id}`);
      }
      const next = updateEffectiveRouterConfig(
        { configPath: configOverride(command) },
        (draft) => {
        draft.endpoints = filtered;
        if (current.defaultEndpointId === id) {
          const first = filtered[0];
          if (first !== undefined) draft.defaultEndpointId = first.endpointId;
          else delete draft.defaultEndpointId;
        }
        }
      );
      const ctx = contextFor(command);
      if (ctx.json) {
        ctx.emit({ path: next.path, endpointId: id, removed: true, config: next.config });
      } else {
        ctx.presenter.success(`removed ${id} from ${next.path}`);
      }
    });

  endpoints
    .command("health [id]")
    .description("probe endpoint model discovery without printing credentials")
    .action(async (id: string | undefined, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      const config = loaded(command).config;
      const entries = config.endpoints.filter(
        (entry) => id === undefined || entry.endpointId === id
      );
      if (entries.length === 0) throw new Error(`endpoint not found: ${id}`);
      const results = await Promise.all(
        entries.map(async (entry) => {
          const credential =
            entry.apiKeyEnv !== undefined
              ? process.env[entry.apiKeyEnv] ??
                (entry.apiKeyEnv === CLIPROXY_API_KEY_ENV ? cliproxyApiKey() : undefined)
              : undefined;
          return {
            endpointId: entry.endpointId,
            ...(entry.instanceId !== undefined ? { instanceId: entry.instanceId } : {}),
            ...(await probeEndpointHealth(entry, { credential }))
          };
        })
      );
      writeStateSnapshot("health", "endpoints", {
        checkedAt: new Date().toISOString(),
        endpoints: results
      });
      if (ctx.json) ctx.emit({ endpoints: results });
      else {
        for (const result of results) {
          switch (result.kind) {
            case "response":
              ctx.presenter.status(
                result.ok ? "ok" : "fail",
                result.endpointId,
                `HTTP ${result.status}${result.authRejected ? " (credential rejected)" : ""}`
              );
              break;
            case "unsupported":
              ctx.presenter.status("pending", result.endpointId, result.reason);
              break;
            case "error":
              ctx.presenter.status("fail", result.endpointId, result.error);
              break;
            default: {
              const exhaustive: never = result;
              throw new Error(`unknown health result: ${String(exhaustive)}`);
            }
          }
        }
      }
      if (
        results.some(
          (result) =>
            result.kind === "error" || (result.kind === "response" && !result.ok)
        )
      ) {
        process.exitCode = 1;
      }
    });
}
