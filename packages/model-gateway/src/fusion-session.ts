import { createHash } from "node:crypto";

import { isFiniteK } from "@fusionkit/protocol";
import type { WireTrajectory } from "@fusionkit/protocol";
import { randomId } from "@fusionkit/runtime-utils";
import { newSpanId, sessionCarrier } from "@fusionkit/tracing";

import type { SessionCost } from "./cost.js";
import type { FusionGatewayLogger } from "./logger.js";
import type { PersistedSession, SessionStore } from "./session-store.js";
import type {
  ChatMessageLike,
  FusionBackendKernelSessionState,
  FusionBackendKernelStateStore,
  PanelRunner,
  SessionMetaInput
} from "./fusion-types.js";

export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_PANEL_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tracks in-flight store writes so shutdown can await them (WS10). Session
 * persistence is deliberately detached from the request path (a slow disk
 * must not stall a turn), but detached writes used to be silently dropped on
 * process exit — turns and cost entries vanished. Writers register every
 * store promise here; the gateway registers `flush()` with the cleanup
 * registry so exit waits for the tail.
 */
export class PendingSessionWrites {
  readonly #pending = new Set<Promise<unknown>>();

  /** Track a write; the caller keeps ownership of error handling. */
  track(work: Promise<unknown>): void {
    const tracked = work.catch(() => {}).finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  /** Resolve once every write in flight at call time (and any queued behind it) settles. */
  async flush(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }
}

export class InMemoryFusionBackendKernelStateStore implements FusionBackendKernelStateStore {
  readonly #sessions = new Map<string, FusionBackendKernelSessionState>();
  readonly #cost = new Map<string, SessionCost>();

  get(sessionKey: string): FusionBackendKernelSessionState | undefined {
    return this.#sessions.get(sessionKey);
  }

  set(sessionKey: string, state: FusionBackendKernelSessionState): void {
    this.#sessions.set(sessionKey, state);
  }

  delete(sessionKey: string): void {
    this.#sessions.delete(sessionKey);
  }

  entries(): IterableIterator<[string, FusionBackendKernelSessionState]> {
    return this.#sessions.entries();
  }

  getCost(sessionKey: string): SessionCost | undefined {
    return this.#cost.get(sessionKey);
  }

