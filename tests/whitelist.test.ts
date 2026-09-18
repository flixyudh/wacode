import { describe, expect, it } from "vitest";
import { Whitelist, isGroupJid, isLidJid, isPnJid, jidToDigits, normalizeDigits, passesSharedSecret, pickIdentityJid } from "../src/bridge/whitelist.js";

describe("normalizeDigits", () => {
  it("strips non-digits", () => {
    expect(normalizeDigits("+62 812-3456-7890")).toBe("6281234567890");
  });
});

describe("jidToDigits", () => {
  it("extracts user part", () => {
    expect(jidToDigits("6281234567890@s.whatsapp.net")).toBe("6281234567890");
    expect(jidToDigits("+62812 345 6789@s.whatsapp.net")).toBe("628123456789");
  });
});

describe("Whitelist", () => {
  it("matches JIDs and bare numbers, exact only", () => {
    const w = new Whitelist(["6281234567890", " 6289876543210 "]);
    expect(w.isAllowed("6281234567890@s.whatsapp.net")).toBe(true);
    expect(w.isAllowed("6281234567890")).toBe(true);
    expect(w.isAllowed("+62 812-3456-7890")).toBe(true);
    expect(w.isAllowed("6281234567891@s.whatsapp.net")).toBe(false);
    expect(w.isAllowed("")).toBe(false);
    expect(w.size).toBe(2);
  });

  it("does not suffix-match (explicit only)", () => {
    const w = new Whitelist(["81234567890"]);
    expect(w.isAllowed("6281234567890@s.whatsapp.net")).toBe(false);
  });
});

describe("isGroupJid", () => {
  it("detects groups", () => {
    expect(isGroupJid("123-456@g.us")).toBe(true);
    expect(isGroupJid("62812@s.whatsapp.net")).toBe(false);
  });
});

describe("passesSharedSecret", () => {
  it("off by default", () => {
    expect(passesSharedSecret("hello", "")).toBe(true);
  });
  it("requires keyword when set", () => {
    expect(passesSharedSecret("hello sesame world", "sesame")).toBe(true);
    expect(passesSharedSecret("hello", "sesame")).toBe(false);
    expect(passesSharedSecret(null, "sesame")).toBe(false);
  });
});

describe("LID identities", () => {
  it("classifies servers", () => {
    expect(isLidJid("122608481730748@lid")).toBe(true);
    expect(isLidJid("62812@s.whatsapp.net")).toBe(false);
    expect(isPnJid("62812@s.whatsapp.net")).toBe(true);
    expect(isPnJid("122608481730748@lid")).toBe(false);
  });

  it("whitelist matches raw LID digits too", () => {
    const w = new Whitelist(["122608481730748"]);
    expect(w.isAllowed("122608481730748@lid")).toBe(true);
    expect(w.isAllowed("6282110928426@s.whatsapp.net")).toBe(false);
  });

  it("pickIdentityJid prefers PN over LID", () => {
    expect(pickIdentityJid(["122608481730748@lid", "6282110928426@s.whatsapp.net"])).toBe(
      "6282110928426@s.whatsapp.net",
    );
    expect(pickIdentityJid(["122608481730748@lid"])).toBe("122608481730748@lid");
    expect(pickIdentityJid([])).toBe("");
  });
});
