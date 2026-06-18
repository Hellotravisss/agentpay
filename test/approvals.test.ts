import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { FixedRateProvider } from "../src/fx/rates.js";
import { MockRail } from "../src/rails/mock.js";
import { ApprovalStore } from "../src/approvals/approvals.js";
import { createPaidApi } from "../demo/paid-api.js";
import type { PaymentRequirement } from "../src/types.js";

let paidApi: Server;
let gateway: Gateway;
let paidUrl: string;
let gatewayUrl: string;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

beforeAll(async () => {
  paidApi = createPaidApi([
    { path: "/cheap", options: [{ network: "mock", amount: "0.05", currency: "USDC", payTo: "m" }], body: { ok: true } },
    { path: "/pricey", options: [{ network: "mock", amount: "1.00", currency: "USDC", payTo: "m" }], body: { ok: true } },
  ]);
  paidUrl = await listen(paidApi);

  gateway = createGateway({
    policyConfig: {
      agents: [
        { agentId: "buyer", enabled: true, currency: "USD", perTransactionMax: "10", dailyBudget: "100", requireApprovalOver: "0.50" },
      ],
    },
    rails: [new MockRail()],
    rates: new FixedRateProvider({ "USDC:USD": "1" }),
    allowPrivateTargets: true,
  });
  gatewayUrl = await listen(gateway.server);
});

afterAll(() => {
  paidApi.close();
  gateway.server.close();
});

function proxy(path: string): Promise<Response> {
  return fetch(`${gatewayUrl}/proxy?url=${encodeURIComponent(paidUrl + path)}`, { headers: { "x-agent-id": "buyer" } });
}
function decide(id: string, decision: "approve" | "reject"): Promise<Response> {
  return fetch(`${gatewayUrl}/admin/approvals/${id}`, { method: "POST", body: JSON.stringify({ decision }) });
}

describe("human-in-the-loop approvals (gateway)", () => {
  it("auto-executes payments below the approval threshold", async () => {
    const res = await proxy("/cheap");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-payment-amount")).toBe("0.05 USDC");
  });

  it("holds a payment at/over the threshold and executes it after approval", async () => {
    const held = await proxy("/pricey");
    expect(held.status).toBe(202);
    const { status, approvalId } = (await held.json()) as { status: string; approvalId: string };
    expect(status).toBe("held_for_approval");
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "payment_held", agentId: "buyer" });

    const pending = await (await fetch(`${gatewayUrl}/admin/approvals?status=pending`)).json() as { approvals: unknown[] };
    expect(pending.approvals).toHaveLength(1);

    // Retrying while still pending does not pay.
    const stillPending = await proxy("/pricey");
    expect(stillPending.status).toBe(202);
    expect(((await stillPending.json()) as { status: string }).status).toBe("awaiting_approval");

    const decided = await decide(approvalId, "approve");
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as { approval: unknown }).approval).toMatchObject({ status: "approved" });
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "payment_approved" });

    // Now the retry executes.
    const paid = await proxy("/pricey");
    expect(paid.status).toBe(200);
    expect(paid.headers.get("x-gateway-payment-amount")).toBe("1.00 USDC");
  });

  it("consumes an approval exactly once (a later payment is held again)", async () => {
    const again = await proxy("/pricey");
    expect(again.status).toBe(202);
    expect(((await again.json()) as { status: string }).status).toBe("held_for_approval");
  });

  it("denies the retry when a reviewer rejects", async () => {
    const held = await proxy("/pricey"); // matches the still-pending hold from the previous test
    const { approvalId } = (await held.json()) as { approvalId: string };
    const rej = await decide(approvalId, "reject");
    expect(((await rej.json()) as { approval: unknown }).approval).toMatchObject({ status: "rejected" });

    const blocked = await proxy("/pricey");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ rule: "approval_rejected" });
  });

  it("rejects a bad decision and an unknown id", async () => {
    expect((await decide("nope", "approve")).status).toBe(404);
    const held = await proxy("/pricey");
    const { approvalId } = (await held.json()) as { approvalId: string };
    const bad = await fetch(`${gatewayUrl}/admin/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision: "maybe" }) });
    expect(bad.status).toBe(400);
  });
});

describe("ApprovalStore (unit)", () => {
  const req: PaymentRequirement = { scheme: "exact", network: "mock", amount: "1.00", currency: "USDC", payTo: "m", resource: "http://x" };

  it("matches a payment, decides once, and consumes once", () => {
    let t = 0;
    const store = new ApprovalStore(undefined, () => t);
    const a = store.create("bot", req, "1", "USD");
    expect(store.findMatch("bot", req)?.id).toBe(a.id);

    t = 1;
    expect(store.decide(a.id, "approved")?.status).toBe("approved");
    expect(store.decide(a.id, "rejected")).toBeUndefined(); // already decided

    t = 2;
    store.consume(a.id);
    expect(store.findMatch("bot", req)).toBeUndefined(); // consumed → no longer actionable
  });
});
