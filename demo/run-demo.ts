import { readFileSync } from "node:fs";
import type { PolicyConfig } from "../src/types.js";
import { createGateway } from "../src/gateway/server.js";
import { MockRail } from "../src/rails/mock.js";
import { createPaidApi } from "./paid-api.js";

/**
 * End-to-end walkthrough: an agent buys paid API responses through the
 * gateway and runs into each guardrail in turn. Run with `npm run demo`.
 */
const PAID_PORT = 4021;
const GATEWAY_PORT = 4020;

const paidApi = createPaidApi([
  { path: "/weather", amount: "0.05", payTo: "merchant-weather", body: { city: "Shanghai", tempC: 27, sky: "clear" } },
  { path: "/report", amount: "5.00", payTo: "merchant-weather", body: { report: "42 pages of premium market analysis" } },
  { path: "/gossip", amount: "0.01", payTo: "merchant-shady", body: { gossip: "you don't want this" } },
]);

const policyConfig = JSON.parse(
  readFileSync(new URL("../policies/example.json", import.meta.url), "utf8"),
) as PolicyConfig;

const gateway = createGateway({ policyConfig, rails: [new MockRail()] });

async function callViaGateway(agentId: string, path: string): Promise<void> {
  const target = encodeURIComponent(`http://localhost:${PAID_PORT}${path}`);
  const res = await fetch(`http://localhost:${GATEWAY_PORT}/proxy?url=${target}`, {
    headers: { "x-agent-id": agentId },
  });
  const body = await res.json();
  const paid = res.headers.get("x-gateway-payment-amount");
  console.log(`  [${agentId}] GET ${path} -> ${res.status}${paid ? ` (paid ${paid})` : ""}`);
  console.log(`    ${JSON.stringify(body)}`);
}

async function main(): Promise<void> {
  await new Promise<void>((r) => paidApi.listen(PAID_PORT, r));
  await new Promise<void>((r) => gateway.server.listen(GATEWAY_PORT, r));

  console.log("\n1. Allowed purchase — within all limits:");
  await callViaGateway("research-bot", "/weather");

  console.log("\n2. Blocked — exceeds the agent's per-transaction max (0.25 USDC):");
  await callViaGateway("research-bot", "/report");

  console.log("\n3. Blocked — payee is on the agent's blocklist:");
  await callViaGateway("research-bot", "/gossip");

  console.log("\n4. Daily budget (0.15 USDC) runs out after the 3rd 0.05 purchase:");
  await callViaGateway("research-bot", "/weather");
  await callViaGateway("research-bot", "/weather");
  await callViaGateway("research-bot", "/weather");

  console.log("\n5. Unknown agent — denied by default, nothing moves without a policy:");
  await callViaGateway("rogue-bot", "/weather");

  console.log("\n6. Spend dashboard (GET /admin/spend/research-bot):");
  const spend = await fetch(`http://localhost:${GATEWAY_PORT}/admin/spend/research-bot`);
  console.log(`  ${JSON.stringify(await spend.json(), null, 2).replace(/\n/g, "\n  ")}`);

  console.log("\n7. Audit trail (GET /admin/audit) — every decision, denials included:");
  for (const e of gateway.audit.tail(20)) {
    const what =
      e.event === "payment_executed"
        ? `${(e.details.receipt as { amount: string }).amount} USDC -> ${(e.details.receipt as { payTo: string }).payTo}`
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
