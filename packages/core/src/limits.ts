/**
 * Fixed-window counters keyed by an arbitrary string ("acct:ada", "ip:1.2.3.4").
 * In-memory: good for one relayer process. Swap for Redis if we run several.
 */
export interface LimitRule {
  max: number;
  windowMs: number;
}

export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Records a hit and returns true if it is within `rule`. */
  take(key: string, rule: LimitRule): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= rule.windowMs) {
      this.hits.set(key, { start: t, count: 1 });
      return true;
    }
    if (h.count >= rule.max) return false;
    h.count++;
    return true;
  }

  /** Check without recording. */
  peek(key: string, rule: LimitRule): boolean {
    const h = this.hits.get(key);
    return !h || this.now() - h.start >= rule.windowMs || h.count < rule.max;
  }
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const DEFAULT_LIMITS = {
  relayPerAccount: { max: 60, windowMs: HOUR },
  relayPerIp: { max: 120, windowMs: HOUR },
  namesPerIp: { max: 3, windowMs: DAY },
} satisfies Record<string, LimitRule>;
