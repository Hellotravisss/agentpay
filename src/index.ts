import { readFileSync, watch, writeFileSync } from "node:fs";
import type { AuditEntry, PaymentReceipt, PendingApproval, PolicyConfig } from "./types.js";
import { createGateway } from "./gateway/server.js";
import { FixedRateProvider } from "./fx/rates.js";
import { MockRail } from "./rails/mock.js";
import { SpendLedger } from "./ledger/ledger.js";
import { AuditLog } from "./audit/audit.js";
import { ApprovalStore } from "./approvals/approvals.js";
import { PolicyManager } from "./policy/manager.js";
import { openStore } from "./store/store.js";

export * from "./types.js";
export * from "./money.js";
export { evaluate, resolvePolicy } from "./policy/engine.js";
export { SpendLedger, startOfUtcDay, startOfUtcMonth } from "./ledger/ledger.js";
export { AuditLog } from "./audit/audit.js";
export { ApprovalStore } from "./approvals/approvals.js";
export { PolicyManager, validateAgentPolicy } from "./policy/manager.js";
export { createGateway, route, type Gateway, type GatewayOptions } from "./gateway/server.js";
export { FixedRateProvider, convert, type RateProvider } from "./fx/rates.js";
export {
  CachingRateProvider,
  httpRateFetcher,
  type RefreshableRateProvider,
  type RateFetcher,
  type CachingRateProviderOptions,
} from "./fx/caching.js";
export { JsonlStore, SqliteStore, openStore, type RecordStore } from "./store/store.js";
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
  const readPolicy = () => JSON.parse(readFileSync(policyPath, "utf8")) as PolicyConfig;
  const policyConfig = readPolicy();
  const port = Number(process.env.PORT ?? 4020);

  // Admin-API edits write the file back (pretty-printed); the file watcher below
  // ignores those self-writes because reload() no-ops on identical content.
  const policyManager = new PolicyManager(policyConfig, (c) =>
    writeFileSync(policyPath, JSON.stringify(c, null, 2) + "\n"),
  );

  const { server, audit } = createGateway({
    policyManager,
    rails: [new MockRail(), new MockRail({ name: "mock-alipay" })],
    rates: new FixedRateProvider(policyConfig.fxRates ?? {}),
    ledger: new SpendLedger(
      process.env.LEDGER_FILE ? openStore<PaymentReceipt>(process.env.LEDGER_FILE, "receipts") : undefined,
    ),
    audit: new AuditLog(
      process.env.AUDIT_FILE ? openStore<AuditEntry>(process.env.AUDIT_FILE, "audit") : undefined,
    ),
    approvals: new ApprovalStore(
      process.env.APPROVALS_FILE ? openStore<PendingApproval>(process.env.APPROVALS_FILE, "approvals") : undefined,
    ),
  });

  // Hot-reload: pick up out-of-band edits to the policy file (debounced).
  let reloadTimer: NodeJS.Timeout | undefined;
  watch(policyPath, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        if (policyManager.reload(readPolicy())) {
          audit.log("policy_changed", "system", { action: "reload", source: policyPath });
          console.log("policy hot-reloaded from", policyPath);
        }
      } catch (err) {
        console.error("policy reload failed:", String(err));
      }
    }, 50);
  });

  server.listen(port, () => {
    console.log(`agentpay listening on http://localhost:${port}`);
    console.log(`dashboard:   http://localhost:${port}/admin`);
    console.log(`policy file: ${policyPath} (editable via API + hot-reload)`);
  });
}
