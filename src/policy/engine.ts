import type { AgentPolicy, PaymentContext, PolicyConfig, PolicyDecision } from "../types.js";
import { formatAmount, parseAmount } from "../money.js";
import { convert, FixedRateProvider, type RateProvider } from "../fx/rates.js";
import { SpendLedger, startOfUtcDay, startOfUtcMonth } from "../ledger/ledger.js";

const IDENTITY_RATES = new FixedRateProvider({});

/** Resolve the effective policy for an agent: config defaults overlaid by the agent's entry. */
export function resolvePolicy(config: PolicyConfig, agentId: string): AgentPolicy | undefined {
  const own = config.agents.find((a) => a.agentId === agentId);
  if (!own) return undefined;
  return { ...config.defaults, ...own };
}

/**
 * Decide whether one payment is allowed. Pure given (policy, ledger, rates,
 * ctx) — no clock or IO access — so every decision is reproducible in tests
 * and replays.
 *
 * Limits are denominated in the policy's base currency; the payment amount
 * is converted via `rates` first (rounding up), so one budget governs spend
 * across every rail and currency.
 *
 * Rules are checked cheapest-first; the first violated rule wins.
 */
export function evaluate(
  policy: AgentPolicy,
  ctx: PaymentContext,
  ledger: SpendLedger,
  rates: RateProvider = IDENTITY_RATES,
): PolicyDecision {
  const { requirement: req } = ctx;
  const deny = (rule: string, reason: string): PolicyDecision => ({ allow: false, rule, reason });

  if (!policy.enabled) {
    return deny("agent_disabled", `Agent "${ctx.agentId}" is disabled`);
  }

  const rate = rates.rate(req.currency, policy.currency);
  if (rate === undefined) {
    return deny(
      "no_fx_rate",
      `No conversion rate from ${req.currency} to policy currency ${policy.currency}`,
    );
  }
  const amount = convert(parseAmount(req.amount), rate);
  const inBase = (v: bigint) => `${formatAmount(v)} ${policy.currency}`;

  if (policy.payeeAllowlist && !policy.payeeAllowlist.includes(req.payTo)) {
    return deny("payee_not_allowlisted", `Payee ${req.payTo} is not on the allowlist`);
  }

  if (policy.payeeBlocklist?.includes(req.payTo)) {
    return deny("payee_blocklisted", `Payee ${req.payTo} is blocklisted`);
  }

  if (policy.perTransactionMax !== undefined && amount > parseAmount(policy.perTransactionMax)) {
    return deny(
      "per_transaction_max",
      `Amount ${req.amount} ${req.currency} (${inBase(amount)}) exceeds per-transaction max ${policy.perTransactionMax}`,
    );
  }

  const dayStart = startOfUtcDay(ctx.timestamp);

  if (policy.maxTransactionsPerDay !== undefined) {
    const count = ledger.transactionsSince(ctx.agentId, dayStart, ctx.timestamp);
    if (count >= policy.maxTransactionsPerDay) {
      return deny(
        "max_transactions_per_day",
        `Agent already made ${count} payments today (limit ${policy.maxTransactionsPerDay})`,
      );
    }
  }

  if (policy.dailyBudget !== undefined) {
    const spent = ledger.spentSince(ctx.agentId, policy.currency, dayStart, ctx.timestamp);
    const budget = parseAmount(policy.dailyBudget);
    if (spent + amount > budget) {
      return deny(
        "daily_budget",
        `Payment of ${inBase(amount)} would exceed daily budget ${policy.dailyBudget} (already spent ${formatAmount(spent)})`,
      );
    }
  }

  if (policy.monthlyBudget !== undefined) {
    const spent = ledger.spentSince(ctx.agentId, policy.currency, startOfUtcMonth(ctx.timestamp), ctx.timestamp);
    const budget = parseAmount(policy.monthlyBudget);
    if (spent + amount > budget) {
      return deny(
        "monthly_budget",
        `Payment of ${inBase(amount)} would exceed monthly budget ${policy.monthlyBudget} (already spent ${formatAmount(spent)})`,
      );
    }
  }

  return { allow: true };
}
