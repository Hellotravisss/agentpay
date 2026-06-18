import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { FixedRateProvider } from "../src/fx/rates.js";
import { MockRail } from "../src/rails/mock.js";
import { createPaidApi } from "../demo/paid-api.js";

let paidApi: Server;
let gateway: Gateway;
let paidUrl: string;
let gatewayUrl: string;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  paidApi = createPaidApi([
    {
      path: "/weather",
      options: [
        { network: "mock", amount: "0.05", currency: "USDC", payTo: "merchant-weather" },
        { network: "mock-alipay", amount: "0.36", currency: "CNY", payTo: "merchant-weather" },
      ],
      body: { ok: true },
    },
    {
      path: "/expensive",
      options: [{ network: "mock", amount: "9.00", currency: "USDC", payTo: "merchant-weather" }],
      body: { ok: true },
    },
  ]);
  paidUrl = await listen(paidApi);

  gateway = createGateway({
    policyConfig: {
      agents: [
        {
          agentId: "bot",
          enabled: true,
          currency: "USD",
          railPreference: ["mock-alipay", "mock"],
          perTransactionMax: "1.00",
          dailyBudget: "0.12",
        },
        { agentId: "ops", enabled: true, currency: "USD", railPreference: ["mock"], dailyBudget: "1.00" },
      ],
    },
    rails: [new MockRail(), new MockRail({ name: "mock-alipay" })],
    rates: new FixedRateProvider({ "USDC:USD": "1", "CNY:USD": "0.14" }),
    apiKeys: { "secret-key": "bot", "ops-key": "ops" },
    allowPrivateTargets: true,
  });
  gatewayUrl = await listen(gateway.server);
});

afterAll(() => {
  paidApi.close();
  gateway.server.close();
});

function proxy(path: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${gatewayUrl}/proxy?url=${encodeURIComponent(paidUrl + path)}`, { headers });
}

const asBot = { authorization: "Bearer secret-key" };

describe("gateway end to end", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await proxy("/weather", {});
    expect(res.status).toBe(401);
  });

  it("rejects unknown API keys", async () => {
    const res = await proxy("/weather", { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("routes by rail preference, completes the 402 handshake, and audits it", async () => {
    const res = await proxy("/weather", asBot);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-gateway-rail")).toBe("mock-alipay");
    expect(res.headers.get("x-gateway-payment-amount")).toBe("0.36 CNY");
    const last = gateway.audit.tail().at(-1);
    expect(last).toMatchObject({ event: "payment_executed", agentId: "bot" });
    expect((last?.details.receipt as { baseAmount: string }).baseAmount).toBe("0.0504");
  });

  it("routes a different agent to its preferred rail", async () => {
    const res = await proxy("/weather", { authorization: "Bearer ops-key" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-rail")).toBe("mock");
    expect(res.headers.get("x-gateway-payment-amount")).toBe("0.05 USDC");
  });

  it("denies over per-transaction max with the violated rule", async () => {
    const res = await proxy("/expensive", asBot);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "payment_denied", rule: "per_transaction_max" });
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "payment_denied" });
  });

  it("exhausts the unified USD daily budget across CNY payments", async () => {
    const second = await proxy("/weather", asBot); // total 0.1008 USD of 0.12
    expect(second.status).toBe(200);
    const third = await proxy("/weather", asBot); // 0.1512 > 0.12
    expect(third.status).toBe(403);
    expect(await third.json()).toMatchObject({ rule: "daily_budget" });
  });

  it("reports unified spend with a per-rail breakdown", async () => {
    const res = await fetch(`${gatewayUrl}/admin/spend/bot`);
    const body = await res.json();
    expect(body).toMatchObject({
      agentId: "bot",
      currency: "USD",
      spentToday: "0.1008",
      transactionsToday: 2,
      perRail: { "mock-alipay": { transactions: 2, amounts: { CNY: "0.72" } } },
    });
  });

  it("passes non-402 responses straight through", async () => {
    const res = await proxy("/nope", asBot);
    expect(res.status).toBe(404);
  });

  it("serves the dashboard HTML and lists agents", async () => {
    const page = await fetch(`${gatewayUrl}/admin`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("agentpay");

    const agents = (await (await fetch(`${gatewayUrl}/admin/agents`)).json()) as { agents: Array<{ agentId: string }> };
    expect(agents.agents.map((a) => a.agentId)).toEqual(["bot", "ops"]);
  });
});
