import { describe, expect, it } from "vitest";
import { LruDedupe } from "../src/whatsapp/dedupe.js";
import { Store } from "../src/whatsapp/store.js";

describe("LruDedupe", () => {
  it("tracks recency and evicts oldest", () => {
    const d = new LruDedupe(2);
    d.add("a");
    d.add("b");
    expect(d.has("a")).toBe(true);
    d.add("c");
    expect(d.size).toBe(2);
    expect(d.has("b")).toBe(false);
    expect(d.has("a")).toBe(true);
    expect(d.has("c")).toBe(true);
  });
});

describe("Store seen_messages", () => {
  it("persists across instances", () => {
    const path = `/tmp/wa-bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const s1 = new Store(path);
    expect(s1.hasSeen("ABC")).toBe(false);
    s1.markSeen("ABC");
    expect(s1.hasSeen("ABC")).toBe(true);
    s1.close();

    const s2 = new Store(path);
    expect(s2.hasSeen("ABC")).toBe(true);
    s2.close();
  });

  it("round-trips messages + markRead", () => {
    const s = new Store(":memory:");
    s.saveMessage({
      wa_id: "m1",
      chat_jid: "62812@s.whatsapp.net",
      sender_jid: "62812@s.whatsapp.net",
      direction: "inbound",
      body: "hi",
      msg_type: "text",
      timestamp_ms: Date.now(),
    });
    expect(s.getMessages("62812@s.whatsapp.net", 10)).toHaveLength(1);
    expect(s.markRead("62812@s.whatsapp.net", ["m1"])).toBe(1);
    s.close();
  });
});
