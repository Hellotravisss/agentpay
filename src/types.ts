/**
 * Core domain types for the agent payment gateway.
 *
 * Money is represented as decimal strings at the API boundary ("0.05")
 * and as bigint micro-units (6 decimal places) internally — never floats.
 */

/** What a 402 Payment Required response demands. Modeled on the x402 wire shape. */
export interface PaymentRequirement {
  /** Payment scheme, e.g. "exact" (pay exactly this amount). */
  scheme: string;
  /** Settlement network, e.g. "base-sepolia", or "mock" for local development. */
  network: string;
  /** Amount in human units as a decimal string, e.g. "0.05". */
  amount: string;
  /** Currency / asset symbol, e.g. "USDC". */
  currency: string;
  /** Payee identifier: an address on the network, or a merchant id. */
  payTo: string;
  /** The resource (URL) being purchased. */
  resource: string;
  description?: string;
}

/** Everything the policy engine needs to decide on one payment. */
export interface PaymentContext {
  agentId: string;
  requirement: PaymentRequirement;
  /** Epoch ms. Injectable so tests and replays are deterministic. */
  timestamp: number;
}

export type PolicyDecision =
  | { allow: true }
  | {
      allow: false;
      /** Machine-readable id of the rule that denied, e.g. "per_transaction_max". */
      rule: string;
      /** Human-readable explanation, safe to return to the agent. */
      reason: string;
    };

/** Proof that a payment was executed on some rail. */
export interface PaymentReceipt {
  id: string;
  rail: string;
  agentId: string;
  amount: string;
  currency: string;
  payTo: string;
  resource: string;
  timestamp: number;
  /** Rail-specific proof (tx hash, signed payload, ...). Forwarded upstream as X-PAYMENT. */
  proof: string;
}

/** Spend limits for a single agent. All amounts are decimal strings in `currency`. */
export interface AgentPolicy {
  agentId: string;
  enabled: boolean;
  /** Currency the limits below are denominated in. Payments in other currencies are denied. */
  currency: string;
  perTransactionMax?: string;
  dailyBudget?: string;
  monthlyBudget?: string;
  maxTransactionsPerDay?: number;
  /** If present, only these payees may be paid (checked before blocklist). */
  payeeAllowlist?: string[];
  payeeBlocklist?: string[];
}

export interface PolicyConfig {
  /** Applied to every agent unless the agent's own policy overrides the field. */
  defaults?: Partial<Omit<AgentPolicy, "agentId">>;
  agents: AgentPolicy[];
}

export type AuditEvent =
  | "payment_denied"
  | "payment_executed"
  | "payment_failed"
  | "policy_missing";

export interface AuditEntry {
  timestamp: number;
  event: AuditEvent;
  agentId: string;
  details: Record<string, unknown>;
}
