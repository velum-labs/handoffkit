import type { AgentKind } from "@fusionkit/protocol";

export type AgentCommand = {
  cmd: string;
  args: string[];
};

export type AgentContext = {
  /** Absolute path to the built-in mock agent script (dist). */
  mockScriptPath: string;
};

/**
 * Agent adapters build the command line for a vendor harness, unmodified.
 * The labs' RL investment lands in their CLIs; Warrant wraps them in a
 * governed session rather than reimplementing them.
 */
export function buildAgentCommand(
  kind: AgentKind,
  prompt: string,
  ctx: AgentContext
): AgentCommand {
  switch (kind) {
    case "claude-code":
      return {
        // The vendor CLI invocation, wrapped as-is. These names and flags
        // are the vendor's contract, not Warrant's to abstract away.
        cmd: "claude",
        args: ["-p", prompt, "--permission-mode", "acceptEdits"]
      };
    case "codex":
      return {
        cmd: "codex",
        args: ["exec", "--skip-git-repo-check", prompt]
      };
    case "pi":
      // Pi is a host-runtime harness with no vendor CLI to wrap: it runs only
      // through the AI SDK harness session backend, which ignores this argv
      // (exactly as the harness path ignores the claude-code argv). The argv
      // is a non-spawnable placeholder that exists only so the prepared
      // execution has a stable shape to hash; the process backend refuses to
      // spawn pi outright, so this command line is never executed.
      return {
        cmd: "pi",
        args: ["--harness-only"]
      };
    case "mock":
      return {
        cmd: process.execPath,
        args: [ctx.mockScriptPath, prompt]
      };
    case "command":
      // The task itself is the harness: one governed shell command. Used by
      // app-owned loops (AI SDK adapter) and the compute adapter.
      return {
        cmd: "sh",
        args: ["-c", prompt]
      };
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported agent kind: ${String(exhausted)}`);
    }
  }
}
