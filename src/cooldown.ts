/**
 * Circuit breaker for rate-limited or failing models. When a provider
 * returns a retryable error, the model is "benched" for a cooldown period
 * and the failover chain skips it — so a busy agent loop doesn't pay the
 * failed-attempt latency on every single call while a provider is down.
 */
export class CooldownTracker {
  private until = new Map<string, number>();

  bench(key: string, seconds: number): void {
    this.until.set(key, Date.now() + seconds * 1000);
  }

  isBenched(key: string): boolean {
    const t = this.until.get(key);
    if (t === undefined) return false;
    if (Date.now() >= t) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  /** Currently benched models → seconds remaining. */
  active(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, t] of this.until) {
      const remaining = Math.ceil((t - Date.now()) / 1000);
      if (remaining > 0) out[key] = remaining;
    }
    return out;
  }
}
