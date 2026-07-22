export type CapacityPoolStrategy = "sticky" | "round_robin" | "capacity_weighted";

export type CapacityPoolMember<T> = {
  id: string;
  value: T;
  capacity?: number;
  healthy?: boolean;
  coolingUntil?: number;
  quotaUtilization?: number;
};

type MutablePoolMember<T> = CapacityPoolMember<T> & {
  inFlight: number;
  lastUsed: number;
};

export type CapacityLease<T> = {
  readonly id: string;
  readonly value: T;
  release(): void;
};

export type CapacityPoolOptions = {
  strategy?: CapacityPoolStrategy;
  now?: () => number;
};

/**
 * Generic health-, quota-, and cooldown-aware selector. Values are opaque, so
 * the same policy can balance HTTP endpoint instances and provider accounts.
 */
export class CapacityPool<T> {
  readonly #members: MutablePoolMember<T>[];
  readonly #strategy: CapacityPoolStrategy;
  readonly #now: () => number;
  readonly #sticky = new Map<string, string>();
  #roundRobin = 0;

  constructor(members: readonly CapacityPoolMember<T>[], options: CapacityPoolOptions = {}) {
    if (members.length === 0) throw new Error("capacity pool requires at least one member");
    const ids = new Set<string>();
    this.#members = members.map((member) => {
      if (ids.has(member.id)) throw new Error(`duplicate capacity pool member: ${member.id}`);
      ids.add(member.id);
      return { ...member, inFlight: 0, lastUsed: 0 };
    });
    this.#strategy = options.strategy ?? "capacity_weighted";
    this.#now = options.now ?? Date.now;
  }

  list(): readonly CapacityPoolMember<T>[] {
    return this.#members.map(({ inFlight: _inFlight, lastUsed: _lastUsed, ...member }) => member);
  }

  acquire(stickyKey = "default", excluded: ReadonlySet<string> = new Set()): CapacityLease<T> {
    const now = this.#now();
    const eligible = this.#members.filter(
      (member) =>
        !excluded.has(member.id) &&
        member.healthy !== false &&
        (member.coolingUntil === undefined || member.coolingUntil <= now) &&
        (member.quotaUtilization === undefined || member.quotaUtilization < 1)
    );
    if (eligible.length === 0) throw new Error("capacity pool is exhausted");
    const selected = this.#select(eligible, stickyKey);
    selected.inFlight += 1;
    selected.lastUsed = now;
    this.#sticky.set(stickyKey, selected.id);
    let released = false;
    return {
      id: selected.id,
      value: selected.value,
      release: () => {
        if (released) return;
        released = true;
        selected.inFlight = Math.max(0, selected.inFlight - 1);
      }
    };
  }

  update(id: string, state: Partial<Omit<CapacityPoolMember<T>, "id" | "value">>): void {
    const member = this.#member(id);
    Object.assign(member, state);
    if (state.healthy === false) {
      for (const [key, stickyId] of this.#sticky) {
        if (stickyId === id) this.#sticky.delete(key);
      }
    }
  }

  markHealthy(id: string): void {
    this.update(id, { healthy: true, coolingUntil: undefined });
  }

  markFailure(id: string, cooldownMs: number): void {
    this.update(id, {
      coolingUntil: this.#now() + Math.max(0, cooldownMs)
    });
  }

  #member(id: string): MutablePoolMember<T> {
    const member = this.#members.find((candidate) => candidate.id === id);
    if (member === undefined) throw new Error(`unknown capacity pool member: ${id}`);
    return member;
  }

  #select(eligible: MutablePoolMember<T>[], stickyKey: string): MutablePoolMember<T> {
    switch (this.#strategy) {
      case "sticky": {
        const stickyId = this.#sticky.get(stickyKey);
        return eligible.find((member) => member.id === stickyId) ?? eligible[0]!;
      }
      case "round_robin": {
        const selected = eligible[this.#roundRobin % eligible.length]!;
        this.#roundRobin += 1;
        return selected;
      }
      case "capacity_weighted":
        return [...eligible].sort((left, right) => this.#score(right) - this.#score(left))[0]!;
      default: {
        const unreachable: never = this.#strategy;
        throw new Error(`unhandled capacity pool strategy: ${String(unreachable)}`);
      }
    }
  }

  #score(member: MutablePoolMember<T>): number {
    const capacity = Math.max(1, member.capacity ?? 1);
    const quotaHeadroom = 1 - (member.quotaUtilization ?? 0);
    return (capacity * quotaHeadroom) / (member.inFlight + 1);
  }
}
