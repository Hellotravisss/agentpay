import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { createGateway, type Gateway } from "../src/gateway/server.js";
import { X402Rail } from "../src/rails/x402.js";
import { createEip3009Signer, decodeXPayment, DEFAULT_USDC, EIP3009_TYPES, type X402PaymentPayloadV2 } from "../src/rails/x402-signer.js";
import { FixedRateProvider } from "../src/fx/rates.js";
import { safeRequest, readStreamText } from "../src/gateway/safe-fetch.js";
import type { PaymentContext } from "../src/types.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const PAYER = privateKeyToAccount(KEY).address;
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const USDC = DEFAULT_USDC["base-sepolia"]!;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const listen = (s: Server): Promise<string> =>
  new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

/** A spec-following x402 v2 merchant. It only unlocks when the PAYMENT-SIGNATURE is genuinely valid. */
function v2Merchant(opts: { amount: string; mirrorInBody?: boolean; headerless?: boolean; method?: string }) {
  const seen: { verified?: boolean; payload?: X402PaymentPayloadV2 } = {};
  const accepted = {
    scheme: "exact",
    network: "eip155:84532",
    amount: opts.amount,
    asset: USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2", ...(opts.method ? { assetTransferMethod: opts.method } : {}) },
  };
  const resource = { url: "https://merchant.example/premium", description: "Premium data", mimeType: "application/json" };
  const extensions = { "demo-ext": { info: { k: "v" }, schema: { type: "object" } } };
  const required = { x402Version: 2, error: "PAYMENT-SIGNATURE header is required", resource, accepts: [accepted], extensions };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const sig = req.headers["payment-signature"];
    if (typeof sig !== "string") {
      res.statusCode = 402;
      res.setHeader("content-type", "application/json");
      if (!opts.headerless) res.setHeader("PAYMENT-REQUIRED", b64(required));
      return res.end(opts.mirrorInBody || opts.headerless ? JSON.stringify(required) : "{}");
    }
    const p = JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as X402PaymentPayloadV2;
    seen.payload = p;
    const a = p.payload.authorization;
    const sigOk = await verifyTypedData({
      address: a.from,
      domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC },
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: p.payload.signature,
    });
    seen.verified =
      sigOk &&
      p.x402Version === 2 &&
      JSON.stringify(p.accepted) === JSON.stringify(accepted) && // echoed verbatim
      a.to === PAY_TO &&
      a.value === opts.amount;
    if (!seen.verified) {
      res.statusCode = 402;
      return res.end("{}");
    }
    res.setHeader("PAYMENT-RESPONSE", b64({ success: true, transaction: "0xabc123", network: "eip155:84532", payer: a.from }));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: "premium" }));
  });
  return { server, seen, accepted, resource, extensions };
}

function gateway(): Gateway {
  return createGateway({
    policyConfig: { agents: [{ agentId: "bot", enabled: true, currency: "USD", perTransactionMax: "1.00", dailyBudget: "10" }] },
    rails: [new X402Rail({ networks: ["base-sepolia"], signPayment: createEip3009Signer({ privateKey: KEY }) })],
    rates: new FixedRateProvider({ "USDC:USD": "1" }),
    allowPrivateTargets: true,
  });
}

async function buyThroughGateway(merchantOpts: Parameters<typeof v2Merchant>[0]) {
  const m = v2Merchant(merchantOpts);
  const g = gateway();
  const mUrl = await listen(m.server);
  const gUrl = await listen(g.server);
  try {
    const res = await fetch(`${gUrl}/proxy?url=${encodeURIComponent(mUrl + "/premium")}`, { headers: { "x-agent-id": "bot" } });
    const body = await res.text();
    return { res, body, m, g };
  } finally {
    m.server.close();
    g.server.close();
  }
}

