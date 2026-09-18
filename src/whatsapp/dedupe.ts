/**
 * In-memory LRU for the hot dedupe path. The SQLite `seen_messages`
 * table is the source of truth across restarts; this just avoids
 * hitting disk for recently-seen ids (Baileys redelivers bursts on
 * reconnect / history sync).
 */
export class LruDedupe {
  private map = new Map<string, number>();
  private readonly cap: number;

  constructor(cap = 2000) {
    this.cap = Math.max(1, cap);
  }

  has(id: string): boolean {
    const v = this.map.get(id);
    if (v === undefined) return false;
    // refresh recency
    this.map.delete(id);
    this.map.set(id, v);
    return true;
  }

  add(id: string): void {
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, Date.now());
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
