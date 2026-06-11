import { spawn } from "node:child_process";

import { hashCanonical } from "../protocol/hash.js";
import type { RunContract, RunEvent } from "../protocol/types.js";
import { buildAgentCommand } from "./agents.js";
import { startEgressProxy } from "./egress.js";
import { collectOutput } from "./workspace.js";
import type { WorkspaceOutput } from "./workspace.js";

export type SessionResult = {
  exitCode: number;
  log: Buffer;
  output: WorkspaceOutput;
};

const DEFAULT_TIMEOUT_MIN = 10;

/**
 * Run the agent harness inside a governed session: scrubbed environment,
 * injected secrets, deny-by-default egress through the session proxy, and
 * an event emitted for every observable boundary action.
 */
export async function runSession(input: {
  contract: RunContract;
  repoDir: string;
  secrets: { name: string; value: string }[];
  mockScriptPath: string;
  emit: (event: RunEvent) => void;
}): Promise<SessionResult> {
  const { contract, repoDir, secrets, mockScriptPath, emit } = input;

  const proxy = await startEgressProxy(
    contract.network.allowHosts,
    contract.network.defaultDeny,
    ({ host, decision }) => emit({ type: "network.connected", host, decision })
  );

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
    http_proxy: `http://127.0.0.1:${proxy.port}`,
    https_proxy: `http://127.0.0.1:${proxy.port}`
  };
  for (const secret of secrets) {
    env[secret.name] = secret.value;
  }

  const { cmd, args } = buildAgentCommand(
    contract.agent.kind,
    contract.task.prompt,
    { mockScriptPath }
  );

  const timeoutMin = contract.budget.maxDurationMin ?? DEFAULT_TIMEOUT_MIN;
  const chunks: Buffer[] = [];

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { cwd: repoDir, env });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMin * 60 * 1000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", (error) => {
      chunks.push(Buffer.from(`spawn error: ${error.message}\n`, "utf8"));
      clearTimeout(timer);
      resolve(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });

  await proxy.close();

  emit({
    type: "command.executed",
    argvHash: hashCanonical([cmd, ...args]),
    exitCode
  });

  const output = collectOutput(repoDir, contract.workspace.baseRef);
  for (const file of output.changedFiles) {
    emit({ type: "file.changed", path: file.path, contentHash: file.contentHash });
  }

  return { exitCode, log: Buffer.concat(chunks), output };
}
