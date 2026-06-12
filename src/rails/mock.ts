import { randomUUID } from "node:crypto";
import type { PaymentContext, PaymentReceipt } from "../types.js";
import type { PaymentRail } from "./rail.js";

export interface MockRailOptions {
  /** Rail name, e.g. "mock-alipay". Defaults to "mock". */
  name?: string;
  /** Networks this instance settles, defaults to [name]. */
  networks?: string[];
}

/**
 * Instant in-process rail for development and demos. Instantiate several with
 * different names to simulate a multi-rail deployment (mock x402, mock
 * Alipay, ...). Proofs have the form "<name>:<uuid>", which the demo paid-API
 * accepts as settled payment.
 */
export class MockRail implements PaymentRail {
  readonly name: string;
  private readonly networks: string[];

  constructor(options: MockRailOptions = {}) {
    this.name = options.name ?? "mock";
    this.networks = options.networks ?? [this.name];
  }

  supports(network: string): boolean {
    return this.networks.includes(network);
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
      proof: `${this.name}:${randomUUID()}`,
    };
  }
}
