import type { PaymentContext, PaymentReceipt, PaymentRequirement } from "../types.js";

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
  /**
   * Optional finer-grained check: can this rail actually pay *this* requirement
   * (not just its network)? Routing skips options that return false, so a
   * merchant that lists an unsupported variant first (e.g. x402 Permit2 before
   * EIP-3009) still gets paid via the option we can sign. Omit = accept all.
   */
  canPay?(requirement: PaymentRequirement): boolean;
  pay(ctx: PaymentContext): Promise<PaymentReceipt>;
}
