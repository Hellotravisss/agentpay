import { describe, expect, it } from "vitest";
import { convert, FixedRateProvider } from "../src/fx/rates.js";
import { MONEY_SCALE, formatAmount, parseAmount } from "../src/money.js";

describe("FixedRateProvider", () => {
  const rates = new FixedRateProvider({ "CNY:USD": "0.14", "USDC:USD": "1" });

  it("returns identity for same-currency pairs", () => {
    expect(rates.rate("USD", "USD")).toBe(MONEY_SCALE);
    expect(rates.rate("XYZ", "XYZ")).toBe(MONEY_SCALE);
  });

  it("returns configured pairs and undefined otherwise", () => {
    expect(rates.rate("CNY", "USD")).toBe(parseAmount("0.14"));
    expect(rates.rate("USD", "CNY")).toBeUndefined(); // directional on purpose
    expect(rates.rate("EUR", "USD")).toBeUndefined();
  });
});

describe("convert", () => {
  it("converts exactly", () => {
    expect(formatAmount(convert(parseAmount("0.36"), parseAmount("0.14")))).toBe("0.0504");
    expect(formatAmount(convert(parseAmount("100"), parseAmount("1")))).toBe("100");
  });

  it("rounds up so budgets are conservative", () => {
    // 0.000001 * 0.14 = 0.00000014 -> rounds up to one micro-unit
    expect(convert(1n, parseAmount("0.14"))).toBe(1n);
  });
});
