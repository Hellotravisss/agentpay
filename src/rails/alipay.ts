import { randomUUID } from "node:crypto";
import type { PaymentContext, PaymentReceipt } from "../types.js";
import type { PaymentRail } from "./rail.js";

export interface AlipayActRailConfig {
  /** Networks this deployment settles on, e.g. ["alipay-act"]. */
  networks: string[];
  /**
   * Executes the payment against Alipay's agent-payment APIs (AI付 / ACT
   * delegated authorization) and returns the proof/voucher the merchant
   * accepts. Requires merchant onboarding with Alipay; credentials stay
   * inside this callback, never in the gateway core.
   */
  executePayment: (ctx: PaymentContext) => Promise<string>;
}

/**
 * Adapter for Alipay's agent payment stack (AI付, settling under the ACT —
 * Agent Commerce Trust — delegation model). Same shape as X402Rail: the
 * gateway owns policy and the retry flow, this adapter only executes the
 * approved payment.
 */
export class AlipayActRail implements PaymentRail {
  readonly name = "alipay-act";

  constructor(private readonly config: AlipayActRailConfig) {}

  supports(network: string): boolean {
    return this.config.networks.includes(network);
  }

  async pay(ctx: PaymentContext): Promise<PaymentReceipt> {
    const proof = await this.config.executePayment(ctx);
    const { requirement: req } = ctx;
    return {
      id: randomUUID(),
      rail: this.name,
      agentId: ctx.agentId,
      amount: req.amount,
      currency: req.currency,
      payTo: req.payTo,
      resource: req.resource,
      timestamp: ctx.timestamp,
      proof,
    };
  }
}
