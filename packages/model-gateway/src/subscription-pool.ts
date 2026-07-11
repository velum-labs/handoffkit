import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import type { SubscriptionMode } from "@fusionkit/registry";

import { isFailoverWorthy } from "./fusion-failover.js";
import { subscriptionCredentialLabel } from "./subscription-credentials.js";
import type { SubscriptionProvider } from "./subscription-provider.js";
import type {
  AccountLimits,
  SubscriptionCredential,
  SubscriptionMemberStatus,
  SubscriptionPoolSnapshot,
  SubscriptionPoolStrategy
} from "./subscription-types.js";

export type SubscriptionPoolOptions = {
  mode: SubscriptionMode;
  directory: string;
  strategy?: SubscriptionPoolStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
  refreshSkewSeconds?: number;
  fallbackCooldownSeconds?: number;
};

type PersistedMemberState = {
  limits?: AccountLimits;
  coolingUntil?: number;
};

type PersistedTrackerFile = {
  members: Array<{ id: string; limits?: AccountLimits; coolingUntil?: number }>;
};

type PoolMember = {
  id: string;
  label: string;
  sourcePath: string;
  credential: SubscriptionCredential;
  coolingUntil?: number;
  lastUsed: number;
  inFlight: number;
  switchedAt: number;
};

const DEFAULT_SWITCH_THRESHOLD = 0.9;
const DEFAULT_REFRESH_SKEW_SECONDS = 300;
const DEFAULT_FALLBACK_COOLDOWN_SECONDS = 300;
const RAMP_WINDOW_MS = 30_000;
const RAMP_STEP_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function atomicWrite(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function parsedRateLimitWindow(value: unknown): AccountLimits["windows"][string] | undefined {
  if (!isRecord(value) || typeof value.utilization !== "number") return undefined;
  return {
    utilization: value.utilization,
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.resetsAt === "number" ? { resetsAt: value.resetsAt } : {}),
    ...(typeof value.windowSeconds === "number" ? { windowSeconds: value.windowSeconds } : {}),
    ...(typeof value.limitName === "string" ? { limitName: value.limitName } : {})
  };
}

