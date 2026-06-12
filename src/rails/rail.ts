import type { PaymentContext, PaymentReceipt } from "../types.js";

/**
 * A payment rail executes an approved payment and returns a receipt whose
 * `proof` the upstream service will accept (sent as the X-PAYMENT header).
 *
 * The gateway only talks to rails through this interface, so adding a new
 * rail (x402 mainnet, Alipay ACT, AP2, ...) never touches policy code.
 */
export interface PaymentRail {
  readonly name: string;
  /** Networks this rail can settle on, matched against PaymentRequirement.network. */
  supports(network: string): boolean;
  pay(ctx: PaymentContext): Promise<PaymentReceipt>;
}