describe("x402 v2 end to end (spec-following merchant)", () => {
  it("reads PAYMENT-REQUIRED, pays with a valid PAYMENT-SIGNATURE, and relays PAYMENT-RESPONSE", async () => {
    const { res, body, m, g } = await buyThroughGateway({ amount: "10000" }); // 0.01 USDC in atomic units
    expect(res.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ data: "premium" });
    expect(m.seen.verified).toBe(true); // merchant cryptographically verified our signature
    expect(m.seen.payload?.payload.authorization.from).toBe(PAYER);
    expect(m.seen.payload?.resource).toEqual(m.resource); // resource echoed
    expect(m.seen.payload?.extensions).toEqual(m.extensions); // extensions echoed, not dropped
    expect(res.headers.get("x-gateway-payment-amount")).toBe("0.01 USDC"); // atomic 10000 → 0.01, not 10,000
    expect(JSON.parse(Buffer.from(res.headers.get("payment-response")!, "base64").toString()).transaction).toBe("0xabc123");
    expect(g.ledger.spentSince("bot", "USD", 0, Date.now() + 1000)).toBe(10_000n); // 0.01 USD recorded
  });

  it("also understands v2 requirements mirrored in the body (no header) as atomic units", async () => {
    const { res, m } = await buyThroughGateway({ amount: "10000", headerless: true });
    expect(res.status).toBe(200);
    expect(m.seen.verified).toBe(true);
    expect(res.headers.get("x-gateway-payment-amount")).toBe("0.01 USDC");
  });

  it("prices a v2 amount in atomic units when enforcing caps (5 USDC, not 5,000,000)", async () => {
    const { res, body } = await buyThroughGateway({ amount: "5000000" });
    expect(res.status).toBe(403);
    const j = JSON.parse(body) as { rule: string; reason: string };
    expect(j.rule).toBe("per_transaction_max");
    expect(j.reason).toContain("Amount 5 USDC");
  });

  it("refuses a Permit2 requirement instead of signing an EIP-3009 that cannot settle", async () => {
    const { res, body, m, g } = await buyThroughGateway({ amount: "10000", method: "permit2" });
    expect(res.status).toBe(502);
    expect(JSON.parse(body).error).toBe("payment_failed");
    expect(m.seen.payload).toBeUndefined(); // nothing was ever sent to the merchant
    expect(g.ledger.spentSince("bot", "USD", 0, Date.now() + 1000)).toBe(0n);
  });
});

describe("x402 v2 signer", () => {
  const base = (): PaymentContext => ({
    agentId: "bot",
    timestamp: Date.UTC(2026, 8, 1),
    requirement: {
      scheme: "exact", network: "base-sepolia", amount: "0.01", currency: "USDC", payTo: PAY_TO,
      resource: "https://m/x", asset: USDC, extra: { name: "USDC", version: "2" }, x402Version: 2,
      wire: { accepted: { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC, payTo: PAY_TO, maxTimeoutSeconds: 60 } },
    },
  });

  it("emits a v2 payload that echoes `accepted` verbatim", async () => {
    const p = decodeXPayment(await createEip3009Signer({ privateKey: KEY })(base())) as X402PaymentPayloadV2;
    expect(p.x402Version).toBe(2);
    expect(p.accepted).toEqual(base().requirement.wire!.accepted);
    expect(p.payload.authorization.value).toBe("10000");
  });

  it("refuses when the signed value would not match the echoed amount", async () => {
    const ctx = base();
    ctx.requirement.wire!.accepted.amount = "20000"; // tampered / inconsistent requirement
    await expect(createEip3009Signer({ privateKey: KEY })(ctx)).rejects.toThrow(/does not match/);
  });
});

describe("v2 proof header is treated as a credential", () => {
  it("strips PAYMENT-SIGNATURE on a cross-origin redirect", async () => {
    let leaked: string | undefined = "not-set";
    const b = createServer((q, r) => { leaked = q.headers["payment-signature"] as string | undefined; r.end("ok"); });
    const bUrl = await listen(b);
    const a = createServer((_q, r) => { r.statusCode = 302; r.setHeader("location", bUrl + "/b"); r.end(); });
    const aUrl = await listen(a);
    try {
      const resp = await safeRequest(aUrl + "/a", { allowPrivateTargets: true, headers: { "PAYMENT-SIGNATURE": "signed" } });
      await readStreamText(resp.body, 1000);
      expect(leaked).toBeUndefined();
    } finally {
      a.close();
      b.close();
    }
  });
});

