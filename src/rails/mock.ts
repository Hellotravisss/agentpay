import { randomUUID } from "node:crypto";
import type { PaymentContext, PaymentReceipt } from "../types.js";
import type { PaymentRail } from "./rail.js";

/**
 * Instant in-process rail for development and demos. Produces proofs of the
 * form "mock:<uuid>" which the demo paid-API accepts as settled payment.
 */
export class MockRail implements PaymentRail {
  readonly name = "mock";

  supports(network: string): boolean {
    return network === "mock";
  }

  async pay(ctx: PaymentContext): Promise<PaymentReceipt> {
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
      proof: `mock:${randomUUID()}`,
    };
  }
}
