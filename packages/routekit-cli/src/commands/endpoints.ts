import { CLIPROXY_API_KEY_ENV, cliproxyApiKey } from "@routekit/accounts";
import { contextFor } from "@routekit/cli-core";
import { probeEndpointHealth } from "@routekit/gateway";
import type { Command } from "commander";

import { loadRouterConfig, updateRouterConfig, writeRouterConfig } from "../config.js";
import { writeStateSnapshot } from "../state.js";

import { editableConfigPath, loaded } from "./context.js";

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
          entry.provider ?? "custom",
          entry.dialect,
          entry.baseUrl,
          entry.apiKeyEnv ?? "none"
        ]),
        { head: ["id", "provider", "dialect", "base URL", "credential env"] }
      );
    });

  endpoints
    .command("add <id>")
    .description("add an endpoint using an environment credential reference")
    .requiredOption("--model <model>", "upstream model id")
    .requiredOption("--base-url <url>", "upstream API base URL")
    .option("--provider <provider>", "provider label")
    .option("--dialect <dialect>", "openai | anthropic | google | codex", "openai")
    .option("--api-key-env <name>", "environment variable holding the credential")
    .option("--instance-id <id>", "pool instance id")
    .option("--default", "make this endpoint the default")
    .action(
      (
        id: string,
        options: {
          model: string;
          baseUrl: string;
          provider?: string;
          dialect: string;
          apiKeyEnv?: string;
          instanceId?: string;
          default?: boolean;
        },
        command: Command
      ) => {
        const path = editableConfigPath({ command });
        const current = loadRouterConfig({ configPath: path }).config;
        if (
          options.instanceId === undefined &&
          current.endpoints.some((entry) => entry.endpointId === id)
        ) {
          throw new Error(`endpoint already exists: ${id} (use --instance-id for a pool member)`);
        }
        const next = {
          ...current,
          endpoints: [
            ...current.endpoints,
            {
              endpointId: id,
              model: options.model,
              baseUrl: options.baseUrl,
              dialect: options.dialect,
              ...(options.provider !== undefined ? { provider: options.provider } : {}),
              ...(options.apiKeyEnv !== undefined ? { apiKeyEnv: options.apiKeyEnv } : {}),
              ...(options.instanceId !== undefined ? { instanceId: options.instanceId } : {})
            }
          ],
          ...(options.default === true ? { defaultEndpointId: id } : {})
        };
        writeRouterConfig(path, next);
        const ctx = contextFor(command);
        if (ctx.json) ctx.emit({ path, endpointId: id, added: true });
        else ctx.presenter.success(`added ${id} to ${path}`);
      }
    );

  endpoints
    .command("remove <id>")
    .description("remove an endpoint and all of its pool members")
    .action((id: string, _options: unknown, command: Command) => {
      const path = editableConfigPath({ command });
      const next = updateRouterConfig(path, (draft) => {
        const entries = Array.isArray(draft.endpoints) ? draft.endpoints : [];
        const filtered = entries.filter(
          (entry) =>
            typeof entry !== "object" ||
            entry === null ||
            (entry as { endpointId?: unknown }).endpointId !== id
        );
        if (filtered.length === entries.length) throw new Error(`endpoint not found: ${id}`);
        draft.endpoints = filtered;
        if (draft.defaultEndpointId === id) {
          const first = filtered[0] as { endpointId?: unknown } | undefined;
          if (typeof first?.endpointId === "string") draft.defaultEndpointId = first.endpointId;
          else delete draft.defaultEndpointId;
        }
      });
      const ctx = contextFor(command);
      if (ctx.json) ctx.emit({ path, endpointId: id, removed: true, config: next });
      else ctx.presenter.success(`removed ${id} from ${path}`);
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
