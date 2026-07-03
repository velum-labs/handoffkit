// A minimal ACP agent over stdio for driver tests: it advertises loadSession,
// echoes the prompt as an agent_message_chunk, and (when the prompt contains
// "APPROVE") requests one permission before completing the turn. Built on the
// official ACP AgentSideConnection so the driver exercises the real wire.
import { Readable, Writable } from "node:stream";

import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream
} from "@zed-industries/agent-client-protocol";

let nextSession = 1;

class FakeAgent {
  constructor(conn) {
    this.conn = conn;
  }

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: "cursor_login", name: "Cursor Login", description: null }]
    };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    return { sessionId: `fake-session-${nextSession++}` };
  }

  async loadSession() {
    return {};
  }

  async setSessionModel() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async prompt(params) {
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    if (text.includes("APPROVE")) {
      const outcome = await this.conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call-1", title: "rm -rf tmp", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" }
        ]
      });
      if (outcome.outcome.outcome === "cancelled" || outcome.outcome.optionId === "reject") {
        return { stopReason: "cancelled" };
      }
    }
    await this.conn.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } }
    });
    return { stopReason: "end_turn" };
  }

  async cancel() {}
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);
new AgentSideConnection((conn) => new FakeAgent(conn), stream);
