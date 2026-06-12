import { MONEY_SCALE, parseAmount } from "../money.js";

/**
 * Currency conversion for cross-rail budgets: an agent's limits are
 * denominated in one base currency (say USD), while payments arrive in
 * whatever the rail settles (USDC on x402, CNY on Alipay, ...).
 *
 * Rates are 6-dp scaled bigints, conversions round UP so budgets are
 * enforced conservatively.
 */
export interface RateProvider {
  /** Scaled (6-dp) rate converting 1 unit of `from` into `to`, or undefined if unknown. */
  rate(from: string, to: string): bigint | undefined;
}

/**
 * Static rate table for development and tests, e.g.
 * `{ "USDC:USD": "1", "CNY:USD": "0.14" }`. Identity pairs are implicit.
 * Pairs are directional on purpose — bigint inverses lose precision, so
 * declare both directions if you need them. Swap in a live provider
 * (with caching and staleness limits) for production.
 */
export class FixedRateProvider implements RateProvider {
  private readonly pairs: Record<string, bigint>;

  constructor(pairs: Record<string, string>) {
    this.pairs = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, parseAmount(v)]));
  }

  rate(from: string, to: string): bigint | undefined {
    if (from === to) return MONEY_SCALE;
    return this.pairs[`${from}:${to}`];
  }
}

/** Convert micro-units by a scaled rate, rounding up (budget-conservative). */
export function convert(amount: bigint, rate: bigint): bigint {
  return (amount * rate + MONEY_SCALE - 1n) / MONEY_SCALE;
}