  setCost(sessionKey: string, cost: SessionCost): void {
    this.#cost.set(sessionKey, cost);
  }
}

export function textOfContent(content: unknown): string {
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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isHarnessNotification(message: ChatMessageLike): boolean {
  if (message.role !== "user") return false;
  return textOfContent(message.content).trimStart().startsWith("<subagent_notification>");
}

export function hasUsableCandidates(candidates: readonly WireTrajectory[]): boolean {
  return candidates.some((candidate) => candidate.status !== "failed");
}

export type FusionSessionManagerOptions = {
  ttlMs: number;
  runPanels: PanelRunner;
  mintTraceId: () => string;
  kernelStateStore: FusionBackendKernelStateStore;
  store?: SessionStore;
  resumeId?: string;
  sessionMeta: SessionMetaInput;
  defaultModel?: string;
  logger: FusionGatewayLogger;
  /** Shared in-flight write tracker (one per gateway; awaited on shutdown). */
  pendingWrites?: PendingSessionWrites;
};

export class FusionSessionManager {
  readonly #ttlMs: number;
  readonly #runPanels: PanelRunner;
  readonly #mintTraceId: () => string;
  readonly #kernelStateStore: FusionBackendKernelStateStore;
  readonly #store: SessionStore | undefined;
  readonly #sessionMeta: SessionMetaInput;
  readonly #defaultModel: string | undefined;
  readonly #logger: FusionGatewayLogger;
  readonly #pendingWrites: PendingSessionWrites;
  #resumeId: string | undefined;
  /**
   * Fuse rounds per `${sessionKey}#${turn}` — narration bookkeeping only
   * (headlines prefix "Step N —" when a turn fuses more than once). Rounds
   * exist for every k: unbounded turns simply stay at 1. Pruned with sessions.
   */
  readonly #narrationRounds = new Map<string, number>();
  /** Live content-hint -> session-id resolutions (see {@link resolveSessionId}). */
  readonly #hintToId = new Map<string, string>();
  /** Reverse map so persisted headers carry their resume hint. */
  readonly #idToHint = new Map<string, string>();

  constructor(options: FusionSessionManagerOptions) {
    this.#ttlMs = options.ttlMs;
    this.#runPanels = options.runPanels;
    this.#mintTraceId = options.mintTraceId;
    this.#kernelStateStore = options.kernelStateStore;
    this.#store = options.store;
    this.#resumeId = options.resumeId;
    this.#sessionMeta = options.sessionMeta;
    this.#defaultModel = options.defaultModel;
    this.#logger = options.logger;
    this.#pendingWrites = options.pendingWrites ?? new PendingSessionWrites();
  }

  get store(): SessionStore | undefined {
    return this.#store;
  }

  /** Await every session/turn/cost write still in flight (shutdown path). */
  flush(): Promise<void> {
    return this.#pendingWrites.flush();
  }

  sessionKey(messages: readonly ChatMessageLike[], scope?: string): string {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => textOfContent(message.content))
      .join("\n");
    const firstUser = messages.find((message) => message.role === "user");
    const seed = JSON.stringify([
      system,
      firstUser ? textOfContent(firstUser.content) : "",
      ...(scope !== undefined ? [scope] : [])
    ]);
    return createHash("sha256").update(seed).digest("hex").slice(0, 16);
  }

  /**
   * Resolve the conversation to a real session id (WS10). The identity is a
   * random id; the content hash is only a *hint* for reattachment:
   *
   *  1. a hint this process already resolved keeps its id (turn N of a live
   *     conversation, client retries of the same request);
   *  2. a *continuing* conversation (it carries assistant turns) with no live
   *     resolution reattaches to the most recent persisted session sharing
   *     the hint — a restarted gateway resumes mid-conversation work;
   *  3. anything else — in particular a fresh opener, even one identical to a
   *     past conversation's — mints a new id, so two conversations with the
   *     same first message never share budget, cost, or candidate caches.
   */
  resolveSessionId(messages: readonly ChatMessageLike[], scope?: string): string {
    this.#sweepExpired(Date.now());
    const hint = this.sessionKey(messages, scope);
    const live = this.#hintToId.get(hint);
    if (live !== undefined) return live;

    const continuing = messages.some((message) => message.role === "assistant");
    if (continuing && this.#store !== undefined) {
      const persisted = this.#store
        .list()
        .find((summary) => summary.contentHint === hint);
      if (persisted !== undefined) {
        this.#remember(hint, persisted.id);
        return persisted.id;
      }
    }

    const id = randomId(16);
    this.#remember(hint, id);
    return id;
  }

  #remember(hint: string, id: string): void {
    this.#hintToId.set(hint, id);
    this.#idToHint.set(id, hint);
  }

  task(messages: readonly ChatMessageLike[]): string {
    const userText = messages
      .filter((message) => message.role === "user" && !isHarnessNotification(message))
      .map((message) => textOfContent(message.content).trim())
      .filter((text) => text.length > 0);
    const latest = userText.at(-1);
    if (latest !== undefined && latest.length > 0) return latest;
    return messages
      .filter((message) => message.role === "system")
      .map((message) => textOfContent(message.content))
      .join("\n\n")
      .trim();
  }

