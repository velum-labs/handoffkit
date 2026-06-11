import type { AgentKind } from "@warrant/protocol";

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
        cmd: "claude",
        args: ["-p", prompt, "--permission-mode", "acceptEdits"]
      };
    case "codex":
      return {
        cmd: "codex",
        args: ["exec", "--skip-git-repo-check", prompt]
      };
    case "mock":
      return {
        cmd: process.execPath,
        args: [ctx.mockScriptPath, prompt]
      };
    default: {
      const exhausted: never = kind;
      throw new Error(`unsupported agent kind: ${String(exhausted)}`);
    }
  }
}
