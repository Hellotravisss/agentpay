import type { PaymentReceipt } from "../types.js";
import { parseAmount } from "../money.js";
import type { RecordStore } from "../store/store.js";

/**
 * Append-only spend ledger. Holds every executed payment in memory and
 * optionally mirrors each one to a persistence backend (JSONL or SQLite) so
 * budgets survive restarts. With no store it is purely in-memory.
 *
 * Budget windows are computed in UTC: "daily" is the current UTC calendar day,
 * "monthly" is the current UTC calendar month.
 */
export class SpendLedger {
  private receipts: PaymentReceipt[] = [];

  constructor(private readonly store?: RecordStore<PaymentReceipt>) {
    if (store) this.receipts = store.all();
  }

  record(receipt: PaymentReceipt): void {
    this.receipts.push(receipt);
    this.store?.append(receipt);
  }

  /**
   * Total spent (micro-units) by an agent in a base currency since `sinceMs`,
   * up to `now`. Uses the receipt's converted base amount when present (set by
   * the gateway at execution time), so spend across rails and currencies rolls
   * up into one number.
   */
  spentSince(agentId: string, currency: string, sinceMs: number, now: number): bigint {
    let total = 0n;
    for (const r of this.receipts) {
      if (r.agentId !== agentId || r.timestamp < sinceMs || r.timestamp > now) continue;
      if ((r.baseCurrency ?? r.currency) !== currency) continue;
      total += parseAmount(r.baseAmount ?? r.amount);
    }
    return total;
  }

  transactionsSince(agentId: string, sinceMs: number, now: number): number {
    return this.receipts.filter((r) => r.agentId === agentId && r.timestamp >= sinceMs && r.timestamp <= now).length;
  }

  receiptsFor(agentId: string): PaymentReceipt[] {
    return this.receipts.filter((r) => r.agentId === agentId);
  }
}

export function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function startOfUtcMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
