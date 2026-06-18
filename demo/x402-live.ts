import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createGateway } from "../src/gateway/server.js";
import { X402Rail } from "../src/rails/x402.js";
import { createEip3009Signer } from "../src/rails/x402-signer.js";

/**
 * Live x402 flow against a REAL paid endpoint on Base Sepolia.
 *
 * Prerequisites:
 *   1. A throwaway wallet funded with Base Sepolia testnet USDC
 *      (faucet: https://faucet.circle.com — select Base Sepolia).
 *   2. An x402-protected URL to buy (any merchant settling on base-sepolia;
 *      see https://www.x402.org for live endpoints).
 *
 * Run:
 *   X402_PRIVATE_KEY=0x... TARGET_URL=https://... npx tsx demo/x402-live.ts
 */
const privateKey = process.env.X402_PRIVATE_KEY as Hex | undefined;
const targetUrl = process.env.TARGET_URL;

if (!privateKey || !targetUrl) {
  console.error("Usage: X402_PRIVATE_KEY=0x... TARGET_URL=https://... npx tsx demo/x402-live.ts");
  process.exit(1);
}

const gateway = createGateway({
  policyConfig: {
    agents: [
      {
        agentId: "live-bot",
        enabled: true,
        currency: "USDC",
        perTransactionMax: "0.10",
        dailyBudget: "0.50",
      },
    ],
  },
  rails: [
    new X402Rail({
      networks: ["base-sepolia"],
      signPayment: createEip3009Signer({ privateKey }),
    }),
  ],
  allowPrivateTargets: true, // the reproducible recipe points at a local x402 merchant
});

const PORT = 4020;
gateway.server.listen(PORT, async () => {
  console.log(`treasury wallet: ${privateKeyToAccount(privateKey).address}`);
  console.log(`buying ${targetUrl} through the gateway as "live-bot" (max 0.10 USDC/tx)...\n`);

  const res = await fetch(`http://localhost:${PORT}/proxy?url=${encodeURIComponent(targetUrl)}`, {
    headers: { "x-agent-id": "live-bot" },
  });
  console.log(`status: ${res.status}`);
  console.log(`rail:   ${res.headers.get("x-gateway-rail") ?? "-"}`);
  console.log(`paid:   ${res.headers.get("x-gateway-payment-amount") ?? "-"}`);
  console.log(await res.text());

  console.log("\naudit trail:");
  for (const e of gateway.audit.tail(10)) {
    console.log(`  ${new Date(e.timestamp).toISOString()}  ${e.event}  ${JSON.stringify(e.details)}`);
  }
  gateway.server.close();
});
