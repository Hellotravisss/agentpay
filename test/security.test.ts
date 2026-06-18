import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { isBlockedTarget, isPrivateIp, guardedLookup } from "../src/gateway/ssrf.js";
import { safeRequest, readStreamText } from "../src/gateway/safe-fetch.js";
import { createEip3009Signer, decodeXPayment, DEFAULT_USDC } from "../src/rails/x402-signer.js";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { PolicyManager } from "../src/policy/manager.js";
import { MockRail } from "../src/rails/mock.js";
import { FixedRateProvider } from "../src/fx/rates.js";
import { createPaidApi } from "../demo/paid-api.js";
import type { PaymentContext } from "../src/types.js";

describe("SSRF guard", () => {
  it("classifies private/reserved IPs", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "172.16.5.5", "::1", "fc00::1", "fe80::1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  it("blocks loopback/metadata/localhost targets and passes a public IP", async () => {
    expect(await isBlockedTarget("http://127.0.0.1:8080/x")).toBe(true);
    expect(await isBlockedTarget("http://169.254.169.254/latest/meta-data/")).toBe(true);
    expect(await isBlockedTarget("http://localhost/admin")).toBe(true);
    expect(await isBlockedTarget("http://[::1]/")).toBe(true);
    expect(await isBlockedTarget("not a url")).toBe(true);
    expect(await isBlockedTarget("http://8.8.8.8/")).toBe(false); // literal public IP, no DNS
  });
});

