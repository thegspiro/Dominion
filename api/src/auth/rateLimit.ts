interface Entry {
  count: number;
  resetAt: number;
}

const MAX_ENTRIES = 10_000;

/**
 * In-memory fixed-window failure counter. State is per process and is lost on
 * restart, which is acceptable for a single API container.
 */
export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the key may try again, or 0 when it is not blocked. */
  retryAfterSeconds(key: string): number {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= this.now() || entry.count < this.limit) {
      return 0;
    }
    return Math.max(1, Math.ceil((entry.resetAt - this.now()) / 1000));
  }

  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.entries.size >= MAX_ENTRIES) {
        this.prune(now);
      }
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
    if (this.entries.size >= MAX_ENTRIES) {
      this.entries.clear();
    }
  }
}
