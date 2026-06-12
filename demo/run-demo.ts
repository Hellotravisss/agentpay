import { readFileSync } from "node:fs";
import type { PolicyConfig } from "../src/types.js";
import { createGateway } from "../src/gateway/server.js";
import { FixedRateProvider } from "../src/fx/rates.js";
import { MockRail } from "../src/rails/mock.js";
import { createPaidApi } from "./paid-api.js";

/**
 * End-to-end walkthrough of the cross-rail gateway: one merchant accepts
 * both USDC (x402-style "mock" network) and CNY (Alipay-style "mock-alipay"
 * network); two agents with different rail preferences share the same kind
 * of unified USD budget. Run with `npm run demo`.
 */
const PAID_PORT = 4021;
const GATEWAY_PORT = 4020;

const weatherOptions = [
  { network: "mock", amount: "0.05", currency: "USDC", payTo: "merchant-weather" },
  { network: "mock-alipay", amount: "0.36", currency: "CNY", payTo: "merchant-weather" },
];

const paidApi = createPaidApi([
  { path: "/weather", options: weatherOptions, body: { city: "Shanghai", tempC: 27, sky: "clear" } },
  {
    path: "/report",
    options: [{ network: "mock", amount: "5.00", currency: "USDC", payTo: "merchant-weather" }],
    body: { report: "42 pages of premium market analysis" },
  },
  {
    path: "/gossip",
    options: [{ network: "mock-alipay", amount: "0.07", currency: "CNY", payTo: "merchant-shady" }],
    body: { gossip: "you don't want this" },
  },
]);

const policyConfig = JSON.parse(
  readFileSync(new URL("../policies/example.json", import.meta.url), "utf8"),
) as PolicyConfig;

const gateway = createGateway({
  policyConfig,
  rails: [new MockRail(), new MockRail({ name: "mock-alipay" })],
  rates: new FixedRateProvider(policyConfig.fxRates ?? {}),
});

async function callViaGateway(agentId: string, path: string): Promise<void> {
  const target = encodeURIComponent(`http://localhost:${PAID_PORT}${path}`);
  const res = await fetch(`http://localhost:${GATEWAY_PORT}/proxy?url=${target}`, {
    headers: { "x-agent-id": agentId },
  });
  const body = await res.json();
  const paid = res.headers.get("x-gateway-payment-amount");
  const rail = res.headers.get("x-gateway-rail");
  console.log(`  [${agentId}] GET ${path} -> ${res.status}${paid ? ` (paid ${paid} via ${rail})` : ""}`);
  console.log(`    ${JSON.stringify(body)}`);
}

async function main(): Promise<void> {
  await new Promise<void>((r) => paidApi.listen(PAID_PORT, r));
  await new Promise<void>((r) => gateway.server.listen(GATEWAY_PORT, r));

  console.log("\n1. Routing by rail preference — merchant accepts USDC or CNY;");
  console.log("   research-bot prefers mock-alipay, ops-bot prefers mock (x402-style):");
  await callViaGateway("research-bot", "/weather");
  await callViaGateway("ops-bot", "/weather");

  console.log("\n2. Blocked — exceeds research-bot's per-transaction max (0.25 USD):");
  await callViaGateway("research-bot", "/report");

  console.log("\n3. Blocked — payee is on research-bot's blocklist (any rail):");
  await callViaGateway("research-bot", "/gossip");

  console.log("\n4. ONE USD budget across rails — daily 0.15 USD; each 0.36 CNY");
  console.log("   purchase counts as ~0.0504 USD, so the 3rd purchase is denied:");
  await callViaGateway("research-bot", "/weather");
  await callViaGateway("research-bot", "/weather");

  console.log("\n5. Unknown agent — denied by default, nothing moves without a policy:");
  await callViaGateway("rogue-bot", "/weather");

  console.log("\n6. Unified spend dashboard (GET /admin/spend/research-bot) —");
  console.log("   budget in USD, per-rail breakdown in native currencies:");
  const spend = await fetch(`http://localhost:${GATEWAY_PORT}/admin/spend/research-bot`);
  console.log(`  ${JSON.stringify(await spend.json(), null, 2).replace(/\n/g, "\n  ")}`);

  console.log("\n7. Audit trail (GET /admin/audit) — every decision, denials included:");
  for (const e of gateway.audit.tail(20)) {
    const r = e.details.receipt as { amount: string; currency: string; payTo: string; rail: string } | undefined;
    const what = r
      ? `${r.amount} ${r.currency} -> ${r.payTo} via ${r.rail}`
      : (e.details.rule ?? e.details.message ?? "");
    console.log(`  ${new Date(e.timestamp).toISOString()}  ${e.event.padEnd(17)} ${e.agentId.padEnd(13)} ${what}`);
  }

  paidApi.close();
  gateway.server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
