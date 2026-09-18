import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/bridge/rate-limiter.js";
import { SessionManager } from "../src/bridge/session-manager.js";
import { Store } from "../src/whatsapp/store.js";

describe("RateLimiter", () => {
  it("allows first, blocks within window, allows after", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(5, () => now);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    expect(rl.retryAfterMs("a")).toBeGreaterThan(0);
    now += 5001;
    expect(rl.allow("a")).toBe(true);
  });

  it("is per-sender", () => {
    const rl = new RateLimiter(60);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("b")).toBe(true);
  });

  it("zero disables", () => {
    const rl = new RateLimiter(0);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
  });
});

describe("SessionManager", () => {
  it("creates, touches, expires, resets, compacts", () => {
    vi.useRealTimers();
    let now = Date.now();
    const store = new Store(":memory:");
    const sm = new SessionManager(store, 6, 3, () => now);

    expect(sm.get("j")).toBeNull();
    sm.create("j", "sess-1");
    expect(sm.get("j")?.opencodeSessionId).toBe("sess-1");

    sm.touch("j", 2);
    expect(sm.get("j")?.messageCount).toBe(2);
    expect(sm.needsCompaction("j")).toBe(false);
    sm.touch("j", 1);
    expect(sm.needsCompaction("j")).toBe(true);

    sm.reset("j");
    expect(sm.get("j")).toBeNull();

    // TTL expiry
    sm.create("j", "sess-2");
    now += 7 * 3600_000;
    expect(sm.get("j")).toBeNull();
    store.close();
  });
});
