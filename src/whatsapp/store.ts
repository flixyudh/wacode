import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface StoredMessage {
  wa_id: string;
  chat_jid: string;
  sender_jid: string;
  direction: "inbound" | "outbound";
  body: string | null;
  msg_type: string;
  timestamp_ms: number;
  is_read: number;
  created_at_ms: number;
}

export interface SessionRecord {
  jid: string;
  opencode_session_id: string;
  last_active_at_ms: number;
  message_count: number;
}

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        wa_id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
        body TEXT,
        msg_type TEXT NOT NULL DEFAULT 'unknown',
        timestamp_ms INTEGER NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_jid, timestamp_ms DESC);

      CREATE TABLE IF NOT EXISTS seen_messages (
        wa_id TEXT PRIMARY KEY,
        seen_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        jid TEXT PRIMARY KEY,
        opencode_session_id TEXT NOT NULL,
        last_active_at_ms INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_seen_ms INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        last_message_at_ms INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS lid_map (
        lid TEXT PRIMARY KEY,
        pn TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  // --- messages ---

  saveMessage(m: Omit<StoredMessage, "created_at_ms" | "is_read"> & { is_read?: number }): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (wa_id, chat_jid, sender_jid, direction, body, msg_type, timestamp_ms, is_read, created_at_ms)
      VALUES (@wa_id, @chat_jid, @sender_jid, @direction, @body, @msg_type, @timestamp_ms, @is_read, @created_at_ms)
      ON CONFLICT(wa_id) DO NOTHING
    `);
    stmt.run({
      ...m,
      is_read: m.is_read ?? 0,
      created_at_ms: Date.now(),
    });
    this.touchChat(m.chat_jid, m.timestamp_ms, m.direction === "inbound" ? 1 : 0);
  }

  getMessages(chatJid: string, limit = 20): StoredMessage[] {
    const lim = Math.min(Math.max(limit, 1), 100);
    return this.db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp_ms DESC LIMIT ?`)
      .all(chatJid, lim) as StoredMessage[];
  }

  getRecentMessages(limit = 50): StoredMessage[] {
    const lim = Math.min(Math.max(limit, 1), 100);
    return this.db
      .prepare(`SELECT * FROM messages ORDER BY timestamp_ms DESC LIMIT ?`)
      .all(lim) as StoredMessage[];
  }

  markRead(chatJid: string, ids?: string[]): number {
    if (ids && ids.length > 0) {
      const placeholders = ids.map(() => "?").join(",");
      const res = this.db
        .prepare(`UPDATE messages SET is_read = 1 WHERE chat_jid = ? AND wa_id IN (${placeholders})`)
        .run(chatJid, ...ids);
      this.db.prepare(`UPDATE chats SET unread_count = 0 WHERE jid = ?`).run(chatJid);
      return Number(res.changes);
    }
    const res = this.db
      .prepare(`UPDATE messages SET is_read = 1 WHERE chat_jid = ? AND is_read = 0`)
      .run(chatJid);
    this.db.prepare(`UPDATE chats SET unread_count = 0 WHERE jid = ?`).run(chatJid);
    return Number(res.changes);
  }

  // --- dedupe ---

  hasSeen(waId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM seen_messages WHERE wa_id = ?`).get(waId);
    return !!row;
  }

  markSeen(waId: string): void {
    this.db
      .prepare(`INSERT INTO seen_messages (wa_id, seen_at_ms) VALUES (?, ?) ON CONFLICT(wa_id) DO NOTHING`)
      .run(waId, Date.now());
  }

  // --- sessions ---

  getSession(jid: string): SessionRecord | null {
    return (this.db.prepare(`SELECT * FROM sessions WHERE jid = ?`).get(jid) as SessionRecord) ?? null;
  }

  upsertSession(s: SessionRecord): void {
    this.db
      .prepare(`
        INSERT INTO sessions (jid, opencode_session_id, last_active_at_ms, message_count)
        VALUES (@jid, @opencode_session_id, @last_active_at_ms, @message_count)
        ON CONFLICT(jid) DO UPDATE SET
          opencode_session_id = excluded.opencode_session_id,
          last_active_at_ms = excluded.last_active_at_ms,
          message_count = excluded.message_count
      `)
      .run(s);
  }

  deleteSession(jid: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE jid = ?`).run(jid);
  }

  // --- LID → PN cache ---

  getPnForLid(lidDigits: string): string | null {
    const row = this.db
      .prepare(`SELECT pn FROM lid_map WHERE lid = ?`)
      .get(lidDigits) as { pn: string } | undefined;
    return row?.pn ?? null;
  }

  /** Upsert a mapping. Returns true if it changed anything. */
  setLidMap(lidDigits: string, pnDigits: string): boolean {
    const prev = this.getPnForLid(lidDigits);
    if (prev === pnDigits) return false;
    this.db
      .prepare(`
        INSERT INTO lid_map (lid, pn, updated_at_ms) VALUES (?, ?, ?)
        ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn, updated_at_ms = excluded.updated_at_ms
      `)
      .run(lidDigits, pnDigits, Date.now());
    return true;
  }

  // --- contacts / chats ---

  touchContact(jid: string, name?: string): void {
    this.db
      .prepare(`
        INSERT INTO contacts (jid, name, last_seen_ms) VALUES (?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          name = COALESCE(excluded.name, contacts.name),
          last_seen_ms = excluded.last_seen_ms
      `)
      .run(jid, name ?? null, Date.now());
  }

  private touchChat(jid: string, atMs: number, unreadDelta: number): void {
    this.db
      .prepare(`
        INSERT INTO chats (jid, last_message_at_ms, unread_count) VALUES (?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          last_message_at_ms = MAX(chats.last_message_at_ms, excluded.last_message_at_ms),
          unread_count = chats.unread_count + excluded.unread_count
      `)
      .run(jid, atMs, unreadDelta);
  }

  flush(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best effort
    }
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
