import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { LidResolver, classifyPair, parseStaticMap, seedSignalStore } from "../src/bridge/lid-resolver.js";
import { Store } from "../src/whatsapp/store.js";

const silent = pino({ level: "silent" });

describe("parseStaticMap", () => {
  it("parses lid:pn pairs (JIDs or bare digits)", () => {
    const m = parseStaticMap("122608481730748@lid:6282110928426@s.whatsapp.net, 999@lid:62800");
    expect(m.get("122608481730748")).toBe("6282110928426");
    expect(m.get("999")).toBe("62800");
  });

  it("empty string yields empty map", () => {
    expect(parseStaticMap("").size).toBe(0);
    expect(parseStaticMap("  ").size).toBe(0);
  });

  it("rejects malformed entries", () => {
    expect(() => parseStaticMap("no-colon-here")).toThrow(/lid:pn/);
    expect(() => parseStaticMap("abc:def")).toThrow(/digits/);
    expect(() => parseStaticMap("1:2:3")).toThrow(/lid:pn/);
  });
});

describe("classifyPair", () => {
  it("detects roles in either order", () => {
    expect(classifyPair("122608481730748@lid", "6282110928426@s.whatsapp.net")).toEqual([
      "122608481730748",
      "6282110928426",
    ]);
    expect(classifyPair("6282110928426@s.whatsapp.net", "122608481730748@lid")).toEqual([
      "122608481730748",
      "6282110928426",
    ]);
  });

  it("rejects non-pairs", () => {
    expect(classifyPair("a@s.whatsapp.net", "b@s.whatsapp.net")).toBeNull();
    expect(classifyPair("a@lid", "b@lid")).toBeNull();
    expect(classifyPair(undefined, "b@s.whatsapp.net")).toBeNull();
    expect(classifyPair("1@g.us", "2@lid")).toBeNull();
  });
});

describe("LidResolver", () => {
  it("static map wins over cache", () => {
    const store = new Store(":memory:");
    store.setLidMap("111", "62800");
    const r = new LidResolver(store, new Map([["111", "62899"]]), silent);
    expect(r.toPnJid("111@lid")).toBe("62899@s.whatsapp.net");
    store.close();
  });

  it("falls back to cache, learns new pairs", () => {
    const store = new Store(":memory:");
    const r = new LidResolver(store, new Map(), silent);
    expect(r.toPnJid("222@lid")).toBeNull();
    expect(r.learn("222@lid", "6282110928426@s.whatsapp.net")).toBe(true);
    expect(r.toPnJid("222@lid")).toBe("6282110928426@s.whatsapp.net");
    // second learn of the same pair is a no-op
    expect(r.learn("222@lid", "6282110928426@s.whatsapp.net")).toBe(false);
    store.close();
  });

  it("learns from contacts in either field order", () => {
    const store = new Store(":memory:");
    const r = new LidResolver(store, new Map(), silent);
    expect(r.learnFromContact({ id: "6282110928426@s.whatsapp.net", lid: "122608481730748@lid" })).toBe(true);
    expect(r.toPnJid("122608481730748")).toBe("6282110928426@s.whatsapp.net");
    expect(r.learnFromContact({ id: "no-lid-here" })).toBe(false);
    store.close();
  });

  it("persists cache across restarts", () => {
    const path = `/tmp/wa-lid-test-${Date.now()}.db`;
    const s1 = new Store(path);
    new LidResolver(s1, new Map(), silent).learn("333@lid", "62811@s.whatsapp.net");
    s1.close();
    const s2 = new Store(path);
    expect(new LidResolver(s2, new Map(), silent).toPnJid("333@lid")).toBe("62811@s.whatsapp.net");
    s2.close();
  });

  it("learns raw { lid, pn } mappings (v7 lid-mapping.update shape)", () => {
    const store = new Store(":memory:");
    const r = new LidResolver(store, new Map(), silent);
    expect(r.learnMapping({ lid: "444@lid", pn: "62822@s.whatsapp.net" })).toBe(true);
    expect(r.toPnJid("444@lid")).toBe("62822@s.whatsapp.net");
    expect(r.learnMapping({})).toBe(false);
    store.close();
  });

  it("learns from contacts with phoneNumber field", () => {
    const store = new Store(":memory:");
    const r = new LidResolver(store, new Map(), silent);
    expect(r.learnFromContact({ id: "555@lid", phoneNumber: "62823@s.whatsapp.net" })).toBe(true);
    expect(r.toPnJid("555@lid")).toBe("62823@s.whatsapp.net");
    store.close();
  });
});

describe("seedSignalStore", () => {
  it("seeds v7 stores, no-ops without one", async () => {
    const storeLIDPNMappings = vi.fn(async () => undefined);
    const sock = { signalRepository: { lidMapping: { storeLIDPNMappings } } };
    await seedSignalStore(sock, new Map([["122608481730748", "6282110928426"]]), silent);
    expect(storeLIDPNMappings).toHaveBeenCalledWith([
      { lid: "122608481730748@lid", pn: "6282110928426@s.whatsapp.net" },
    ]);
    await seedSignalStore({}, new Map([["1", "2"]]), silent); // v6 shape: no-op, no throw
    await seedSignalStore(sock, new Map(), silent); // empty map: no-op
    expect(storeLIDPNMappings).toHaveBeenCalledTimes(1);
  });
});
