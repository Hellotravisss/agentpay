import { createServer, type Server } from "node:http";

/**
 * A toy x402-style merchant: every route costs money. Requests without a
 * valid X-PAYMENT header get 402 + payment requirements; requests with a
 * mock-rail proof get the content. Used by run-demo.ts and the e2e test.
 */
export interface PaidRoute {
  path: string;
  amount: string;
  payTo: string;
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
    if (typeof payment === "string" && payment.startsWith("mock:")) {
      res.statusCode = 200;
      return res.end(JSON.stringify(route.body));
    }

    res.statusCode = 402;
    res.end(
      JSON.stringify({
        x402Version: 1,
        accepts: [
          {
            scheme: "exact",
            network: "mock",
            amount: route.amount,
            currency: "USDC",
            payTo: route.payTo,
            resource: `http://localhost${route.path}`,
            description: `Access to ${route.path}`,
          },
        ],
      }),
    );
  });
}
