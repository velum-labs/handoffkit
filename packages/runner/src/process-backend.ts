import { spawn } from "node:child_process";

import { resolveInsideWorkspace } from "@warrant/workspace";
import type {
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "./backend.js";
import { startEgressProxy } from "./egress.js";
import { executionHash, resolveSessionEnv } from "./execution.js";

/** Minimal PATH/HOME used only when the host process has none set. */
const FALLBACK_PATH = "/usr/bin:/bin";
const FALLBACK_HOME = "/tmp";
/** Exit code reported when the harness binary cannot be spawned. */
const SPAWN_ERROR_EXIT_CODE = 127;

/**
 * The built-in backend: the harness runs as a child process with a
 * scrubbed environment, injected secrets, and deny-by-default egress
 * through the session proxy.
 *
 * Honest limitation (documented in the spec): this is process-level
 * enforcement. A malicious binary can ignore proxy variables; the
 * hermetic and microVM backends close that gap. Every allowed and
 * blocked attempt is still recorded.
 */
export class ProcessSessionBackend implements SessionBackend {
  readonly isolation = "process" as const;

  async execute(input: SessionExecution): Promise<SessionBackendResult> {
    const { contract, repoDir, secrets, execution, emit } = input;

    const proxy = execution.egressProxy
      ? await startEgressProxy(
          contract.network.allowHosts,
          contract.network.defaultDeny,
          ({ host, decision }) => emit({ type: "network.connected", host, decision })
        )
      : undefined;

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? FALLBACK_PATH,
      HOME: process.env.HOME ?? FALLBACK_HOME
    };
    if (proxy) {
      env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
      env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
      env.http_proxy = `http://127.0.0.1:${proxy.port}`;
      env.https_proxy = `http://127.0.0.1:${proxy.port}`;
    }
    Object.assign(env, resolveSessionEnv(execution.env, secrets));

    const { cmd, args } =
      execution.kind === "argv"
        ? { cmd: execution.cmd, args: execution.args }
        : { cmd: execution.shell, args: ["-c", execution.script] };
    const cwd = resolveInsideWorkspace(repoDir, execution.cwd);
    const chunks: Buffer[] = [];
    let capturedBytes = 0;

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(cmd, args, { cwd, env });
      const push = (chunk: Buffer) => {
        chunks.push(chunk);
        capturedBytes += chunk.byteLength;
        if (execution.logMaxBytes !== undefined && capturedBytes > execution.logMaxBytes) {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, execution.timeoutMs);
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("error", (error) => {
        chunks.push(Buffer.from(`spawn error: ${error.message}\n`, "utf8"));
        clearTimeout(timer);
        // 127 is the conventional shell exit code for "command not found".
        resolve(SPAWN_ERROR_EXIT_CODE);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    await proxy?.close();

    emit({
      type: "command.executed",
      argvHash: executionHash(execution),
      exitCode
    });

    return { exitCode, log: Buffer.concat(chunks) };
  }
}
