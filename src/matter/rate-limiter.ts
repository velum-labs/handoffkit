import type { MatterRateCategory } from "./types.js";

export interface RateLimiterClock {
  now(): number;
}

export interface RateLimiterTimers {
  sleep(ms: number): Promise<void>;
}

export interface RateLimiterOptions {
  burstPerSecond?: number;
  readPerMinute?: number;
  searchPerMinute?: number;
  markdownPerMinute?: number;
  clock?: RateLimiterClock;
  timers?: RateLimiterTimers;
}

interface Budget {
  limit: number;
  windowMs: number;
  timestamps: number[];
}

export class MatterRateLimiter {
  private readonly clock: RateLimiterClock;
  private readonly timers: RateLimiterTimers;
  private readonly burst: Budget;
  private readonly read: Budget;
  private readonly search: Budget;
  private readonly markdown: Budget;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timers = options.timers ?? { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
    this.burst = { limit: options.burstPerSecond ?? 5, windowMs: 1_000, timestamps: [] };
    this.read = { limit: options.readPerMinute ?? 120, windowMs: 60_000, timestamps: [] };
    this.search = { limit: options.searchPerMinute ?? 30, windowMs: 60_000, timestamps: [] };
    this.markdown = { limit: options.markdownPerMinute ?? 20, windowMs: 60_000, timestamps: [] };
  }

  async acquire(category: MatterRateCategory): Promise<void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      await this.acquireNow(category);
    } finally {
      release();
    }
  }

  private budgetsFor(category: MatterRateCategory): Budget[] {
    if (category === "search") {
      return [this.burst, this.read, this.search];
    }
    if (category === "markdown") {
      return [this.burst, this.read, this.markdown];
    }
    return [this.burst, this.read];
  }

  private async acquireNow(category: MatterRateCategory): Promise<void> {
    const budgets = this.budgetsFor(category);

    while (true) {
      const now = this.clock.now();
      let waitMs = 0;

      for (const budget of budgets) {
        pruneBudget(budget, now);
        if (budget.timestamps.length >= budget.limit) {
          const oldest = budget.timestamps[0];
          waitMs = Math.max(waitMs, oldest + budget.windowMs - now);
        }
      }

      if (waitMs <= 0) {
        for (const budget of budgets) {
          budget.timestamps.push(now);
        }
        return;
      }

      await this.timers.sleep(waitMs);
    }
  }
}

function pruneBudget(budget: Budget, now: number): void {
  while (budget.timestamps.length > 0 && now - budget.timestamps[0] >= budget.windowMs) {
    budget.timestamps.shift();
  }
}
