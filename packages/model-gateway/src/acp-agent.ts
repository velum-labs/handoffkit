/**
 * ACP-compatible front door for the unified runner.
 *
 * Implements the minimal Agent Client Protocol (ACP) local-agent lifecycle over
 * newline-delimited JSON-RPC on stdio: `initialize`, `authenticate`,
 * `session/new`, and `session/prompt`. A `session/prompt` runs the unified
 * harness ensemble through an injected runner and streams the synthesized final
 * answer back as `session/update` notifications before returning the prompt
 * turn's stop reason.
 *
 * The runner is injected so this package stays free of a dependency on
 * `@fusionkit/ensemble` (which depends on this package). The input/output streams
 * are injectable for deterministic testing.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export const ACP_PROTOCOL_VERSION = 1;

export type AcpRunnerInput = {
  prompt: string;
  sessionId: string;
  requestId: string;
};

export type AcpRunnerResult = {
  finalOutput: string;
  runId: string;
  status: "succeeded" | "failed" | "skipped";
  evidence: string[];
};

export type AcpRunner = (input: AcpRunnerInput) => Promise<AcpRunnerResult>;

export type AcpAgentOptions = {
  runner: AcpRunner;
  input?: Readable;
  output?: Writable;
  protocolVersion?: number;
};

type JsonRpcId = number | string;

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

type AcpContentBlock = { type?: string; text?: string };

function textFromPromptParam(params: unknown): string {
  if (typeof params !== "object" || params === null) return "";
  const prompt = (params as { prompt?: unknown }).prompt;
  if (typeof prompt === "string") return prompt;
  if (Array.isArray(prompt)) {
    return prompt
      .map((block) => {
        const candidate = block as AcpContentBlock;
        return typeof candidate.text === "string" ? candidate.text : "";
      })
      .join("");
  }
  return "";
}

function sessionIdFromParams(params: unknown, fallback: string): string {
  if (typeof params === "object" && params !== null) {
    const sessionId = (params as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  return fallback;
}

/**
 * Run the ACP agent loop until the input stream ends. Resolves when input
 * closes. Each line is one JSON-RPC message.
 */
export async function runAcpAgent(options: AcpAgentOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const protocolVersion = options.protocolVersion ?? ACP_PROTOCOL_VERSION;
  let sessionCounter = 0;
  let requestCounter = 0;

  const send = (message: JsonRpcMessage): void => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const respond = (id: JsonRpcId, result: unknown): void => {
    send({ id, result });
  };

  const respondError = (id: JsonRpcId, code: number, message: string): void => {
    send({ id, error: { code, message } });
  };

  const handlePrompt = async (id: JsonRpcId, params: unknown): Promise<void> => {
    const sessionId = sessionIdFromParams(params, `sess_${sessionCounter}`);
    const prompt = textFromPromptParam(params);
    requestCounter += 1;
    const result = await options.runner({
      prompt,
      sessionId,
      requestId: `acp_${requestCounter}`
    });
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.finalOutput }
        }
      }
    });
    respond(id, {
      stopReason: result.status === "succeeded" ? "end_turn" : "refusal",
      _meta: { runId: result.runId, status: result.status, evidence: result.evidence }
    });
  };

  const dispatch = async (message: JsonRpcMessage): Promise<void> => {
    const { id, method } = message;
    if (method === undefined || id === undefined) return;
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true }
          },
          authMethods: []
        });
        return;
      case "authenticate":
        respond(id, {});
        return;
      case "session/new":
        sessionCounter += 1;
        respond(id, { sessionId: `sess_${sessionCounter}` });
        return;
      case "session/load":
        respond(id, {});
        return;
      case "session/cancel":
        respond(id, {});
        return;
      case "session/prompt":
        await handlePrompt(id, message.params);
        return;
      default:
        respondError(id, -32601, `method not found: ${method}`);
        return;
    }
  };

  const rl = createInterface({ input });
  const pending: Promise<void>[] = [];
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    pending.push(
      dispatch(message).catch((error: unknown) => {
        if (message.id !== undefined) {
          respondError(message.id, -32603, error instanceof Error ? error.message : String(error));
        }
      })
    );
  });

  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });
  await Promise.all(pending);
}