describe("pinned resolution & redirect re-validation", () => {
  const call = (fn: ReturnType<typeof guardedLookup>, host: string): Promise<string> =>
    new Promise((resolve) =>
      (fn as (h: string, o: unknown, cb: (e: NodeJS.ErrnoException | null, a?: unknown) => void) => void)(
        host, { all: false }, (e, a) => resolve(e ? `ERR:${e.code}` : String(a)),
      ),
    );

  it("guardedLookup refuses a private-resolving host, passes a public IP", async () => {
    expect(await call(guardedLookup(false), "localhost")).toBe("ERR:SSRF_BLOCKED");
    expect(await call(guardedLookup(true), "localhost")).toMatch(/^(127\.0\.0\.1|::1)$/);
    expect(await call(guardedLookup(false), "8.8.8.8")).toBe("8.8.8.8");
  });

  it("safeRequest blocks a private literal-IP target (incl. cloud metadata)", async () => {
    await expect(safeRequest("http://169.254.169.254/latest/meta-data/", { timeoutMs: 2000 })).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
  });

  it("safeRequest follows redirects, re-validating each hop", async () => {
    const b = createServer((_q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ ok: true })); });
    await new Promise<void>((res) => b.listen(0, "127.0.0.1", res));
    const bUrl = `http://127.0.0.1:${(b.address() as AddressInfo).port}/b`;
    const a = createServer((_q, r) => { r.statusCode = 302; r.setHeader("location", bUrl); r.end(); });
    await new Promise<void>((res) => a.listen(0, "127.0.0.1", res));
    const aUrl = `http://127.0.0.1:${(a.address() as AddressInfo).port}/a`;
    try {
      const resp = await safeRequest(aUrl, { allowPrivateTargets: true });
      expect(resp.status).toBe(200);
      expect(JSON.parse(await readStreamText(resp.body, 10_000))).toEqual({ ok: true });
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("proxy refuses private targets by default", () => {
  let gateway: Gateway, gatewayUrl: string;
  const listen = (s: Server): Promise<string> =>
    new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeAll(async () => {
    gateway = createGateway({
      policyManager: new PolicyManager({ agents: [{ agentId: "bot", enabled: true, currency: "USD" }] }),
      rails: [new MockRail()],
      // allowPrivateTargets defaults to false
    });
    gatewayUrl = await listen(gateway.server);
  });
  afterAll(() => gateway.server.close());

  it("returns 403 blocked_target for a loopback URL", async () => {
    const res = await fetch(`${gatewayUrl}/proxy?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`, {
      headers: { "x-agent-id": "bot" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("blocked_target");
  });
});

describe("admin API authentication", () => {
  let gateway: Gateway, gatewayUrl: string;
  const listen = (s: Server): Promise<string> =>
    new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeAll(async () => {
    gateway = createGateway({
      policyManager: new PolicyManager({ agents: [] }),
      rails: [new MockRail()],
      adminToken: "s3cret-token",
    });
    gatewayUrl = await listen(gateway.server);
  });
  afterAll(() => gateway.server.close());

  it("rejects admin data endpoints without the token", async () => {
    expect((await fetch(`${gatewayUrl}/admin/keys`)).status).toBe(401);
    expect((await fetch(`${gatewayUrl}/admin/policy`)).status).toBe(401);
    expect((await fetch(`${gatewayUrl}/admin/agents`)).status).toBe(401);
  });

  it("accepts the token via Bearer or X-Admin-Token, rejects a wrong one", async () => {
    expect((await fetch(`${gatewayUrl}/admin/keys`, { headers: { authorization: "Bearer s3cret-token" } })).status).toBe(200);
    expect((await fetch(`${gatewayUrl}/admin/keys`, { headers: { "x-admin-token": "s3cret-token" } })).status).toBe(200);
    expect((await fetch(`${gatewayUrl}/admin/keys`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  });

  it("still serves the dashboard page itself without a token", async () => {
    const res = await fetch(`${gatewayUrl}/admin`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});

describe("x402 signer asset allowlist", () => {
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const base = (overrides: Partial<PaymentContext["requirement"]>): PaymentContext => ({
    agentId: "bot",
    timestamp: Date.UTC(2026, 5, 12, 12, 0, 0),
    requirement: {
      scheme: "exact", network: "base-sepolia", amount: "0.05", currency: "USDC",
      payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", resource: "https://x/y", ...overrides,
    },
  });

  it("refuses to sign for a non-allowlisted asset", async () => {
    const signer = createEip3009Signer({ privateKey: KEY });
    await expect(signer(base({ asset: "0xdeadBEEFdeadBEEFdeadBEEFdeadBEEFdeadBEEF" }))).rejects.toThrow(/not allowlisted/);
  });

  it("signs for the default USDC asset", async () => {
    const signer = createEip3009Signer({ privateKey: KEY });
    await expect(signer(base({ asset: DEFAULT_USDC["base-sepolia"] }))).resolves.toMatch(/.+/);
  });

  it("clamps the authorization validity to maxAuthorizationSeconds", async () => {
    const t0 = Date.UTC(2026, 5, 12, 12, 0, 0);
    const signer = createEip3009Signer({ privateKey: KEY, now: () => t0, maxAuthorizationSeconds: 120 });
    const header = await signer(base({ maxTimeoutSeconds: 999999 }));
    expect(decodeXPayment(header).payload.authorization.validBefore).toBe(String(Math.floor(t0 / 1000) + 120));
  });
});

describe("concurrency & DoS limits", () => {
  let paidApi: Server, gateway: Gateway, paidUrl: string, gatewayUrl: string;
  const listen = (s: Server): Promise<string> =>
    new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeAll(async () => {
    paidApi = createPaidApi([{ path: "/x", options: [{ network: "mock", amount: "0.05", currency: "USD", payTo: "m" }], body: { ok: true } }]);
    paidUrl = await listen(paidApi);
    gateway = createGateway({
      policyManager: new PolicyManager({ agents: [{ agentId: "bot", enabled: true, currency: "USD", dailyBudget: "0.10" }] }),
      rails: [new MockRail()],
      rates: new FixedRateProvider({ "USD:USD": "1" }),
      allowPrivateTargets: true,
    });
    gatewayUrl = await listen(gateway.server);
  });
  afterAll(() => { paidApi.close(); gateway.server.close(); });

  it("holds the daily budget under concurrent payments (no double-spend)", async () => {
    // Budget 0.10 / price 0.05 → at most 2 may succeed. Fire 5 at once.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        fetch(`${gatewayUrl}/proxy?url=${encodeURIComponent(paidUrl + "/x")}`, { headers: { "x-agent-id": "bot" } }).then((r) => r.status),
      ),
    );
    expect(results.filter((s) => s === 200)).toHaveLength(2);
    expect(results.filter((s) => s === 403)).toHaveLength(3);

    const spend = (await (await fetch(`${gatewayUrl}/admin/spend/bot`)).json()) as { spentToday: string };
    expect(spend.spentToday).toBe("0.1"); // never exceeded the cap
  });

  it("rejects an oversized request body with 413", async () => {
    const res = await fetch(`${gatewayUrl}/proxy?url=${encodeURIComponent(paidUrl + "/x")}`, {
      method: "POST",
      headers: { "x-agent-id": "bot", "content-type": "application/octet-stream" },
      body: Buffer.alloc(1_100_000), // > 1 MiB cap
    });
    expect(res.status).toBe(413);
  });
});
