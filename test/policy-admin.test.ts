import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { PolicyManager, validateAgentPolicy } from "../src/policy/manager.js";
import { MockRail } from "../src/rails/mock.js";
import { createPaidApi } from "../demo/paid-api.js";
import type { PolicyConfig } from "../src/types.js";

describe("PolicyManager (unit)", () => {
  const base: PolicyConfig = { defaults: { currency: "USD" }, agents: [{ agentId: "a", enabled: true, currency: "USD" }] };

  it("upsert and remove call persist and update resolution", () => {
    const persist = vi.fn();
    const m = new PolicyManager(structuredClone(base), persist);
    m.upsertAgent({ agentId: "b", enabled: true, currency: "USD", dailyBudget: "5" });
    expect(m.resolve("b")?.dailyBudget).toBe("5");
    expect(persist).toHaveBeenCalledTimes(1);

    expect(m.removeAgent("b")).toBe(true);
    expect(m.resolve("b")).toBeUndefined();
    expect(m.removeAgent("nope")).toBe(false);
    expect(persist).toHaveBeenCalledTimes(2); // only the successful remove
  });

  it("listResolved applies defaults", () => {
    const m = new PolicyManager(structuredClone(base));
    expect(m.listResolved()).toEqual([{ agentId: "a", enabled: true, currency: "USD" }]);
  });

  it("reload no-ops on identical content and applies real changes", () => {
    const m = new PolicyManager(structuredClone(base));
    expect(m.reload(structuredClone(base))).toBe(false);
    const next: PolicyConfig = { ...base, agents: [{ agentId: "a", enabled: false, currency: "USD" }] };
    expect(m.reload(next)).toBe(true);
    expect(m.resolve("a")?.enabled).toBe(false);
  });
});

describe("validateAgentPolicy", () => {
  it("accepts a well-formed policy and fills the id from the path", () => {
    const p = validateAgentPolicy({ currency: "USD", dailyBudget: "10.00", maxTransactionsPerDay: 5, railPreference: ["x402"] }, "bot");
    expect(p).toMatchObject({ agentId: "bot", enabled: true, currency: "USD", dailyBudget: "10.00", maxTransactionsPerDay: 5, railPreference: ["x402"] });
  });
  it("rejects bad input", () => {
    expect(() => validateAgentPolicy({ dailyBudget: "10" }, "bot")).toThrow(/currency/);
    expect(() => validateAgentPolicy({ currency: "USD", dailyBudget: "1.2.3" }, "bot")).toThrow(/dailyBudget|decimal/);
    expect(() => validateAgentPolicy({ currency: "USD", agentId: "other" }, "bot")).toThrow(/match/);
    expect(() => validateAgentPolicy({ currency: "USD", maxTransactionsPerDay: -1 }, "bot")).toThrow(/integer/);
    expect(() => validateAgentPolicy({ currency: "USD", maxTransactionsPerDay: [5] }, "bot")).toThrow(/number/); // arrays/objects rejected, not coerced
  });
});

describe("policy admin API (gateway)", () => {
  let paidApi: Server, gateway: Gateway, paidUrl: string, gatewayUrl: string, manager: PolicyManager;
  const listen = (s: Server): Promise<string> =>
    new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
  const proxy = (agent: string) =>
    fetch(`${gatewayUrl}/proxy?url=${encodeURIComponent(paidUrl + "/x")}`, { headers: { "x-agent-id": agent } });

  beforeAll(async () => {
    paidApi = createPaidApi([{ path: "/x", options: [{ network: "mock", amount: "0.05", currency: "USD", payTo: "m" }], body: { ok: true } }]);
    paidUrl = await listen(paidApi);
    manager = new PolicyManager({ agents: [] });
    gateway = createGateway({ policyManager: manager, rails: [new MockRail()], allowPrivateTargets: true });
    gatewayUrl = await listen(gateway.server);
  });
  afterAll(() => { paidApi.close(); gateway.server.close(); });

  it("creates an agent via PUT, then it can spend", async () => {
    expect((await proxy("newbot")).status).toBe(403); // deny-by-default before it exists

    const put = await fetch(`${gatewayUrl}/admin/agents/newbot`, {
      method: "PUT", body: JSON.stringify({ currency: "USD", perTransactionMax: "1.00", dailyBudget: "5.00" }),
    });
    expect(put.status).toBe(200);
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "policy_changed", agentId: "newbot" });

    const paid = await proxy("newbot");
    expect(paid.status).toBe(200);
    expect(paid.headers.get("x-gateway-payment-amount")).toBe("0.05 USD");
  });

  it("rejects an invalid policy with 400", async () => {
    const res = await fetch(`${gatewayUrl}/admin/agents/bad`, { method: "PUT", body: JSON.stringify({ dailyBudget: "5" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_policy");
  });

  it("deletes an agent and it can no longer spend", async () => {
    expect((await fetch(`${gatewayUrl}/admin/agents/newbot`, { method: "DELETE" })).status).toBe(200);
    expect((await proxy("newbot")).status).toBe(403);
    expect((await fetch(`${gatewayUrl}/admin/agents/newbot`, { method: "DELETE" })).status).toBe(404); // already gone
  });

  it("reflects a hot-reload through the admin API", async () => {
    manager.reload({ agents: [{ agentId: "reloaded", enabled: true, currency: "USD", dailyBudget: "9.00" }] });
    const { agents } = (await (await fetch(`${gatewayUrl}/admin/agents`)).json()) as { agents: Array<{ agentId: string }> };
    expect(agents.map((a) => a.agentId)).toEqual(["reloaded"]);
    const policy = (await (await fetch(`${gatewayUrl}/admin/policy`)).json()) as PolicyConfig;
    expect(policy.agents).toHaveLength(1);
  });
});
