import type { LimitRule, Limiter } from "@cascade/core";
import type { Store } from "./records.js";

/** Rate limits kept in the database, shared by every process or isolate. */
export class StoreLimiter implements Limiter {
  constructor(private readonly store: Store, private readonly now: () => number = Date.now) {}

  async take(key: string, rule: LimitRule): Promise<boolean> {
    return (await this.store.hit(`rl:${key}`, rule.windowMs, this.now())) <= rule.max;
  }

  async peek(key: string, rule: LimitRule): Promise<boolean> {
    return (await this.store.hit(`rl:${key}`, rule.windowMs, this.now(), 0)) < rule.max;
  }
}
