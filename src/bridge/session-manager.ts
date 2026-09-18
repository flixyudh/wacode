import { randomUUID } from "node:crypto";
import type { Store } from "../whatsapp/store.js";

export interface BridgeSession {
  jid: string;
  opencodeSessionId: string;
  messageCount: number;
  lastActiveAtMs: number;
}

export function isResetCommand(text: string): boolean {
  return text.trim().split("\n")[0]?.trim() === "/reset";
}

export class SessionManager {
  constructor(
    private store: Store,
    private ttlHours: number,
    private compactAfter: number,
    private now: () => number = Date.now,
  ) {}

  private isExpired(lastActiveAtMs: number): boolean {
    return this.now() - lastActiveAtMs > this.ttlHours * 3600_000;
  }

  get(jid: string): BridgeSession | null {
    const rec = this.store.getSession(jid);
    if (!rec) return null;
    if (this.isExpired(rec.last_active_at_ms)) {
      this.store.deleteSession(jid);
      return null;
    }
    return {
      jid: rec.jid,
      opencodeSessionId: rec.opencode_session_id,
      messageCount: rec.message_count,
      lastActiveAtMs: rec.last_active_at_ms,
    };
  }

  /** Get existing session or return null if a new opencode session must be created. */
  needsNewSession(jid: string): boolean {
    return this.get(jid) === null;
  }

  create(jid: string, opencodeSessionId: string): BridgeSession {
    const s: BridgeSession = {
      jid,
      opencodeSessionId,
      messageCount: 0,
      lastActiveAtMs: this.now(),
    };
    this.store.upsertSession({
      jid,
      opencode_session_id: opencodeSessionId,
      last_active_at_ms: s.lastActiveAtMs,
      message_count: 0,
    });
    return s;
  }

  touch(jid: string, increment = 1): BridgeSession | null {
    const cur = this.get(jid);
    if (!cur) return null;
    const next: BridgeSession = {
      ...cur,
      messageCount: cur.messageCount + increment,
      lastActiveAtMs: this.now(),
    };
    this.store.upsertSession({
      jid,
      opencode_session_id: next.opencodeSessionId,
      last_active_at_ms: next.lastActiveAtMs,
      message_count: next.messageCount,
    });
    return next;
  }

  reset(jid: string): void {
    this.store.deleteSession(jid);
  }

  needsCompaction(jid: string): boolean {
    const cur = this.get(jid);
    return !!cur && cur.messageCount >= this.compactAfter;
  }

  /** Correlation helper for fresh local ids (used only for logging, opencode owns real ids). */
  static newCorrelationId(): string {
    return randomUUID();
  }
}
