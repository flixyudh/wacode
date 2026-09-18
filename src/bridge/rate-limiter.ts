/**
 * Per-sender token bucket (simplified): 1 call per `intervalSeconds`.
 * First message from a sender always passes.
 */
export class RateLimiter {
  private lastAllowed = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(intervalSeconds: number, now: () => number = Date.now) {
    this.intervalMs = Math.max(0, intervalSeconds) * 1000;
    this.now = now;
  }

  /** Returns true if the sender may proceed (and records the allowance). */
  allow(key: string): boolean {
    if (this.intervalMs === 0) return true;
    const now = this.now();
    const last = this.lastAllowed.get(key);
    if (last === undefined || now - last >= this.intervalMs) {
      this.lastAllowed.set(key, now);
      return true;
    }
    return false;
  }

  /** ms until the sender may proceed again (0 if allowed now). */
  retryAfterMs(key: string): number {
    if (this.intervalMs === 0) return 0;
    const last = this.lastAllowed.get(key);
    if (last === undefined) return 0;
    return Math.max(0, this.intervalMs - (this.now() - last));
  }

  reset(key: string): void {
    this.lastAllowed.delete(key);
  }
}
