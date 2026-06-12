import { randomUUID } from "node:crypto";
import type { PaymentContext, PaymentReceipt } from "../types.js";
import type { PaymentRail } from "./rail.js";

export interface X402RailConfig {
  /** Networks this deployment settles on, e.g. ["base-sepolia"]. */
  networks: string[];
  /**
   * Signs an x402 payment payload for the given requirement and returns the
   * value to send as the X-PAYMENT header. In production this wraps a wallet
   * (e.g. Coinbase CDP / viem signer); the gateway itself never holds raw keys.
   */
  signPayment: (ctx: PaymentContext) => Promise<string>;
}

/**
 * x402 rail adapter. The x402 flow is: client gets HTTP 402 with payment
 * requirements, signs a stablecoin payment authorization, and retries the
 * request with the signed payload in the X-PAYMENT header; the server (or its
 * facilitator) verifies and settles it.
 *
 * This adapter owns only the signing step — 402 parsing and the retry live in
 * the gateway, shared by all rails. Wire a real signer in via `signPayment`.
 */
export class X402Rail implements PaymentRail {
  readonly name = "x402";

  constructor(private readonly config: X402RailConfig) {}

  supports(network: string): boolean {
    return this.config.networks.includes(network);
  }

  async pay(ctx: PaymentContext): Promise<PaymentReceipt> {
    const proof = await this.config.signPayment(ctx);
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
