import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { ApiKeyStore } from "../src/auth/keys.js";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { PolicyManager } from "../src/policy/manager.js";
import { MockRail } from "../src/rails/mock.js";
import { openStore } from "../src/store/store.js";
import { createPaidApi } from "../demo/paid-api.js";
import type { ApiKey } from "../src/types.js";

describe("ApiKeyStore (unit)", () => {
  const tmps: string[] = [];
  afterEach(() => { for (const p of tmps.splice(0)) rmSync(p, { force: true }); });

  it("mints a key, verifies it, and never exposes the secret or hash", () => {
    const s = new ApiKeyStore();
    const { apiKey, secret } = s.create("ci", "bot");
    expect(secret).toMatch(/^ak_/);
    expect(apiKey).not.toHaveProperty("hash");
    expect(JSON.stringify(s.list())).not.toContain("hash");
    expect(s.verify(secret)).toBe("bot");
    expect(s.verify("ak_wrong")).toBeUndefined();
  });

  it("stops verifying once revoked", () => {
    const s = new ApiKeyStore();
    const { apiKey, secret } = s.create("k", "bot");
    expect(s.revoke(apiKey.id)).toBe(true);
    expect(s.verify(secret)).toBeUndefined();
    expect(s.revoke(apiKey.id)).toBe(false); // already revoked
  });

  it("honors expiry against the injected clock", () => {
    let t = 1000;
    const s = new ApiKeyStore(undefined, () => t);
    const { secret } = s.create("k", "bot", { expiresAt: 2000 });
    expect(s.verify(secret)).toBe("bot");
    t = 2000;
    expect(s.verify(secret)).toBeUndefined();
  });

  it("survives a restart via its store (hash persisted, secret not)", () => {
    const path = join(tmpdir(), `agentpay-keys-${process.pid}.sqlite`);
    tmps.push(path);
    const { secret } = new ApiKeyStore(openStore<ApiKey>(path, "apikeys")).create("k", "bot");
    const reopened = new ApiKeyStore(openStore<ApiKey>(path, "apikeys"));
    expect(reopened.verify(secret)).toBe("bot");
  });
});

describe("API keys admin + auth (gateway)", () => {
  let paidApi: Server, gateway: Gateway, paidUrl: string, gatewayUrl: string;
  const listen = (s: Server): Promise<string> =>
    new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
  const proxyWith = (headers: Record<string, string>) =>
    fetch(`${gatewayUrl}/proxy?url=${encodeURIComponent(paidUrl + "/x")}`, { headers });

  beforeAll(async () => {
    paidApi = createPaidApi([{ path: "/x", options: [{ network: "mock", amount: "0.05", currency: "USD", payTo: "m" }], body: { ok: true } }]);
    paidUrl = await listen(paidApi);
    gateway = createGateway({
      policyManager: new PolicyManager({ agents: [{ agentId: "buyer", enabled: true, currency: "USD", dailyBudget: "5" }] }),
      rails: [new MockRail()],
      requireApiKey: true, // X-Agent-Id is rejected; only a valid Bearer key works
      allowPrivateTargets: true,
    });
    gatewayUrl = await listen(gateway.server);
  });
  afterAll(() => { paidApi.close(); gateway.server.close(); });

  it("rejects X-Agent-Id when requireApiKey is set", async () => {
    expect((await proxyWith({ "x-agent-id": "buyer" })).status).toBe(401);
  });

  it("mints a key (secret shown once) that then authenticates", async () => {
    const res = await fetch(`${gatewayUrl}/admin/keys`, { method: "POST", body: JSON.stringify({ agentId: "buyer", label: "ci" }) });
    expect(res.status).toBe(201);
    const { apiKey, secret } = (await res.json()) as { apiKey: ApiKey; secret: string };
    expect(secret).toMatch(/^ak_/);
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "apikey_created", agentId: "buyer" });

    const paid = await proxyWith({ authorization: `Bearer ${secret}` });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("x-gateway-payment-amount")).toBe("0.05 USD");

    // revoke → the same key stops working
    expect((await fetch(`${gatewayUrl}/admin/keys/${apiKey.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await proxyWith({ authorization: `Bearer ${secret}` })).status).toBe(401);
    expect(gateway.audit.tail().at(-1)).toMatchObject({ event: "apikey_revoked" });
  });

  it("refuses to mint a key for an unknown agent", async () => {
    const res = await fetch(`${gatewayUrl}/admin/keys`, { method: "POST", body: JSON.stringify({ agentId: "ghost" }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_agent");
  });

  it("lists keys without secrets or hashes", async () => {
    const { keys } = (await (await fetch(`${gatewayUrl}/admin/keys`)).json()) as { keys: ApiKey[] };
    expect(keys.length).toBeGreaterThan(0);
    expect(JSON.stringify(keys)).not.toMatch(/hash|secret|ak_/);
  });
});
