import { readFileSync } from "node:fs";
import type { PolicyConfig } from "./types.js";
import { createGateway } from "./gateway/server.js";
import { FixedRateProvider } from "./fx/rates.js";
import { MockRail } from "./rails/mock.js";
import { SpendLedger } from "./ledger/ledger.js";
import { AuditLog } from "./audit/audit.js";

export * from "./types.js";
export * from "./money.js";
export { evaluate, resolvePolicy } from "./policy/engine.js";
export { SpendLedger, startOfUtcDay, startOfUtcMonth } from "./ledger/ledger.js";
export { AuditLog } from "./audit/audit.js";
export { createGateway, route, type Gateway, type GatewayOptions } from "./gateway/server.js";
export { FixedRateProvider, convert, type RateProvider } from "./fx/rates.js";
export { MockRail, type MockRailOptions } from "./rails/mock.js";
export { X402Rail, type X402RailConfig } from "./rails/x402.js";
export {
  createEip3009Signer,
  decodeXPayment,
  CHAIN_IDS,
  DEFAULT_USDC,
  EIP3009_TYPES,
  type Eip3009SignerOptions,
  type X402Authorization,
  type X402PaymentPayload,
} from "./rails/x402-signer.js";
export { AlipayActRail, type AlipayActRailConfig } from "./rails/alipay.js";
export type { PaymentRail } from "./rails/rail.js";

/** CLI entrypoint: `npm run dev` starts a gateway with the example policy and the mock rail. */
const isMain = process.argv[1]?.endsWith("src/index.ts") || process.argv[1]?.endsWith("dist/index.js");
if (isMain) {
  const policyPath = process.env.POLICY_FILE ?? new URL("../policies/example.json", import.meta.url).pathname;
  const policyConfig = JSON.parse(readFileSync(policyPath, "utf8")) as PolicyConfig;
  const port = Number(process.env.PORT ?? 4020);

  const { server } = createGateway({
    policyConfig,
    rails: [new MockRail(), new MockRail({ name: "mock-alipay" })],
    rates: new FixedRateProvider(policyConfig.fxRates ?? {}),
    ledger: new SpendLedger(process.env.LEDGER_FILE),
    audit: new AuditLog(process.env.AUDIT_FILE),
  });
  server.listen(port, () => {
    console.log(`agent-pay-gateway listening on http://localhost:${port}`);
    console.log(`policy file: ${policyPath}`);
  });
}
