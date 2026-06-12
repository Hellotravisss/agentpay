import { describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentContext } from "../src/types.js";
import { X402Rail } from "../src/rails/x402.js";
import { CHAIN_IDS, createEip3009Signer, decodeXPayment, DEFAULT_USDC, EIP3009_TYPES } from "../src/rails/x402-signer.js";

// throwaway key, never funded — do not reuse
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C" as const;
const T0 = Date.UTC(2026, 5, 12, 12, 0, 0);

const ctx: PaymentContext = {
  agentId: "research-bot",
  timestamp: T0,
  requirement: {
    scheme: "exact",
    network: "base-sepolia",
    amount: "0.05",
    currency: "USDC",
    payTo: PAY_TO,
    resource: "https://api.example.com/weather",
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  },
};

describe("x402 EIP-3009 signer", () => {
  it("produces a verifiable transferWithAuthorization signature", async () => {
    const signer = createEip3009Signer({ privateKey: PRIVATE_KEY, now: () => T0 });
    const rail = new X402Rail({ networks: ["base-sepolia"], signPayment: signer });
    expect(rail.supports("base-sepolia")).toBe(true);

    const receipt = await rail.pay(ctx);
    const payment = decodeXPayment(receipt.proof);

    expect(payment).toMatchObject({ x402Version: 1, scheme: "exact", network: "base-sepolia" });
    const auth = payment.payload.authorization;
    const account = privateKeyToAccount(PRIVATE_KEY);
    expect(auth.from).toBe(account.address);
    expect(auth.to).toBe(PAY_TO);
    expect(auth.value).toBe("50000"); // 0.05 USDC in 6-dp atomic units
    expect(auth.validBefore).toBe(String(Math.floor(T0 / 1000) + 300));
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/);

    // the signature must recover to the treasury address under the USDC EIP-712 domain
    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: "USDC",
        version: "2",
        chainId: CHAIN_IDS["base-sepolia"]!,
        verifyingContract: DEFAULT_USDC["base-sepolia"]!,
      },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: payment.payload.signature,
    });
    expect(valid).toBe(true);
  });

  it("uses unique nonces per payment", async () => {
    const signer = createEip3009Signer({ privateKey: PRIVATE_KEY });
    const [a, b] = await Promise.all([signer(ctx), signer(ctx)]);
    expect(decodeXPayment(a).payload.authorization.nonce).not.toBe(decodeXPayment(b).payload.authorization.nonce);
  });

  it("rejects unknown networks", async () => {
    const signer = createEip3009Signer({ privateKey: PRIVATE_KEY });
    await expect(
      signer({ ...ctx, requirement: { ...ctx.requirement, network: "dogechain" } }),
    ).rejects.toThrow(/Unknown x402 network/);
  });
});
