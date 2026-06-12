import { createServer, type Server } from "node:http";

/**
 * A toy multi-rail merchant: every route costs money and may accept several
 * payment options (e.g. USDC on an x402-style network AND CNY on an
 * Alipay-style network). Requests without a valid X-PAYMENT header get 402 +
 * the full accepts list; requests with a mock-rail proof get the content.
 * Used by run-demo.ts and the e2e test.
 */
export interface PaidOption {
  network: string;
  amount: string;
  currency: string;
  payTo: string;
}

export interface PaidRoute {
  path: string;
  options: PaidOption[];
  body: unknown;
}

export function createPaidApi(routes: PaidRoute[]): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://paid.local");
    const route = routes.find((r) => r.path === url.pathname);
    res.setHeader("content-type", "application/json");

    if (!route) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not_found" }));
    }

    const payment = req.headers["x-payment"];
    if (typeof payment === "string" && /^[\w-]+:/.test(payment)) {
      res.statusCode = 200;
      return res.end(JSON.stringify(route.body));
    }

    res.statusCode = 402;
    res.end(
      JSON.stringify({
        x402Version: 1,
        accepts: route.options.map((o) => ({
          scheme: "exact",
          network: o.network,
          amount: o.amount,
          currency: o.currency,
          payTo: o.payTo,
          resource: `http://localhost${route.path}`,
          description: `Access to ${route.path}`,
        })),
      }),
    );
  });
}
