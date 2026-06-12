/**
 * @warrant/session-hermetic — a hermetic session backend built on
 * just-bash: a simulated bash interpreter with a virtual filesystem and
 * interpreter-enforced network allowlists.
 *
 * What this buys over the process backend: there are no real processes or
 * sockets inside the session, so there is nothing to escape with. Egress
 * is enforced by the interpreter (the `curl` builtin only exists for
 * allowlisted origins), not by environment variables a binary could
 * ignore. The trade-off, stated honestly: only the "command" harness runs
 * here — there is no real OS, so vendor CLIs and the node-based mock do not.
 */
import type { NetworkPolicy } from "@warrant/protocol";
import type {
  BackendExecutionKind,
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "@warrant/runner";
import { executionHash, requireShellExecution } from "@warrant/runner";
import { Bash, ReadWriteFs } from "just-bash";

type NetworkConfig =
  | undefined
  | { dangerouslyAllowFullInternetAccess: true }
  | { allowedUrlPrefixes: string[] };

/** Map a Warrant network policy to just-bash's allowlist model. */
export function toJustBashNetwork(policy: NetworkPolicy): NetworkConfig {
  if (!policy.defaultDeny) {
    return { dangerouslyAllowFullInternetAccess: true };
  }
  if (policy.allowHosts.length === 0) return undefined;
  const allowedUrlPrefixes = policy.allowHosts.flatMap((host) => [
    `https://${host}`,
    `http://${host}`
  ]);
  return { allowedUrlPrefixes };
}

/**
 * The interpreter's virtual filesystem is rooted at the workspace, so "/"
 * IS the workspace from the script's point of view — it cannot name any
 * path outside it.
 */
const HERMETIC_CWD = "/";
/** Conventional timeout exit code (what coreutils `timeout` reports). */
const TIMEOUT_EXIT_CODE = 124;

export class HermeticSessionBackend implements SessionBackend {
  readonly isolation = "hermetic" as const;

  supports(kind: BackendExecutionKind): boolean {
    // No real OS: only shell scripts can run in the interpreter.
    return kind === "shell";
  }

  async execute(input: SessionExecution): Promise<SessionBackendResult> {
    const { contract, repoDir, secrets, execution, emit } = input;
    const shell = requireShellExecution(execution);

    const env: Record<string, string> = { ...shell.env };
    for (const secret of secrets) env[secret.name] = secret.value;
    for (const [key, value] of Object.entries(env)) {
      if (!value.startsWith("__WARRANT_SECRET__:")) continue;
      const secretName = value.slice("__WARRANT_SECRET__:".length);
      const secret = secrets.find((item) => item.name === secretName);
      if (secret) env[key] = secret.value;
    }

    const network = toJustBashNetwork(contract.network);
    const bash = new Bash({
      // Writes land on the real workspace so the runner's git-based output
      // collection captures the diff, exactly like the process backend.
      fs: new ReadWriteFs({ root: repoDir }),
      cwd: HERMETIC_CWD,
      env,
      ...(network ? { network } : {})
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), shell.timeoutMs);
    let exitCode: number;
    let stdout = "";
    let stderr = "";
    try {
      const result = await bash.exec(shell.script, { signal: controller.signal });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      exitCode = TIMEOUT_EXIT_CODE;
      stderr = `hermetic session aborted: ${
        error instanceof Error ? error.message : String(error)
      }\n`;
    } finally {
      clearTimeout(timer);
    }

    emit({
      type: "command.executed",
      argvHash: executionHash(shell),
      exitCode
    });

    const log = Buffer.from(stdout + stderr, "utf8");
    return { exitCode, log };
  }
}

/** Create a hermetic session backend for a Warrant runner. */
export function hermeticBackend(): HermeticSessionBackend {
  return new HermeticSessionBackend();
}
