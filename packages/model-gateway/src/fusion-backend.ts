/**
 * The fusion front-door backend.
 *
 * This is the clean abstraction behind "the judge streams a trajectory the
 * user's harness executes". It implements the gateway {@link Backend} contract
 * (an OpenAI Chat Completions surface) so it slots into the existing
 * `startGateway` server and reuses every dialect adapter (chat / responses /
 * anthropic) — including their full tool-call, tool-result, and streaming
 * support — for free.
 *
 * Per front-door turn it:
 *   1. derives a stable session key from the conversation prefix,
 *   2. runs the panel **once** per session (injected `runPanels`, so this
 *      package keeps no dependency on `@warrant/ensemble`) to produce the
 *      candidate trajectories,
 *   3. forwards the live conversation + the harness tools + the candidate
 *      trajectories to FusionKit's `trajectory:step`, whose response (an OpenAI
 *      chat completion, optionally streamed, that may carry `tool_calls`) is
 *      returned verbatim for the server to translate into the caller's dialect.
 *
 * There is no apply/verify/repair here: iteration is the user's harness's job.
 */

import { createHash } from "node:crypto";

import { newTraceId, TRACE_ID_HEADER } from "@warrant/protocol";

import type { Backend, BackendRequestOptions } from "./backend.js";

/** A candidate trajectory in the wire shape FusionKit's `trajectory:step` accepts. */
export type WireTrajectory = {
  trajectory_id: string;
  model_id: string;
  status: string;
  final_output: string;
  steps?: Array<Record<string, unknown>>;
  candidate_id?: string;
  model?: string;
  harness_kind?: string;
  diff?: string;
  verification?: { status: string; evidence?: string[]; exit_code?: number };
  metadata?: Record<string, unknown>;
};

export type ChatMessageLike = {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
};

export type PanelRunInput = {
  /** The task prompt distilled from the conversation prefix (system + first user). */
  task: string;
  /** The full incoming OpenAI-style message list for the first turn. */
  messages: ChatMessageLike[];
  /** The trace id minted for this fusion session. */
  traceId: string;
  /** Stable per-session key (hash of the conversation prefix). */
  sessionKey: string;
};

/** Runs the panel once for a session and returns its candidate trajectories. */
export type PanelRunner = (input: PanelRunInput) => Promise<WireTrajectory[]>;

export type FusionBackendOptions = {
  /** FusionKit `POST /v1/fusion/trajectory:step` URL. */
  stepUrl: string;
  /** Produces candidate trajectories for a new session (injected; uses ensemble). */
  runPanels: PanelRunner;
  /** Model id echoed to clients and sent to the judge step. */
  defaultModel?: string;
  /** Judge model id forwarded to FusionKit (defaults to its configured judge). */
  judgeModel?: string;
  /** How long a session's candidate trajectories stay cached. */
  sessionTtlMs?: number;
  /** Mint a trace id (injectable for tests). */
  mintTraceId?: () => string;
};

type Session = {
  traceId: string;
  candidates: Promise<WireTrajectory[]>;
  createdAt: number;
};

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

export class FusionBackend implements Backend {
  readonly defaultModel: string | undefined;

  readonly #stepUrl: string;
  readonly #runPanels: PanelRunner;
  readonly #judgeModel: string | undefined;
  readonly #ttlMs: number;
  readonly #mintTraceId: () => string;
  readonly #sessions = new Map<string, Session>();

  constructor(options: FusionBackendOptions) {
    this.#stepUrl = options.stepUrl;
    this.#runPanels = options.runPanels;
    this.defaultModel = options.defaultModel;
    this.#judgeModel = options.judgeModel;
    this.#ttlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#mintTraceId = options.mintTraceId ?? newTraceId;
  }

