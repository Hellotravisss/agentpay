import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { createGateway } from "../src/gateway/server.js";
import { MockRail } from "../src/rails/mock.js";
import { FixedRateProvider } from "../src/fx/rates.js";
import { createMcpHandler } from "../src/mcp/server.js";

const listen = (s: Server): Promise<string> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

/** Merchant charging `price` USDC via a v1 402; unlocks on any X-PAYMENT. */
function merchant(price: string) {
  return createServer((req, res) => {
    if (!req.headers["x-payment"]) {
      res.statusCode = 402;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact", network: "base-sepolia", amount: price, currency: "USDC", payTo: "merchant-1", resource: "r" }] }));
    }
    res.end(JSON.stringify({ data: "premium" }));
  });
}

async function setup(price: string, agent: Record<string, unknown> = {}) {
  const m = merchant(price);
  const g = createGateway({
    policyConfig: { agents: [{ agentId: "bot", enabled: true, currency: "USD", perTransactionMax: "1.00", dailyBudget: "5", requireApprovalOver: "0.50", ...agent }] },
    rails: [new MockRail({ name: "x402", networks: ["base-sepolia"] })],
    rates: new FixedRateProvider({ "USDC:USD": "1" }),
    allowPrivateTargets: true,
  });
  const mUrl = await listen(m);
  const gUrl = await listen(g.server);
  const mcp = createMcpHandler({ gatewayUrl: gUrl, agentId: "bot" });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    ((await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { isError?: boolean; content: { text: string }[] } }).result;
  return { mUrl, g, mcp, call, close: () => { m.close(); g.server.close(); } };
}

describe("MCP server", () => {
  it("initializes and lists paid_fetch + check_budget", async () => {
    const mcp = createMcpHandler({ gatewayUrl: "http://x", agentId: "bot" });
    const init = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = (await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["paid_fetch", "check_budget"]);
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("paid_fetch pays within budget and returns the unlocked content", async () => {
    const s = await setup("0.10");
    try {
      const r = await s.call("paid_fetch", { url: s.mUrl + "/p" });
      expect(r.isError).toBeUndefined();
      expect(r.content[0]!.text).toContain("[paid 0.10 USDC via x402]");
      expect(r.content[0]!.text).toContain("premium");
      const b = await s.call("check_budget");
      expect(b.content[0]!.text).toContain("Spent today: 0.1 USD of 5");
    } finally { s.close(); }
  });

  it("a denial is enforced by the gateway and surfaced as a tool error", async () => {
    const s = await setup("2.00");
    try {
      const r = await s.call("paid_fetch", { url: s.mUrl + "/p" });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("per_transaction_max");
      expect(r.content[0]!.text).not.toContain("premium");
      expect(s.g.ledger.spentSince("bot", "USD", 0, Date.now() + 1000)).toBe(0n);
    } finally { s.close(); }
  });

  it("large payments are held for a human", async () => {
    const s = await setup("0.80");
    try {
      const r = await s.call("paid_fetch", { url: s.mUrl + "/p" });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("HELD for human approval");
    } finally { s.close(); }
  });

  it("an unreachable gateway is a tool error, not a crash", async () => {
    const mcp = createMcpHandler({ gatewayUrl: "http://127.0.0.1:1", agentId: "bot" });
    const r = (await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_budget" } })) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(true);
  });
});

describe("GET /v1/budget", () => {
  it("shows an agent only its own budget and needs the agent credential", async () => {
    const g = createGateway({ policyConfig: { agents: [{ agentId: "bot", enabled: true, currency: "USD", dailyBudget: "5" }] }, rails: [], rates: new FixedRateProvider({}), apiKeys: { "k-bot": "bot" } });
    const url = await listen(g.server);
    try {
      expect((await fetch(url + "/v1/budget")).status).toBe(401);
      expect((await fetch(url + "/v1/budget", { headers: { "x-agent-id": "bot" } })).status).toBe(401); // Bearer mandatory here
      const ok = await fetch(url + "/v1/budget", { headers: { authorization: "Bearer k-bot" } });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { agentId: string }).agentId).toBe("bot");
    } finally { g.server.close(); }
  });
});

describe("stdio transport", () => {
  it("speaks newline-delimited JSON-RPC over stdin/stdout", async () => {
    const p = spawn("npx", ["tsx", "src/mcp/cli.ts"], { env: { ...process.env, AGENTPAY_AGENT_ID: "bot" } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }) + "\n");
    await new Promise<void>((r) => { const t = setInterval(() => { if (out.includes("\n")) { clearInterval(t); r(); } }, 50); });
    p.kill();
    const msg = JSON.parse(out.split("\n")[0]!) as { id: number; result: { tools: unknown[] } };
    expect(msg.id).toBe(7);
    expect(msg.result.tools).toHaveLength(2);
  }, 20_000);
});
