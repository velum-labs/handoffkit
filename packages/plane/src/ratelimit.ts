/**
 * In-memory token-bucket rate limiter plus failed-auth backoff. Per-key
 * (principal id or client IP). In-memory is correct for a single-node
 * plane; a multi-node deployment would back this with the shared store,
 * which is why the limiter is injected rather than global.
 */

export type RateLimitConfig = {
  /** Sustained requests per second per key. */
  ratePerSec: number;
  /** Maximum burst (bucket capacity). */
  burst: number;
  /** Lock a key out for this long after too many auth failures. */
  authFailureWindowMs: number;
  /** Auth failures within the window before lockout. */
  authFailureLimit: number;
};

// TODO(hardcoded): default rate (50/s), burst (100), and auth lockout window/limit are fixed constants.
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  ratePerSec: 50,
  burst: 100,
  authFailureWindowMs: 60_000,
  authFailureLimit: 20
};

type Bucket = { tokens: number; updatedMs: number };
type FailureState = { count: number; windowStartMs: number; lockedUntilMs: number };

// TODO(lib): suggest rate-limiter-flexible — in-memory buckets do not survive restarts or share state across plane replicas.
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly failures = new Map<string, FailureState>();
  private readonly config: RateLimitConfig;
  private readonly now: () => number;

  constructor(config: Partial<RateLimitConfig> = {}, now: () => number = Date.now) {
    this.config = { ...DEFAULT_RATE_LIMIT, ...config };
    this.now = now;
  }

  /** Consume one token for `key`; returns false when the bucket is empty. */
  // TODO(brittle): stale bucket/failure entries are never evicted; long-lived processes accumulate unbounded Map keys.
  allow(key: string): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.config.burst,
      updatedMs: nowMs
    };
    const elapsedSec = (nowMs - bucket.updatedMs) / 1000;
    bucket.tokens = Math.min(
      this.config.burst,
      bucket.tokens + elapsedSec * this.config.ratePerSec
    );
    bucket.updatedMs = nowMs;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Is the key currently locked out for repeated auth failures? */
  isLockedOut(key: string): boolean {
    const state = this.failures.get(key);
    return state !== undefined && this.now() < state.lockedUntilMs;
  }

  recordAuthFailure(key: string): void {
    const nowMs = this.now();
    const state = this.failures.get(key) ?? {
      count: 0,
      windowStartMs: nowMs,
      lockedUntilMs: 0
    };
    if (nowMs - state.windowStartMs > this.config.authFailureWindowMs) {
      state.count = 0;
      state.windowStartMs = nowMs;
    }
    state.count += 1;
    if (state.count >= this.config.authFailureLimit) {
      state.lockedUntilMs = nowMs + this.config.authFailureWindowMs;
    }
    this.failures.set(key, state);
  }

  recordAuthSuccess(key: string): void {
    this.failures.delete(key);
  }
}