function parsedAccountLimits(value: unknown): AccountLimits | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value.windows) ||
    typeof value.observedAt !== "number" ||
    (value.source !== "headers" && value.source !== "usage" && value.source !== "stream")
  ) {
    return undefined;
  }
  const windows = Object.create(null) as AccountLimits["windows"];
  for (const [key, raw] of Object.entries(value.windows)) {
    const window = parsedRateLimitWindow(raw);
    if (window !== undefined) Object.defineProperty(windows, key, {
      value: window,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return {
    windows,
    observedAt: value.observedAt,
    source: value.source,
    ...(typeof value.planType === "string" ? { planType: value.planType } : {}),
    ...(isRecord(value.credits) ? { credits: value.credits } : {})
  };
}

function parsedMemberState(value: unknown): PersistedMemberState | undefined {
  if (!isRecord(value)) return undefined;
  const limits = parsedAccountLimits(value.limits);
  const coolingUntil =
    typeof value.coolingUntil === "number" && Number.isFinite(value.coolingUntil)
      ? value.coolingUntil
      : undefined;
  if (limits === undefined && coolingUntil === undefined) return {};
  return {
    ...(limits !== undefined ? { limits } : {}),
    ...(coolingUntil !== undefined ? { coolingUntil } : {})
  };
}

function readTrackerState(path: string): Map<string, PersistedMemberState> {
  const state = new Map<string, PersistedMemberState>();
  if (!existsSync(path)) return state;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return state;
    if (Array.isArray(parsed.members)) {
      for (const entry of parsed.members) {
        if (!isRecord(entry) || typeof entry.id !== "string") continue;
        const member = parsedMemberState(entry);
        if (member !== undefined) state.set(entry.id, member);
      }
      return state;
    }
    // One-time migration from the original object-keyed state format.
    if (isRecord(parsed.members)) {
      for (const [id, raw] of Object.entries(parsed.members)) {
        const member = parsedMemberState(raw);
        if (member !== undefined) state.set(id, member);
      }
    }
    return state;
  } catch {
    return state;
  }
}

function mergeLimits(previous: AccountLimits | undefined, next: AccountLimits): AccountLimits {
  const windows = Object.create(null) as AccountLimits["windows"];
  for (const source of [previous?.windows, next.windows]) {
    if (source === undefined) continue;
    for (const [key, window] of Object.entries(source)) {
      Object.defineProperty(windows, key, {
        value: window,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
  }
  return {
    ...previous,
    ...next,
    windows,
    observedAt: next.observedAt,
    source: next.source
  };
}

export class RateLimitTracker {
  readonly #statePath: string;
  readonly #state: Map<string, PersistedMemberState>;

  constructor(statePath: string) {
    this.#statePath = statePath;
    this.#state = readTrackerState(statePath);
  }

  limits(memberId: string): AccountLimits | undefined {
    return this.#state.get(memberId)?.limits;
  }

  coolingUntil(memberId: string): number | undefined {
    return this.#state.get(memberId)?.coolingUntil;
  }

  update(memberId: string, limits: AccountLimits): void {
    const member = this.#state.get(memberId) ?? {};
    member.limits = mergeLimits(member.limits, limits);
    this.#state.set(memberId, member);
    this.#persist();
  }

  cool(memberId: string, until: number): void {
    const member = this.#state.get(memberId) ?? {};
    member.coolingUntil = until;
    this.#state.set(memberId, member);
    this.#persist();
  }

  clearCooling(memberId: string): void {
    const member = this.#state.get(memberId);
    if (member === undefined || member.coolingUntil === undefined) return;
    delete member.coolingUntil;
    this.#persist();
  }

  resetAfterRefresh(memberId: string): void {
    const member = this.#state.get(memberId) ?? {};
    delete member.limits;
    delete member.coolingUntil;
    this.#state.set(memberId, member);
    this.#persist();
  }

  #persist(): void {
    const file: PersistedTrackerFile = {
      members: [...this.#state].map(([id, member]) => ({ id, ...member }))
    };
    atomicWrite(this.#statePath, file);
  }
}

export class SubscriptionPoolExhaustedError extends Error {
  readonly resetAt: number | undefined;

  constructor(mode: SubscriptionMode, resetAt?: number) {
    super(
      resetAt === undefined
        ? `all ${mode} subscription pool members are unavailable`
        : `all ${mode} subscription pool members are unavailable until ${new Date(resetAt * 1000).toISOString()}`
    );
    this.resetAt = resetAt;
  }
}

export class SubscriptionPool {
  readonly #provider: SubscriptionProvider;
  readonly #options: Required<
    Pick<
      SubscriptionPoolOptions,
      "strategy" | "switchThreshold" | "refreshSkewSeconds" | "fallbackCooldownSeconds"
    >
  > & SubscriptionPoolOptions;
  readonly #members: PoolMember[];
  readonly #tracker: RateLimitTracker;
  readonly #refreshes = new Map<string, Promise<void>>();
  #activeId: string | undefined;
  #roundRobin = 0;
  #probeTimer: NodeJS.Timeout | undefined;

  private constructor(
    provider: SubscriptionProvider,
    options: SubscriptionPoolOptions,
    members: PoolMember[],
    tracker: RateLimitTracker
  ) {
    this.#provider = provider;
    this.#options = {
      ...options,
      strategy: options.strategy ?? "sticky",
      switchThreshold: options.switchThreshold ?? DEFAULT_SWITCH_THRESHOLD,
      refreshSkewSeconds: options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS,
      fallbackCooldownSeconds:
        options.fallbackCooldownSeconds ?? DEFAULT_FALLBACK_COOLDOWN_SECONDS
    };
    this.#members = members;
    this.#tracker = tracker;
  }

  static async open(
    provider: SubscriptionProvider,
    options: SubscriptionPoolOptions
  ): Promise<SubscriptionPool> {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const tracker = new RateLimitTracker(join(options.directory, ".state.json"));
    const files = readdirSync(options.directory)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
    const members: PoolMember[] = [];
    for (const name of files) {
      const sourcePath = join(options.directory, name);
      try {
        const credential = await provider.loadCredential(sourcePath);
        const id = subscriptionCredentialLabel(sourcePath);
        members.push({
          id,
          label: id,
          sourcePath,
          credential,
          ...(tracker.coolingUntil(id) !== undefined
            ? { coolingUntil: tracker.coolingUntil(id) }
            : {}),
          lastUsed: 0,
          inFlight: 0,
          switchedAt: 0
        });
      } catch {
        // A broken member remains visible on disk for `proxy status`, but is
        // excluded from serving until the operator re-enrolls it.
      }
    }
    const pool = new SubscriptionPool(provider, options, members, tracker);
    pool.#startProbe();
    return pool;
  }

  get mode(): SubscriptionMode {
    return this.#provider.mode;
  }

  get size(): number {
    return this.#members.length;
  }

  snapshot(): SubscriptionPoolSnapshot {
    return {
      mode: this.mode,
      strategy: this.#options.strategy,
      switchThreshold: this.#options.switchThreshold,
      members: this.#members.map((member) => this.#memberStatus(member))
    };
  }

  async close(): Promise<void> {
    if (this.#probeTimer !== undefined) clearInterval(this.#probeTimer);
    await Promise.allSettled(this.#refreshes.values());
  }

  async probe(): Promise<void> {
    await Promise.allSettled(
      this.#members.map(async (member) => {
        await this.#ensureFresh(member);
        const limits = await this.#provider.fetchUsage(member.credential);
        this.#tracker.update(member.id, limits);
      })
    );
  }

  async execute(
    model: string | undefined,
    operation: (credential: SubscriptionCredential) => Promise<Response>
  ): Promise<Response> {
    if (this.#members.length === 0) throw new SubscriptionPoolExhaustedError(this.mode);
    const excluded = new Set<string>();
    const absorbed = new Set<string>();
    let lastResponse: Response | undefined;

    while (excluded.size < this.#members.length) {
      const member = await this.#acquire(model, excluded);
      try {
        const response = await operation(member.credential);
        const headerLimits = this.#provider.parseLimits(response.headers);
        if (headerLimits !== undefined) this.#tracker.update(member.id, headerLimits);
        if (response.ok) return this.#observeStream(member, response);

        const text = await response.text();
        const parsed = this.#parseJson(text);
        const bodyLimits = this.#provider.parseLimits(response.headers, parsed);
        if (bodyLimits !== undefined) this.#tracker.update(member.id, bodyLimits);
        const failure = this.#provider.classify(response.status, response.headers, parsed);
        lastResponse = new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
        if (failure === undefined || !isFailoverWorthy(failure.category)) return lastResponse;

        if (failure.category === "transient") {
          if (!absorbed.has(member.id)) {
            absorbed.add(member.id);
            const delaySeconds = Math.min(60, failure.retryAfter ?? 0.5);
            await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
            continue;
          }
          // A short provider throttle is account-local and often prompt-cache
          // sensitive. Do not march the same burst through the whole pool.
          return lastResponse;
        }

        // Only an actual spent quota window rotates accounts. Authentication,
        // context, and unknown failures were already returned above.
        const until =
          failure.resetsAt ??
          Date.now() / 1000 +
            (failure.retryAfter ?? this.#options.fallbackCooldownSeconds);
        this.#penalize(member, until);
        excluded.add(member.id);
      } finally {
        this.#release(member);
      }
    }

    if (lastResponse !== undefined) return lastResponse;
    throw new SubscriptionPoolExhaustedError(this.mode, this.#soonestReset(model));
  }

  #memberStatus(member: PoolMember): SubscriptionMemberStatus {
    return {
      id: member.id,
      mode: this.mode,
      label: member.label,
      sourcePath: member.sourcePath,
      ...(member.credential.expiresAt !== undefined
        ? { expiresAt: member.credential.expiresAt }
        : {}),
      ...(member.coolingUntil !== undefined ? { coolingUntil: member.coolingUntil } : {}),
      active: member.id === this.#activeId,
      ...(this.#tracker.limits(member.id) !== undefined
        ? { limits: this.#tracker.limits(member.id) }
        : {})
    };
  }

  async #acquire(model: string | undefined, excluded: Set<string>): Promise<PoolMember> {
    const now = Date.now() / 1000;
    for (const member of this.#members) {
      if (member.coolingUntil !== undefined && member.coolingUntil <= now) {
        delete member.coolingUntil;
        this.#tracker.clearCooling(member.id);
      }
    }
    const eligible = this.#members.filter(
      (member) => !excluded.has(member.id) && this.#eligible(member, model, now)
    );
    if (eligible.length === 0) throw new SubscriptionPoolExhaustedError(this.mode, this.#soonestReset(model));
    const member = this.#select(eligible, model);
    await this.#ensureFresh(member);
    if (this.#activeId !== member.id) {
      this.#activeId = member.id;
      member.switchedAt = Date.now();
    }
    await this.#waitForRamp(member);
    member.inFlight += 1;
    member.lastUsed = Date.now();
    return member;
  }

  #release(member: PoolMember): void {
    member.inFlight = Math.max(0, member.inFlight - 1);
  }

  #eligible(member: PoolMember, model: string | undefined, now: number): boolean {
    if (member.coolingUntil !== undefined && member.coolingUntil > now) return false;
    if (
      member.credential.expiresAt !== undefined &&
      member.credential.expiresAt <= now &&
      member.credential.refreshToken === undefined
    ) {
      return false;
    }
    return this.#headroom(member, model) > 1 - this.#options.switchThreshold;
  }

  #select(eligible: PoolMember[], model: string | undefined): PoolMember {
    switch (this.#options.strategy) {
      case "sticky": {
        const active = eligible.find((member) => member.id === this.#activeId);
        return active ?? eligible[0]!;
      }
      case "round_robin": {
        const member = eligible[this.#roundRobin % eligible.length]!;
        this.#roundRobin += 1;
        return member;
      }
      case "capacity_weighted":
        return [...eligible].sort(
          (left, right) => this.#headroom(right, model) - this.#headroom(left, model)
        )[0]!;
      default: {
        const unreachable: never = this.#options.strategy;
        throw new Error(`unhandled subscription pool strategy: ${String(unreachable)}`);
      }
    }
  }

  #headroom(member: PoolMember, model: string | undefined): number {
    const limits = this.#tracker.limits(member.id);
    if (limits === undefined) return 1;
    const relevant = Object.entries(limits.windows).filter(([key, window]) =>
      this.#windowRelevant(key, window.limitName, model)
    );
    if (relevant.length === 0) return 1;
    return Math.min(...relevant.map(([, window]) => 1 - window.utilization));
  }

  #windowRelevant(key: string, limitName: string | undefined, model: string | undefined): boolean {
    const lowered = (model ?? "").toLowerCase();
    const descriptor = `${key} ${limitName ?? ""}`.toLowerCase();
    for (const family of ["sonnet", "opus", "haiku", "spark"]) {
      if (descriptor.includes(family)) return lowered.includes(family);
    }
    return true;
  }

  #soonestReset(model: string | undefined): number | undefined {
    const now = Date.now() / 1000;
    const resets: number[] = [];
    for (const member of this.#members) {
      if (member.coolingUntil !== undefined && member.coolingUntil > now) {
        resets.push(member.coolingUntil);
      }
      const limits = this.#tracker.limits(member.id);
      if (limits === undefined) continue;
      for (const [key, window] of Object.entries(limits.windows)) {
        if (
          window.resetsAt !== undefined &&
          window.resetsAt > now &&
          this.#windowRelevant(key, window.limitName, model)
        ) {
          resets.push(window.resetsAt);
        }
      }
    }
    return resets.length > 0 ? Math.min(...resets) : undefined;
  }

  #penalize(member: PoolMember, until: number): void {
    member.coolingUntil = until;
    this.#tracker.cool(member.id, until);
    if (this.#activeId === member.id) this.#activeId = undefined;
  }

  async #ensureFresh(member: PoolMember): Promise<void> {
    const expiresAt = member.credential.expiresAt;
    if (
      expiresAt === undefined ||
      expiresAt - Date.now() / 1000 > this.#options.refreshSkewSeconds
    ) {
      return;
    }
    const existing = this.#refreshes.get(member.id);
    if (existing !== undefined) return existing;
    const refresh = (async () => {
      member.credential = await this.#provider.refresh(member.credential);
      this.#tracker.resetAfterRefresh(member.id);
      delete member.coolingUntil;
    })().finally(() => this.#refreshes.delete(member.id));
    this.#refreshes.set(member.id, refresh);
    return refresh;
  }

  async #waitForRamp(member: PoolMember): Promise<void> {
    for (;;) {
      const elapsed = Date.now() - member.switchedAt;
      if (elapsed >= RAMP_WINDOW_MS) return;
      const cap = 1 + Math.floor(elapsed / RAMP_STEP_MS);
      if (member.inFlight < cap) return;
      await new Promise((resolve) => setTimeout(resolve, RAMP_STEP_MS));
    }
  }

  #observeStream(member: PoolMember, response: Response): Response {
    if (response.body === null || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    const decoder = new TextDecoder();
    let pending = "";
    const tracker = this.#tracker;
    const provider = this.#provider;
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        pending += decoder.decode(chunk, { stream: true });
        let boundary = pending.indexOf("\n\n");
        while (boundary !== -1) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (raw.length === 0 || raw === "[DONE]") continue;
            try {
              const limits = provider.parseStreamEvent(JSON.parse(raw));
              if (limits !== undefined) tracker.update(member.id, limits);
            } catch {
              // Provider streams contain non-JSON heartbeat events.
            }
          }
          boundary = pending.indexOf("\n\n");
        }
        if (pending.length > 1024 * 1024) pending = pending.slice(-64 * 1024);
      }
    });
    return new Response(response.body.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  #parseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }

  #startProbe(): void {
    const interval = this.#options.probeIntervalMs ?? 0;
    if (interval <= 0) return;
    this.#probeTimer = setInterval(() => {
      void this.probe();
    }, Math.max(60_000, interval));
    this.#probeTimer.unref();
    void this.probe();
  }
}
