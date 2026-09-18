import { describe, expect, it } from "vitest";
import { WHATSAPP_MAX_CHUNK, chunkText } from "../src/bridge/chunker.js";

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    expect(chunkText("hello")).toEqual(["hello"]);
    expect(chunkText("")).toEqual([]);
  });

  it("splits long text into ≤4096 chunks", () => {
    const long = "a".repeat(9000);
    const chunks = chunkText(long);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(WHATSAPP_MAX_CHUNK);
    expect(chunks.join("")).toBe(long);
  });

  it("prefers newline boundaries", () => {
    const para = `${"x".repeat(4000)}\n${"y".repeat(200)}`;
    const chunks = chunkText(para, 4096);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith("\n")).toBe(true);
  });

  it("is unicode-safe (emoji)", () => {
    const emoji = "😀".repeat(5000);
    const chunks = chunkText(emoji);
    expect(chunks.join("")).toBe(emoji);
    for (const c of chunks) expect(Array.from(c).length).toBeLessThanOrEqual(WHATSAPP_MAX_CHUNK);
  });
});