  async chat(body: unknown, signal?: AbortSignal, options: BackendRequestOptions = {}): Promise<Response> {
    const chat = (body ?? {}) as {
      model?: string;
      messages?: ChatMessageLike[];
      tools?: unknown;
      tool_choice?: unknown;
      stream?: boolean;
    };
    const messages = Array.isArray(chat.messages) ? chat.messages : [];
    const sessionKey = this.#sessionKey(messages);
    const session = this.#ensureSession(sessionKey, messages);
    const streaming = chat.stream === true;

    const buildStepBody = (candidates: WireTrajectory[]): string => {
      const stepBody: Record<string, unknown> = {
        model: chat.model ?? this.defaultModel ?? "fusion-panel",
        messages,
        trajectories: candidates,
        stream: streaming
      };
      if (chat.tools !== undefined) stepBody.tools = chat.tools;
      if (chat.tool_choice !== undefined) stepBody.tool_choice = chat.tool_choice;
      if (this.#judgeModel !== undefined) stepBody.judge_model = this.#judgeModel;
      return JSON.stringify(stepBody);
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [TRACE_ID_HEADER]: session.traceId
    };
    if (options.modelCallId) headers["x-velum-model-call-id"] = options.modelCallId;

    // Non-streaming: the panel phase can block before the single JSON reply.
    if (!streaming) {
      const candidates = await session.candidates;
      return fetch(this.#stepUrl, {
        method: "POST",
        headers,
        body: buildStepBody(candidates),
        ...(signal ? { signal } : {})
      });
    }

    // Streaming: return immediately with a live SSE stream so the caller's HTTP
    // client sees the response start right away. The (potentially slow) panel
    // phase runs inside the stream behind keepalive comments, then the judge
    // step's SSE is piped through. This avoids first-byte timeouts in real CLIs
    // (e.g. codex) while the panel solves the task once.
    const stepUrl = this.#stepUrl;
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        let alive = true;
        const keepalive = setInterval(() => {
          if (alive) {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              alive = false;
            }
          }
        }, 3000);
        try {
          const candidates = await session.candidates;
          if (process.env.FUSION_DEBUG) {
            const toolNames = Array.isArray(chat.tools)
              ? chat.tools.map((t) => {
                  const tool = t as { type?: string; name?: string; function?: { name?: string } };
                  return tool.function?.name ?? tool.name ?? tool.type ?? "?";
                })
              : [];
            console.error(
              `[fusion-debug] step: messages=${messages.length} roles=${messages.map((m) => m.role).join(",")} ` +
                `candidates=${candidates.length} tools=[${toolNames.join(", ")}]`
            );
          }
          const upstream = await fetch(stepUrl, {
            method: "POST",
            headers,
            body: buildStepBody(candidates),
            ...(signal ? { signal } : {})
          });
          if (!upstream.ok || upstream.body === null) {
            const detail = upstream.body === null ? "no stream" : (await upstream.text()).slice(0, 800);
            if (process.env.FUSION_DEBUG) console.error(`[fusion-debug] step upstream ${upstream.status}: ${detail}`);
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ index: 0, delta: { content: `fusion step error: ${detail}` }, finish_reason: "stop" }]
                })}\n\n`
              )
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            return;
          }
          const reader = upstream.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value !== undefined) controller.enqueue(value);
          }
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: { content: `fusion error: ${error instanceof Error ? error.message : String(error)}` },
                    finish_reason: "stop"
                  }
                ]
              })}\n\n`
            )
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          alive = false;
          clearInterval(keepalive);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    });
    return new Response(readable, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }

  models(): Promise<Response> {
    const model = this.defaultModel ?? "fusion-panel";
    return Promise.resolve(
      new Response(
        JSON.stringify({ object: "list", data: [{ id: model, object: "model", owned_by: "fusion-gateway" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
  }

  embeddings(): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify({ error: { message: "embeddings are not supported by the fusion gateway" } }), {
        status: 501,
        headers: { "content-type": "application/json" }
      })
    );
  }

  /** A stable key for the conversation: system text + first user message. */
  #sessionKey(messages: ChatMessageLike[]): string {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => textOfContent(message.content))
      .join("\n");
    const firstUser = messages.find((message) => message.role === "user");
    const seed = JSON.stringify([system, firstUser ? textOfContent(firstUser.content) : ""]);
    return createHash("sha256").update(seed).digest("hex").slice(0, 16);
  }

  #task(messages: ChatMessageLike[]): string {
    // The panel task is the user's request. Real CLIs (codex/claude/cursor) put
    // their large agent harness prompt in the system message (noise for the
    // panel) and may prepend an <environment_context> user message before the
    // real instruction — so join all user-turn text (which on the first turn is
    // the context + the task) and fall back to system only if there is none.
    const userText = messages
      .filter((message) => message.role === "user")
      .map((message) => textOfContent(message.content).trim())
      .filter((text) => text.length > 0)
      .join("\n\n")
      .trim();
    if (userText.length > 0) return userText;
    return messages
      .filter((message) => message.role === "system")
      .map((message) => textOfContent(message.content))
      .join("\n\n")
      .trim();
  }

  #ensureSession(sessionKey: string, messages: ChatMessageLike[]): Session {
    const now = Date.now();
    const existing = this.#sessions.get(sessionKey);
    if (existing !== undefined && now - existing.createdAt < this.#ttlMs) return existing;

    const traceId = this.#mintTraceId();
    const task = this.#task(messages);
    const session: Session = {
      traceId,
      createdAt: now,
      candidates: this.#runPanels({ task, messages, traceId, sessionKey }).catch(() => [])
    };
    this.#sessions.set(sessionKey, session);
    return session;
  }
}
