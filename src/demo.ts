#!/usr/bin/env node
/**
 * `npx -p agentpay-gateway agentpay-demo` — a zero-setup playground for the
 * framework examples: a gateway (mock rails, no real money) on :4020 and a toy
 * paid API on :4021 whose three endpoints land on the three policy outcomes.
 */
import { createServer } from "node:http";
import { createGateway } from "./gateway/server.js";
import { MockRail } from "./rails/mock.js";
import { FixedRateProvider } from "./fx/rates.js";

const GATEWAY_PORT = Number(process.env.PORT ?? 4020);
const MERCHANT_PORT = Number(process.env.MERCHANT_PORT ?? 4021);

/** price in USDC per endpoint, chosen to hit allow / hold / deny under the demo policy. */
const ROUTES: Record<string, { price: string; body: unknown }> = {
  "/weather": { price: "0.05", body: { city: "Vancouver", forecast: "rain", tempC: 11 } },
  "/market-report": { price: "0.50", body: { report: "Agent payments grew 4x quarter over quarter (demo data)." } },
  "/dataset": { price: "5.00", body: { rows: 1_000_000 } },
};

const merchant = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://demo.local").pathname;
  const route = ROUTES[path];
  res.setHeader("content-type", "application/json");
  if (!route) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not_found", try: Object.keys(ROUTES) }));
  }
  if (typeof req.headers["x-payment"] === "string" && req.headers["x-payment"].startsWith("mock:")) {
    return res.end(JSON.stringify(route.body));
  }
  res.statusCode = 402;
  res.end(
    JSON.stringify({
      x402Version: 1,
      accepts: [{ scheme: "exact", network: "mock", amount: route.price, currency: "USDC", payTo: "demo-merchant", resource: path }],
    }),
  );
});

const { server } = createGateway({
  policyConfig: {
    fxRates: { "USDC:USD": "1" },
    agents: [
      {
        agentId: "demo-agent",
        enabled: true,
        currency: "USD",
        perTransactionMax: "1.00",
        dailyBudget: "2.00",
        requireApprovalOver: "0.25",
      },
    ],
  },
  rails: [new MockRail()],
  rates: new FixedRateProvider({ "USDC:USD": "1" }),
  allowPrivateTargets: true, // the demo merchant is on localhost; never enable this in production
});

merchant.listen(MERCHANT_PORT, "127.0.0.1", () => {
  server.listen(GATEWAY_PORT, "127.0.0.1", () => {
    const m = `http://127.0.0.1:${MERCHANT_PORT}`;
    console.log(`agentpay demo — mock settlement, no real money moves

  gateway    http://127.0.0.1:${GATEWAY_PORT}   (dashboard: /admin)
  agent id   demo-agent   cap $1.00/tx · $2.00/day · human approval at $0.25+

  paid endpoints to try:
    ${m}/weather        $0.05  → paid
    ${m}/market-report  $0.50  → held for approval
    ${m}/dataset        $5.00  → denied (over the per-transaction cap)

  MCP agents: AGENTPAY_URL=http://127.0.0.1:${GATEWAY_PORT} AGENTPAY_AGENT_ID=demo-agent npx -y -p agentpay-gateway agentpay-mcp
`);
  });
});
