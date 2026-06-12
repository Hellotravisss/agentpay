import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { PaymentReceipt } from "../types.js";
import { parseAmount } from "../money.js";

/**
 * Append-only spend ledger. Holds every executed payment in memory and
 * optionally persists each one as a JSONL line so budgets survive restarts.
 *
 * Budget windows are computed in UTC: "daily" is the current UTC calendar day,
 * "monthly" is the current UTC calendar month.
 */
export class SpendLedger {
  private receipts: PaymentReceipt[] = [];

  constructor(private readonly persistPath?: string) {
    if (persistPath && existsSync(persistPath)) {
      const lines = readFileSync(persistPath, "utf8").split("\n").filter(Boolean);
      this.receipts = lines.map((l) => JSON.parse(l) as PaymentReceipt);
    }
  }

  record(receipt: PaymentReceipt): void {
    this.receipts.push(receipt);
    if (this.persistPath) {
      appendFileSync(this.persistPath, JSON.stringify(receipt) + "\n");
    }
  }

  /** Total spent (micro-units) by an agent in a currency since `sinceMs`, up to `now`. */
  spentSince(agentId: string, currency: string, sinceMs: number, now: number): bigint {
    let total = 0n;
    for (const r of this.receipts) {
      if (r.agentId === agentId && r.currency === currency && r.timestamp >= sinceMs && r.timestamp <= now) {
        total += parseAmount(r.amount);
      }
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
