import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGateway, type Gateway } from "../src/gateway/server.js";
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
    { path: "/weather", amount: "0.05", payTo: "merchant-weather", body: { ok: true } },
    { path: "/expensive", amount: "9.00", payTo: "merchant-weather", body: { ok: true } },
  ]);
  paidUrl = await listen(paidApi);

  gateway = createGateway({
    policyConfig: {
      agents: [
        { agentId: "bot", enabled: true, currency: "USDC", perTransactionMax: "1.00", dailyBudget: "0.12" },
      ],
    },
    rails: [new MockRail()],
    apiKeys: { "secret-key": "bot" },
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

  it("completes the 402 handshake within policy and audits it", async () => {
    const res = await proxy("/weather", asBot);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-gateway-payment-amount")).toBe("0.05 USDC");
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "payment_executed", agentId: "bot" });
  });

  it("denies over per-transaction max with the violated rule", async () => {
    const res = await proxy("/expensive", asBot);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "payment_denied", rule: "per_transaction_max" });
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "payment_denied" });
  });

  it("exhausts the daily budget across requests", async () => {
    const second = await proxy("/weather", asBot); // total 0.10 of 0.12
    expect(second.status).toBe(200);
    const third = await proxy("/weather", asBot); // 0.15 > 0.12
    expect(third.status).toBe(403);
    expect(await third.json()).toMatchObject({ rule: "daily_budget" });
  });

  it("reports spend on the admin endpoint", async () => {
    const res = await fetch(`${gatewayUrl}/admin/spend/bot`);
    const body = await res.json();
    expect(body).toMatchObject({ agentId: "bot", spentToday: "0.1", transactionsToday: 2 });
  });

  it("passes non-402 responses straight through", async () => {
    const res = await proxy("/nope", asBot);
    expect(res.status).toBe(404);
  });
});
