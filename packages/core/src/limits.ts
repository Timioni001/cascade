/**
 * Rate limits: fixed-window counters keyed by an arbitrary string
 * ("acct:ada", "ip:1.2.3.4"). `RateLimiter` keeps them in memory (one
 * process); `@cascade/db`'s `StoreLimiter` keeps them in the database, which
 * is what a serverless deployment (many short-lived isolates) needs.
 */
export interface LimitRule {
  max: number;
  windowMs: number;
}

export interface Limiter {
  /** Records a hit and resolves true if it is within `rule`. */
  take(key: string, rule: LimitRule): Promise<boolean>;
  /** Checks without recording. */
  peek(key: string, rule: LimitRule): Promise<boolean>;
}

export class RateLimiter implements Limiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async take(key: string, rule: LimitRule): Promise<boolean> {
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

  async peek(key: string, rule: LimitRule): Promise<boolean> {
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
