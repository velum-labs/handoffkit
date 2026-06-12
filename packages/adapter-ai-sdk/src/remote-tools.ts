import { jsonSchema, tool } from "ai";
import type { Tool } from "ai";

import {
  agents,
  executeGovernedCommand,
  Handoff,
  handoff,
  targets
} from "@warrant/handoff";
import type { ContinuationPolicy } from "@warrant/handoff";
import type { ActorRef, RunStatus } from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";

export type RemoteToolsConfig = {
  /** Local git workspace whose state the governed session materializes. */
  workspace: string;
  plane: PlaneClient | { url: string; adminToken: string };
  /** Runner pool that executes the tool calls. */
  pool: string;
  actor?: ActorRef;
  policy?: ContinuationPolicy;
  secrets?: string[];
  allowHosts?: string[];
  allowUntracked?: string[];
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

export type RemoteToolCallRecord = {
  toolName: "shell";
  command: string;
  runId: string;
  status: RunStatus;
  exitCode?: number;
  contractHash: string;
  /** Offline verification result of the receipt bundle for this call. */
  receiptVerified: boolean;
  pullMode?: "applied" | "branch" | "empty";
};

export type RemoteToolSet = {
  shell: Tool<ShellToolInput, ShellToolOutput>;
};

/** Default per-call wait ceiling for governed tool runs. */
export const DEFAULT_REMOTE_TOOL_TIMEOUT_MS = 5 * 60 * 1000;

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
export function remoteTools(config: RemoteToolsConfig): RemoteTools {
  const context = handoff({
    workspace: config.workspace,
    plane: config.plane,
    agent: agents.command(),
    ...(config.actor ? { actor: config.actor } : {}),
    ...(config.policy ? { policy: config.policy } : {}),
    ...(config.secrets ? { secrets: config.secrets } : {}),
    ...(config.allowHosts ? { allowHosts: config.allowHosts } : {}),
    ...(config.allowUntracked ? { allowUntracked: config.allowUntracked } : {})
  });
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

      const record: RemoteToolCallRecord = {
        toolName: "shell",
        command,
        runId: result.run.runId,
        status: result.status,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        contractHash: result.receiptBundle.receipt.contractHash,
        receiptVerified: result.verification.ok
      };
      if (result.pullResult) {
        record.pullMode = result.pullResult.mode;
      }
      records.push(record);

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
