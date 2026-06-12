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
import { hashCanonical } from "@warrant/protocol";
import type { NetworkPolicy } from "@warrant/protocol";
import type {
  SessionBackend,
  SessionBackendResult,
  SessionExecution
} from "@warrant/runner";
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

/** Extract the shell script from a `command` harness invocation. */
function scriptFor(input: SessionExecution): string {
  const { cmd, args } = input.command;
  if ((cmd === "sh" || cmd === "bash") && args[0] === "-c" && args[1] !== undefined) {
    return args[1];
  }
  return input.contract.task.prompt;
}

export class HermeticSessionBackend implements SessionBackend {
  readonly isolation = "hermetic" as const;

  supports(agentKind: SessionExecution["contract"]["agent"]["kind"]): boolean {
    // No real OS: only the single-shell-command harness runs hermetically.
    return agentKind === "command";
  }

  async execute(input: SessionExecution): Promise<SessionBackendResult> {
    const { contract, repoDir, secrets, command, timeoutMin, emit } = input;

    const env: Record<string, string> = {};
    for (const secret of secrets) env[secret.name] = secret.value;

    const network = toJustBashNetwork(contract.network);
    const bash = new Bash({
      // Writes land on the real workspace so the runner's git-based output
      // collection captures the diff, exactly like the process backend.
      fs: new ReadWriteFs({ root: repoDir }),
      // TODO(hardcoded): hermetic cwd /
      cwd: "/",
      env,
      ...(network ? { network } : {})
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMin * 60 * 1000);
    let exitCode: number;
    let stdout = "";
    let stderr = "";
    try {
      const result = await bash.exec(scriptFor(input), { signal: controller.signal });
      exitCode = result.exitCode;
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      // TODO(hardcoded): abort exit code 124
      exitCode = 124;
      stderr = `hermetic session aborted: ${
        error instanceof Error ? error.message : String(error)
      }\n`;
    } finally {
      clearTimeout(timer);
    }

    emit({
      type: "command.executed",
      argvHash: hashCanonical([command.cmd, ...command.args]),
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
