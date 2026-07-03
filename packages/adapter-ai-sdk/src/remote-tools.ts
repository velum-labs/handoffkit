import { jsonSchema, tool } from "ai";
import type { Tool } from "ai";

import {
  createCommandContext,
  executeGovernedCommand,
  Handoff,
  targets,
  toGovernedRunRecord
} from "@fusionkit/handoff";
import type { CommandHarnessConfig, GovernedRunRecord } from "@fusionkit/handoff";
import type { RunStatus } from "@fusionkit/protocol";
import { RUNTIME_TIMEOUT_MS } from "@fusionkit/runtime-utils";

export type RemoteToolsConfig = CommandHarnessConfig & {
  /** Pull workspace changes back after each call. Defaults to true. */
  pullResults?: boolean;
};

/**
 * Alternative wiring: attach the remote tools to an existing continuation
 * context (e.g. the golden-interface `handoff(...)`) so tool calls,
 * continuations, and sandbox commands share one workspace, policy, and
 * trace instead of forking a second context.
 */
export type RemoteToolsContextConfig = {
  context: Handoff;
  /** Runner pool that executes the tool calls. */
  pool: string;
  /** Pull workspace changes back after each call. Defaults to true. */
  pullResults?: boolean;
  /** Per-call wait ceiling. Defaults to 5 minutes. */
  timeoutMs?: number;
};

export type ShellToolInput = {
  command: string;
};

export type ShellToolOutput = {
  runId: string;
  status: RunStatus;
  exitCode: number | undefined;
  output: string;
};

export type RemoteToolCallRecord = GovernedRunRecord & {
  toolName: "shell";
};

export type RemoteToolSet = {
  shell: Tool<ShellToolInput, ShellToolOutput>;
};

/** Default per-call wait ceiling for governed tool runs. */
const DEFAULT_REMOTE_TOOL_TIMEOUT_MS = RUNTIME_TIMEOUT_MS.remoteTool;

export type RemoteTools = {
  /** AI SDK-compatible tools; pass directly to generateText/streamText. */
  tools: RemoteToolSet;
  /** One record per executed tool call: run id, receipt hash, verification. */
  calls(): RemoteToolCallRecord[];
  /** The underlying continuation context (trace, lastEnvelope, …). */
  context: Handoff;
};

/**
 * App-owned loops, honestly labeled (spec §6.2): the model loop stays in the
 * caller's process and carries no durability claim. What Warrant adds is the
 * execution boundary — every tool call becomes a signed run contract executed
 * in a governed session and returns alongside an offline-verifiable receipt.
 *
 * There is no `handoff-needed` stream event and no mid-generation
 * continuation; those are deliberately out of scope.
 */
export function remoteTools(
  config: RemoteToolsConfig | RemoteToolsContextConfig
): RemoteTools {
  const context =
    "context" in config ? config.context : createCommandContext(config);
  const target = targets.pool(config.pool);
  const pullResults = config.pullResults ?? true;
  const timeoutMs = config.timeoutMs ?? DEFAULT_REMOTE_TOOL_TIMEOUT_MS;
  const records: RemoteToolCallRecord[] = [];

  const shell = tool({
    description:
      "Run a shell command in a governed session on a customer-controlled runner. " +
      "The session materializes the current workspace; changes are pulled back. " +
      "Every call is recorded in a signed, offline-verifiable receipt.",
    inputSchema: jsonSchema<ShellToolInput>({
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute in the governed session."
        }
      },
      required: ["command"],
      additionalProperties: false
    }),
    execute: async ({ command }): Promise<ShellToolOutput> => {
      const result = await executeGovernedCommand(context, {
        command,
        target,
        reason: "app-owned loop tool call",
        timeoutMs,
        pullResults
      });

      records.push({ toolName: "shell", ...toGovernedRunRecord(command, result) });

      return {
        runId: result.run.runId,
        status: result.status,
        exitCode: result.exitCode,
        output: result.output
      };
    }
  });

  return {
    tools: { shell },
    calls: () => [...records],
    context
  };
}
