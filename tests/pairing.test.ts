import { describe, expect, it } from "vitest";
import { normalizePhoneForPairing } from "../src/whatsapp/connection.js";

describe("normalizePhoneForPairing", () => {
  it("accepts country-code digits, strips formatting", () => {
    expect(normalizePhoneForPairing("6281234567890")).toBe("6281234567890");
    expect(normalizePhoneForPairing("+62 812-3456-7890")).toBe("6281234567890");
  });

  it("rejects trunk-zero local format with actionable error", () => {
    expect(() => normalizePhoneForPairing("081234567890")).toThrow(/trunk zero/i);
  });

  it("rejects empty and absurd lengths", () => {
    expect(() => normalizePhoneForPairing("")).toThrow(/required/i);
    expect(() => normalizePhoneForPairing("123")).toThrow(/7–15/);
  });
});
