import { readFileSync } from "node:fs";
import type { PolicyConfig } from "../src/types.js";
import { createGateway } from "../src/gateway/server.js";
import { FixedRateProvider } from "../src/fx/rates.js";
import { MockRail } from "../src/rails/mock.js";
import { createPaidApi } from "./paid-api.js";
import { c, banner, rule, scene, kv } from "./pretty.js";

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

/** Call a paid resource through the gateway and pretty-print the outcome. */
async function callViaGateway(agentId: string, path: string): Promise<void> {
  const target = encodeURIComponent(`http://localhost:${PAID_PORT}${path}`);
  const res = await fetch(`http://localhost:${GATEWAY_PORT}/proxy?url=${target}`, {
    headers: { "x-agent-id": agentId },
  });
  const body = (await res.json()) as Record<string, unknown>;
  const paid = res.headers.get("x-gateway-payment-amount");
  const rail = res.headers.get("x-gateway-rail");

  const tag = `${c.bold(agentId.padEnd(13))} ${c.dim("GET")} ${path.padEnd(9)}`;
  if (res.ok) {
    const note = paid ? c.green(`paid ${paid}`) + c.dim(` via ${rail}`) : "";
    console.log(`  ${c.green("✓")} ${tag} ${c.green(String(res.status))}  ${note}`);
    console.log(`    ${c.dim(JSON.stringify(body))}`);
  } else {
    const rule = (body.rule as string) ?? (body.error as string) ?? "denied";
    console.log(`  ${c.red("✗")} ${tag} ${c.red(String(res.status))}  ${c.red(rule)}`);
    console.log(`    ${c.dim((body.reason as string) ?? (body.message as string) ?? "")}`);
  }
}

async function main(): Promise<void> {
  await new Promise<void>((r) => paidApi.listen(PAID_PORT, r));
  await new Promise<void>((r) => gateway.server.listen(GATEWAY_PORT, r));

  console.log(banner("agentpay", "cross-rail spend-policy gateway for AI agent payments"));
  console.log(
    `  ${c.dim("merchant /weather accepts")} ${c.cyan("0.05 USDC")} ${c.dim("(x402-style)")} ` +
      `${c.dim("or")} ${c.cyan("0.36 CNY")} ${c.dim("(Alipay-style)")}\n` +
      `  ${c.dim("budgets are denominated in")} ${c.cyan("USD")} ${c.dim("and enforced across both rails via FX")}`,
  );

  scene(1, "Route by rail preference", "same merchant, two agents, two different rails");
  console.log(`  ${c.dim("research-bot prefers Alipay-style · ops-bot prefers x402-style")}`);
  await callViaGateway("research-bot", "/weather");
  await callViaGateway("ops-bot", "/weather");

  scene(2, "Per-transaction cap", "research-bot's max is 0.25 USD; /report costs 5 USD");
  await callViaGateway("research-bot", "/report");

  scene(3, "Payee blocklist", "blocked on any rail, regardless of price");
  await callViaGateway("research-bot", "/gossip");

  scene(4, "One USD budget across rails", "daily 0.15 USD; each 0.36 CNY buy ≈ 0.0504 USD");
  console.log(`  ${c.dim("two buys land (0.1008 USD), the third trips the shared budget")}`);
  await callViaGateway("research-bot", "/weather");
  await callViaGateway("research-bot", "/weather");

  scene(5, "Deny by default", "no policy entry means no spend — nothing moves");
  await callViaGateway("rogue-bot", "/weather");

  scene(6, "Unified spend dashboard", "GET /admin/spend/research-bot");
  const spend = (await (await fetch(`http://localhost:${GATEWAY_PORT}/admin/spend/research-bot`)).json()) as {
    currency: string;
    spentToday: string;
    spentThisMonth: string;
    transactionsToday: number;
    perRail: Record<string, { transactions: number; amounts: Record<string, string> }>;
    limits: Record<string, string | number | null>;
  };
  console.log(kv("spent today", `${c.bold(spend.spentToday)} ${spend.currency}`, `of ${spend.limits.dailyBudget} daily`));
  console.log(kv("spent this month", `${spend.spentThisMonth} ${spend.currency}`, `of ${spend.limits.monthlyBudget} monthly`));
  console.log(kv("transactions today", String(spend.transactionsToday)));
  for (const [rail, info] of Object.entries(spend.perRail)) {
    const native = Object.entries(info.amounts).map(([cur, amt]) => `${amt} ${cur}`).join(", ");
    console.log(kv(`  via ${rail}`, native, `${info.transactions} tx`));
  }

  scene(7, "Audit trail", "GET /admin/audit — every decision, denials included");
  for (const e of gateway.audit.tail(20)) {
    const r = e.details.receipt as { amount: string; currency: string; payTo: string; rail: string } | undefined;
    const what = r
      ? `${r.amount} ${r.currency} ${c.dim("→")} ${r.payTo} ${c.dim("via")} ${r.rail}`
      : c.dim((e.details.rule as string) ?? (e.details.message as string) ?? "");
    const event = e.event.startsWith("payment_executed") ? c.green(e.event.padEnd(16)) : c.red(e.event.padEnd(16));
    const time = new Date(e.timestamp).toISOString().slice(11, 19);
    console.log(`  ${c.dim(time)}  ${event} ${c.bold(e.agentId.padEnd(13))} ${what}`);
  }

  console.log("\n" + rule());
  console.log(`  ${c.green("done")} ${c.dim("— 2 rails, 2 currencies, 1 unified USD budget, full audit trail")}\n`);

  paidApi.close();
  gateway.server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
