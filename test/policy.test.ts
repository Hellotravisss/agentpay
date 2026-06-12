import { describe, expect, it } from "vitest";
import type { AgentPolicy, PaymentContext, PaymentReceipt } from "../src/types.js";
import { evaluate, resolvePolicy } from "../src/policy/engine.js";
import { SpendLedger } from "../src/ledger/ledger.js";

const T0 = Date.UTC(2026, 5, 12, 12, 0, 0); // 2026-06-12 noon UTC

function ctx(overrides: Partial<PaymentContext["requirement"]> = {}, timestamp = T0): PaymentContext {
  return {
    agentId: "bot",
    timestamp,
    requirement: {
      scheme: "exact",
      network: "mock",
      amount: "0.05",
      currency: "USDC",
      payTo: "merchant-a",
      resource: "http://x/weather",
      ...overrides,
    },
  };
}

function receipt(amount: string, timestamp: number, agentId = "bot"): PaymentReceipt {
  return { id: "r", rail: "mock", agentId, amount, currency: "USDC", payTo: "merchant-a", resource: "r", timestamp, proof: "p" };
}

const basePolicy: AgentPolicy = { agentId: "bot", enabled: true, currency: "USDC" };

describe("policy engine", () => {
  it("allows a payment with no limits configured", () => {
    expect(evaluate(basePolicy, ctx(), new SpendLedger())).toEqual({ allow: true });
  });

  it("denies disabled agents", () => {
    const d = evaluate({ ...basePolicy, enabled: false }, ctx(), new SpendLedger());
    expect(d).toMatchObject({ allow: false, rule: "agent_disabled" });
  });

  it("denies currency mismatches", () => {
    const d = evaluate(basePolicy, ctx({ currency: "EUR" }), new SpendLedger());
    expect(d).toMatchObject({ allow: false, rule: "currency_mismatch" });
  });

  it("enforces per-transaction max", () => {
    const policy = { ...basePolicy, perTransactionMax: "0.04" };
    expect(evaluate(policy, ctx(), new SpendLedger())).toMatchObject({ allow: false, rule: "per_transaction_max" });
    expect(evaluate(policy, ctx({ amount: "0.04" }), new SpendLedger())).toEqual({ allow: true });
  });

  it("enforces the payee allowlist before the blocklist", () => {
    const policy = { ...basePolicy, payeeAllowlist: ["merchant-b"], payeeBlocklist: ["merchant-a"] };
    expect(evaluate(policy, ctx(), new SpendLedger())).toMatchObject({ allow: false, rule: "payee_not_allowlisted" });
  });

  it("enforces the payee blocklist", () => {
    const policy = { ...basePolicy, payeeBlocklist: ["merchant-a"] };
    expect(evaluate(policy, ctx(), new SpendLedger())).toMatchObject({ allow: false, rule: "payee_blocklisted" });
  });

  it("enforces the daily budget against today's ledger entries only", () => {
    const policy = { ...basePolicy, dailyBudget: "0.10" };
    const ledger = new SpendLedger();
    ledger.record(receipt("0.08", T0 - 60_000)); // earlier today
    ledger.record(receipt("9.99", T0 - 24 * 3600_000)); // yesterday — ignored
    expect(evaluate(policy, ctx(), new SpendLedger())).toEqual({ allow: true });
    expect(evaluate(policy, ctx(), ledger)).toMatchObject({ allow: false, rule: "daily_budget" });
    expect(evaluate(policy, ctx({ amount: "0.02" }), ledger)).toEqual({ allow: true });
  });

  it("enforces the monthly budget", () => {
    const policy = { ...basePolicy, monthlyBudget: "1.00" };
    const ledger = new SpendLedger();
    ledger.record(receipt("0.98", Date.UTC(2026, 5, 1))); // June 1 — same month
    expect(evaluate(policy, ctx(), ledger)).toMatchObject({ allow: false, rule: "monthly_budget" });
  });

  it("enforces max transactions per day", () => {
    const policy = { ...basePolicy, maxTransactionsPerDay: 2 };
    const ledger = new SpendLedger();
    ledger.record(receipt("0.01", T0 - 2000));
    ledger.record(receipt("0.01", T0 - 1000));
    expect(evaluate(policy, ctx(), ledger)).toMatchObject({ allow: false, rule: "max_transactions_per_day" });
  });

  it("does not count other agents' spend", () => {
    const policy = { ...basePolicy, dailyBudget: "0.10" };
    const ledger = new SpendLedger();
    ledger.record(receipt("9.99", T0 - 1000, "other-bot"));
    expect(evaluate(policy, ctx(), ledger)).toEqual({ allow: true });
  });
});

describe("resolvePolicy", () => {
  it("overlays defaults under the agent's own policy", () => {
    const resolved = resolvePolicy(
      {
        defaults: { currency: "USDC", perTransactionMax: "1.00", dailyBudget: "10.00" },
        agents: [{ agentId: "bot", enabled: true, currency: "USDC", perTransactionMax: "0.25" }],
      },
      "bot",
    );
    expect(resolved).toMatchObject({ perTransactionMax: "0.25", dailyBudget: "10.00" });
  });

  it("returns undefined for unknown agents (deny by default)", () => {
    expect(resolvePolicy({ agents: [] }, "ghost")).toBeUndefined();
  });
});
