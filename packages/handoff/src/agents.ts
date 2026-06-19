import type { AgentKind, AgentSpec } from "@fusionkit/protocol";

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
  /**
   * Cursor CLI (cursor-agent), wrapped as-is. Runs against a Cursorkit bridge
   * whose local-model backend points at the fusion gateway.
   */
  cursor(options: { version?: string } = {}): AgentSpec {
    return spec("cursor", options.version);
  },
  /**
   * Pi: a host-runtime coding harness driven through the AI SDK harness
   * backend. Runs only on a session tier that registers the pi binding
   * (the swarm's local-model workers); never spawned as a vendor CLI.
   */
  pi(options: { version?: string } = {}): AgentSpec {
    return spec("pi", options.version);
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
