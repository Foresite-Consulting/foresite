/**
 * Token-bucket rate limiting.
 *
 * `RateLimiter` is the interface the ingest handler uses. `MemoryTokenBucket`
 * keeps buckets in this process only. On Vercel each function instance has its
 * own memory and instances come and go, so in production the effective limit
 * is "per device per instance". A shared store is needed for a hard limit;
 * which one (e.g. Upstash Redis via the Vercel Marketplace, or a Postgres
 * table) is UNVERIFIED and is a decision for Lachlan (see ADR 0003).
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until one token is available; 0 when allowed. */
  retryAfterSeconds: number;
  /** Tokens left after this request. */
  remaining: number;
}

export interface RateLimiter {
  /** Spend one token if there is one. */
  take(key: string): Promise<RateLimitDecision>;
  /** Whether a token is available, without spending it. */
  check(key: string): Promise<RateLimitDecision>;
}

export interface TokenBucketOptions {
  /** Maximum burst. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Buckets kept before the least recently used is dropped. Bounds memory. */
  maxKeys?: number;
  /** Injectable clock (milliseconds) for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class MemoryTokenBucket implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1) || !(options.refillPerSecond > 0)) {
      throw new RangeError('capacity must be >= 1 and refillPerSecond > 0');
    }
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerSecond / 1000;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  private current(key: string, now: number): number {
    const existing = this.buckets.get(key);
    if (existing === undefined) return this.capacity;
    const elapsed = Math.max(0, now - existing.updatedAt);
    return Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs);
  }

  private decision(tokens: number, allowed: boolean): RateLimitDecision {
    if (allowed) return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(tokens) };
    const waitMs = (1 - tokens) / this.refillPerMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      remaining: 0,
    };
  }

  check(key: string): Promise<RateLimitDecision> {
    const tokens = this.current(key, this.now());
    return Promise.resolve(this.decision(tokens, tokens >= 1));
  }

  take(key: string): Promise<RateLimitDecision> {
    const now = this.now();
    let tokens = this.current(key, now);
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    // Re-insert so Map order tracks recency (oldest first).
    this.buckets.delete(key);
    this.buckets.set(key, { tokens, updatedAt: now });
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return Promise.resolve(this.decision(tokens, allowed));
  }
}
