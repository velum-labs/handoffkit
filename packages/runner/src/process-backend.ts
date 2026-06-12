import { spawn } from "node:child_process";

import { hashCanonical } from "@warrant/protocol";

import type {
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "./backend.js";
import { startEgressProxy } from "./egress.js";

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
    const { contract, repoDir, secrets, command, timeoutMin, emit } = input;

    const proxy = await startEgressProxy(
      contract.network.allowHosts,
      contract.network.defaultDeny,
      ({ host, decision }) => emit({ type: "network.connected", host, decision })
    );

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? FALLBACK_PATH,
      HOME: process.env.HOME ?? FALLBACK_HOME,
      HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
      HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
      http_proxy: `http://127.0.0.1:${proxy.port}`,
      https_proxy: `http://127.0.0.1:${proxy.port}`
    };
    for (const secret of secrets) {
      env[secret.name] = secret.value;
    }

    const { cmd, args } = command;
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
        // 127 is the conventional shell exit code for "command not found".
        resolve(SPAWN_ERROR_EXIT_CODE);
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

    return { exitCode, log: Buffer.concat(chunks) };
  }
}
