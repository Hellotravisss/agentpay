/**
 * Exact decimal money arithmetic using bigint micro-units (6 decimal places).
 * 6 dp matches USDC's atomic precision and is plenty for fiat rails.
 */

export const MONEY_SCALE = 1_000_000n;
const AMOUNT_RE = /^(\d+)(?:\.(\d{1,6}))?$/;

/** Parse a non-negative decimal string ("0.05") into micro-units. Throws on bad input. */
export function parseAmount(s: string): bigint {
  const m = AMOUNT_RE.exec(s.trim());
  if (!m) {
    throw new Error(`Invalid amount ${JSON.stringify(s)}: expected a non-negative decimal with <= 6 decimal places`);
  }
  const whole = BigInt(m[1]!) * MONEY_SCALE;
  const frac = m[2] ? BigInt(m[2].padEnd(6, "0")) : 0n;
  return whole + frac;
}

/** Format micro-units back to a decimal string with trailing zeros trimmed. */
export function formatAmount(v: bigint): string {
  if (v < 0n) throw new Error("Negative amounts are not representable");
  const whole = v / MONEY_SCALE;
  const frac = (v % MONEY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}
