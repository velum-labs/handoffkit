import type { AgentKind, AgentSpec } from "@warrant/protocol";

/**
 * Typed agent constructors, mirroring the AI SDK provider pattern:
 * `agents.claudeCode()` instead of `"claude-code"`. Strings remain
 * acceptable as CLI aliases; the SDK contract is the protocol's
 * `AgentSpec` — there is no separate descriptor shape to convert.
 */
function spec(kind: AgentKind, version?: string): AgentSpec {
  return { kind, ...(version ? { version } : {}) };
}

export const agents = {
  claudeCode(options: { version?: string } = {}): AgentSpec {
    return spec("claude-code", options.version);
  },
  codex(options: { version?: string } = {}): AgentSpec {
    return spec("codex", options.version);
  },
  /** Built-in mock harness: runs without vendor CLIs or API keys. */
  mock(): AgentSpec {
    return spec("mock");
  },
  /** One governed shell command; the task prompt is the command. */
  command(): AgentSpec {
    return spec("command");
  }
};
