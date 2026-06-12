import { describe, expect, it } from "vitest";
import { formatAmount, parseAmount } from "../src/money.js";

describe("money", () => {
  it("round-trips decimal strings", () => {
    for (const s of ["0", "1", "0.05", "12.345678", "1000000"]) {
      expect(formatAmount(parseAmount(s))).toBe(s);
    }
  });

  it("parses to 6-dp micro-units", () => {
    expect(parseAmount("0.05")).toBe(50_000n);
    expect(parseAmount("1")).toBe(1_000_000n);
    expect(parseAmount("0.000001")).toBe(1n);
  });

  it("rejects malformed amounts", () => {
    for (const s of ["-1", "1.2345678", "abc", "1,5", "", "0x10", "1e3"]) {
      expect(() => parseAmount(s), s).toThrow();
    }
  });

  it("adds exactly where floats would drift", () => {
    let total = 0n;
    for (let i = 0; i < 10; i++) total += parseAmount("0.1");
    expect(formatAmount(total)).toBe("1");
  });
});