  ensureSession(sessionKey: string): FusionBackendKernelSessionState {
    const now = Date.now();
    this.#sweepExpired(now);
    const existing = this.#kernelStateStore.get(sessionKey);
    if (existing !== undefined && now - existing.createdAt < this.#ttlMs) return existing;

    if (this.#store !== undefined) {
      if (this.#resumeId !== undefined) {
        const resumeId = this.#resumeId;
        this.#resumeId = undefined;
        const persisted = this.#store.load(resumeId);
        if (persisted !== undefined) {
          const session = this.#hydrate(persisted, now);
          // The resumed conversation keeps the persisted session's identity:
          // remap the fresh conversation's content hint (resolved before we
          // knew about --resume) onto the persisted id so subsequent turns
          // and a future restart reattach to it.
          const hint = this.#idToHint.get(sessionKey);
          if (hint !== undefined) this.#remember(hint, session.id);
          this.#kernelStateStore.set(sessionKey, session);
          this.#kernelStateStore.set(session.id, session);
          return session;
        }
        this.#logger.error(`fusion: --resume target ${resumeId} not found; starting a fresh session.`);
      }
      const stored = this.#store.load(sessionKey);
      if (stored !== undefined) {
        const session = this.#hydrate(stored, now);
        this.#kernelStateStore.set(sessionKey, session);
        return session;
      }
    }

    const traceId = this.#mintTraceId();
    const sessionSpan = newSpanId();
    const session: FusionBackendKernelSessionState = {
      id: sessionKey,
      traceId,
      sessionSpan,
      trace: sessionCarrier(traceId, sessionSpan),
      turns: new Map(),
      turnAborts: new Map(),
      meteredPanelTurns: new Set(),
      createdAt: now
    };
    this.#kernelStateStore.set(sessionKey, session);
    this.#persistMeta(session);
    return session;
  }

  /** Increment and return the 1-based fuse round of this turn (narration only). */
  nextNarrationRound(sessionKey: string, turn: number): number {
    const key = `${sessionKey}#${turn}`;
    const round = (this.#narrationRounds.get(key) ?? 0) + 1;
    this.#narrationRounds.set(key, round);
    return round;
  }

  evictTurn(session: FusionBackendKernelSessionState, turn: number): void {
    session.turns.delete(turn);
  }

  evictTurnFor(sessionKey: string, turn: number): void {
    const session = this.#kernelStateStore.get(sessionKey);
    if (session !== undefined) this.evictTurn(session, turn);
  }

  ensureTurnCandidates(input: {
    session: FusionBackendKernelSessionState;
    sessionKey: string;
    turn: number;
    messages: ChatMessageLike[];
    ensembleModelId?: string;
    excludeModelIds?: readonly string[];
    panelDepth?: number;
    tools?: unknown;
    toolChoice?: unknown;
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    maxCompletionTokens?: number;
    seed?: number;
    reasoning?: Record<string, unknown>;
    provider?: Record<string, unknown>;
    usage?: Record<string, unknown>;
    parallelToolCalls?: boolean;
    k?: number;
    signal?: AbortSignal;
  }): { candidates: Promise<WireTrajectory[]>; abort: (reason?: unknown) => void } {
    // Rounds are memoryless for finite k: every request (including tool-result
    // continuations of the same user turn) re-runs the panel over the updated
    // messages, so candidates are per-round, never cached. Only unbounded
    // rollouts (k = ∞ / unset) keep the per-user-turn cache — those members
    // already rolled out to completion, so a re-fuse reuses their work.
    const cacheable = !isFiniteK(input.k);
    if (cacheable) {
      const existing = input.session.turns.get(input.turn);
      if (existing !== undefined) {
        const controller = input.session.turnAborts.get(input.turn);
        return {
          candidates: existing,
          abort: (reason?: unknown) => controller?.abort(reason)
        };
      }
    }

    const abort = new AbortController();
    input.session.turnAborts.set(input.turn, abort);
    const panelSignal =
      input.signal !== undefined
        ? AbortSignal.any([abort.signal, input.signal])
        : abort.signal;
    const candidates = this.#runPanels({
      task: this.task(input.messages),
      messages: input.messages,
      trace: input.session.trace,
      sessionKey: input.sessionKey,
      turn: input.turn,
      signal: panelSignal,
      ...(input.ensembleModelId !== undefined ? { ensembleModelId: input.ensembleModelId } : {}),
      ...(input.excludeModelIds !== undefined && input.excludeModelIds.length > 0
        ? { excludeModelIds: input.excludeModelIds }
        : {}),
      ...(input.panelDepth !== undefined && input.panelDepth > 0 ? { panelDepth: input.panelDepth } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.maxCompletionTokens !== undefined
        ? { maxCompletionTokens: input.maxCompletionTokens }
        : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.parallelToolCalls !== undefined
        ? { parallelToolCalls: input.parallelToolCalls }
        : {}),
      ...(input.k !== undefined ? { k: input.k } : {})
    });
    input.session.turns.set(input.turn, candidates);
    void candidates.then(
      (resolved) => {
        if (input.session.turnAborts.get(input.turn) === abort) input.session.turnAborts.delete(input.turn);
        if (hasUsableCandidates(resolved)) this.#persistTurn(input.session, input.turn, input.messages, resolved);
      },
      (error: unknown) => {
        if (input.session.turnAborts.get(input.turn) === abort) input.session.turnAborts.delete(input.turn);
        this.#logger.error(
          `fusion: panel run failed for session ${input.sessionKey} turn ${input.turn}: ${errorText(error)}`
        );
        if (input.session.turns.get(input.turn) === candidates) input.session.turns.delete(input.turn);
      }
    );
    return {
      candidates,
      abort: (reason?: unknown) => abort.abort(reason)
    };
  }

  #sweepExpired(now: number): void {
    const expiredIds = new Set<string>();
    for (const [key, session] of this.#kernelStateStore.entries()) {
      if (now - session.createdAt < this.#ttlMs) continue;
      this.#kernelStateStore.delete(key);
      expiredIds.add(key);
      expiredIds.add(session.id);
      for (const roundKey of this.#narrationRounds.keys()) {
        if (roundKey.startsWith(`${key}#`)) this.#narrationRounds.delete(roundKey);
      }
    }
    for (const id of expiredIds) {
      const hint = this.#idToHint.get(id);
      if (hint !== undefined && this.#hintToId.get(hint) === id) {
        this.#hintToId.delete(hint);
      }
      this.#idToHint.delete(id);
    }
  }

  #hydrate(persisted: PersistedSession, now: number): FusionBackendKernelSessionState {
    const turns = new Map<number, Promise<WireTrajectory[]>>();
    for (const record of persisted.turns) {
      turns.set(record.turn, Promise.resolve(record.candidates));
    }
    const meteredPanelTurns = new Set(
      persisted.costLedger
        .filter((entry) => entry.stage === "panel" && entry.turn !== undefined)
        .map((entry) => entry.turn as number)
    );
    // Sessions persisted before the OTel cutover carry non-W3C ids; re-mint
    // the trace identity for them (trace data is disposable, resume is not).
    const validIds = /^[0-9a-f]{32}$/.test(persisted.meta.traceId) && /^[0-9a-f]{16}$/.test(persisted.meta.sessionSpan);
    const traceId = validIds ? persisted.meta.traceId : this.#mintTraceId();
    const sessionSpan = validIds ? persisted.meta.sessionSpan : newSpanId();
    return {
      id: persisted.meta.id,
      traceId,
      sessionSpan,
      trace: sessionCarrier(traceId, sessionSpan),
      turns,
      turnAborts: new Map(),
      meteredPanelTurns,
      createdAt: now
    };
  }

  #persistMeta(session: FusionBackendKernelSessionState): void {
    if (this.#store === undefined) return;
    const hint = this.#idToHint.get(session.id);
    const now = Date.now();
    this.#pendingWrites.track(
      this.#store
        .saveMeta({
          id: session.id,
          ...(hint !== undefined ? { contentHint: hint } : {}),
          traceId: session.traceId,
          sessionSpan: session.sessionSpan,
          createdAt: session.createdAt,
          updatedAt: now,
          ...(this.#defaultModel !== undefined ? { defaultModel: this.#defaultModel } : {}),
          ...(this.#sessionMeta.tool !== undefined ? { tool: this.#sessionMeta.tool } : {}),
          ...(this.#sessionMeta.repo !== undefined ? { repo: this.#sessionMeta.repo } : {}),
          ...(this.#sessionMeta.models !== undefined ? { models: this.#sessionMeta.models } : {}),
          ...(this.#sessionMeta.judgeModel !== undefined ? { judgeModel: this.#sessionMeta.judgeModel } : {})
        })
        .catch((error: unknown) => {
          this.#logger.error(`fusion: could not persist session ${session.id}: ${errorText(error)}`);
        })
    );
  }

  #persistTurn(
    session: FusionBackendKernelSessionState,
    turn: number,
    messages: ChatMessageLike[],
    candidates: WireTrajectory[]
  ): void {
    if (this.#store === undefined) return;
    this.#pendingWrites.track(
      this.#store
        .appendTurn(session.id, { turn, messages, candidates, recordedAt: Date.now() })
        .catch((error: unknown) => {
          this.#logger.error(`fusion: could not persist turn ${turn} of session ${session.id}: ${errorText(error)}`);
        })
    );
  }
}
