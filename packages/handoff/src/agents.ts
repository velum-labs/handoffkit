import type { AgentKind, AgentSpec } from "@warrant/protocol";

/**
 * Typed agent descriptors, mirroring the AI SDK provider pattern:
 * `agents.claudeCode()` instead of `"claude-code"`. Strings remain
 * acceptable as CLI aliases; the SDK contract is typed.
 */
export type AgentDescriptor = {
  kind: "agent-descriptor";
  agent: AgentKind;
  version?: string;
};

function descriptor(agent: AgentKind, version?: string): AgentDescriptor {
  return { kind: "agent-descriptor", agent, ...(version ? { version } : {}) };
}

export const agents = {
  claudeCode(options: { version?: string } = {}): AgentDescriptor {
    return descriptor("claude-code", options.version);
  },
  codex(options: { version?: string } = {}): AgentDescriptor {
    return descriptor("codex", options.version);
  },
  /** Built-in mock harness: runs without vendor CLIs or API keys. */
  mock(): AgentDescriptor {
    return descriptor("mock");
  },
  /** One governed shell command; the task prompt is the command. */
  command(): AgentDescriptor {
    return descriptor("command");
  }
};

export function toAgentSpec(agent: AgentDescriptor): AgentSpec {
  return { kind: agent.agent, ...(agent.version ? { version: agent.version } : {}) };
}
