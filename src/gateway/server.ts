import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PaymentRequirement, PolicyConfig } from "../types.js";
import type { PaymentRail } from "../rails/rail.js";
import { SpendLedger, startOfUtcDay, startOfUtcMonth } from "../ledger/ledger.js";
import { AuditLog } from "../audit/audit.js";
import { evaluate, resolvePolicy } from "../policy/engine.js";
import { formatAmount } from "../money.js";

export interface GatewayOptions {
  policyConfig: PolicyConfig;
  rails: PaymentRail[];
  ledger?: SpendLedger;
  audit?: AuditLog;
  /** Map of API key -> agentId. When set, agents must send `Authorization: Bearer <key>`. */
  apiKeys?: Record<string, string>;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface Gateway {
  server: Server;
  ledger: SpendLedger;
  audit: AuditLog;
}

/**
 * The gateway is a forward proxy for agents: instead of calling a paid API
 * directly (and holding payment credentials), the agent calls
 *
 *   GET /proxy?url=<target>   with   Authorization / X-Agent-Id
 *
 * On a 402 from the target, the gateway checks the agent's spend policy,
 * executes the payment on a matching rail, retries with X-PAYMENT, and
 * returns the unlocked response. Every decision is written to the audit log.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const ledger = options.ledger ?? new SpendLedger();
  const audit = options.audit ?? new AuditLog();
  const now = options.now ?? Date.now;

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: "internal_error", message: String(err) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway.local");

    if (url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/admin/spend/")) {
      return handleSpend(res, decodeURIComponent(url.pathname.slice("/admin/spend/".length)));
    }

    if (url.pathname === "/admin/audit") {
      const agent = url.searchParams.get("agent");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return sendJson(res, 200, { entries: agent ? audit.forAgent(agent, limit) : audit.tail(limit) });
    }

    if (url.pathname === "/proxy") {
      return handleProxy(req, res, url);
    }

    sendJson(res, 404, { error: "not_found" });
  }

  function handleSpend(res: ServerResponse, agentId: string): void {
    const policy = resolvePolicy(options.policyConfig, agentId);
    if (!policy) return sendJson(res, 404, { error: "unknown_agent", agentId });
    const t = now();
    sendJson(res, 200, {
      agentId,
      currency: policy.currency,
      spentToday: formatAmount(ledger.spentSince(agentId, policy.currency, startOfUtcDay(t), t)),
      spentThisMonth: formatAmount(ledger.spentSince(agentId, policy.currency, startOfUtcMonth(t), t)),
      transactionsToday: ledger.transactionsSince(agentId, startOfUtcDay(t), t),
      limits: {
        perTransactionMax: policy.perTransactionMax ?? null,
        dailyBudget: policy.dailyBudget ?? null,
        monthlyBudget: policy.monthlyBudget ?? null,
        maxTransactionsPerDay: policy.maxTransactionsPerDay ?? null,
      },
    });
  }

  async function handleProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const agentId = resolveAgentId(req);
    if (!agentId) {
      return sendJson(res, 401, { error: "unauthenticated", message: "Send Authorization: Bearer <api key> or X-Agent-Id" });
    }

    const target = url.searchParams.get("url") ?? headerValue(req, "x-target-url");
    if (!target || !/^https?:\/\//.test(target)) {
      return sendJson(res, 400, { error: "bad_target", message: "Provide an absolute http(s) target via ?url= or X-Target-Url" });
    }

    const body = await readBody(req);
    const upstreamInit: RequestInit = {
      method: req.method,
      headers: forwardableHeaders(req),
      body: body.length > 0 ? body : undefined,
    };

    const first = await fetch(target, upstreamInit);
    if (first.status !== 402) {
      return relay(res, first);
    }

    // --- 402 handshake ---
    const requirement = await parseRequirement(first, target);
    if (!requirement) {
      return sendJson(res, 502, { error: "unparseable_402", message: "Target returned 402 without recognizable payment requirements" });
    }

    const rail = options.rails.find((r) => r.supports(requirement.network));
    if (!rail) {
      return sendJson(res, 502, { error: "no_rail", message: `No configured rail settles on network "${requirement.network}"` });
    }

    const ctx = { agentId, requirement, timestamp: now() };
    const policy = resolvePolicy(options.policyConfig, agentId);
    if (!policy) {
      audit.log("policy_missing", agentId, { requirement }, ctx.timestamp);
      return sendJson(res, 403, { error: "policy_missing", message: `No spend policy configured for agent "${agentId}"` });
    }

    const decision = evaluate(policy, ctx, ledger);
    if (!decision.allow) {
      audit.log("payment_denied", agentId, { requirement, rule: decision.rule, reason: decision.reason }, ctx.timestamp);
      return sendJson(res, 403, { error: "payment_denied", rule: decision.rule, reason: decision.reason });
    }

    let receipt;
    try {
      receipt = await rail.pay(ctx);
    } catch (err) {
      audit.log("payment_failed", agentId, { requirement, rail: rail.name, message: String(err) }, ctx.timestamp);
      return sendJson(res, 502, { error: "payment_failed", message: String(err) });
    }

    ledger.record(receipt);
    audit.log("payment_executed", agentId, { receipt }, ctx.timestamp);

    const second = await fetch(target, {
      ...upstreamInit,
      headers: { ...forwardableHeaders(req), "X-PAYMENT": receipt.proof },
    });
    res.setHeader("X-Gateway-Payment-Id", receipt.id);
    res.setHeader("X-Gateway-Payment-Amount", `${receipt.amount} ${receipt.currency}`);
    return relay(res, second);
  }

  function resolveAgentId(req: IncomingMessage): string | undefined {
    const auth = headerValue(req, "authorization");
    if (options.apiKeys) {
      const key = auth?.replace(/^Bearer\s+/i, "");
      return key ? options.apiKeys[key] : undefined;
    }
    return headerValue(req, "x-agent-id");
  }

  return { server, ledger, audit };
}

/**
 * Normalize a 402 response body into a PaymentRequirement. Accepts both this
 * gateway's simplified shape and the x402 wire shape ({ accepts: [...] } with
 * maxAmountRequired in 6-dp atomic units).
 */
async function parseRequirement(res: Response, target: string): Promise<PaymentRequirement | undefined> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const accepts = (body as { accepts?: unknown[] }).accepts;
  const raw = (Array.isArray(accepts) ? accepts[0] : body) as Record<string, unknown> | undefined;
  if (!raw || typeof raw.payTo !== "string") return undefined;

  let amount: string | undefined;
  let currency: string | undefined;
  if (typeof raw.amount === "string") {
    amount = raw.amount;
    currency = typeof raw.currency === "string" ? raw.currency : undefined;
  } else if (typeof raw.maxAmountRequired === "string") {
    amount = formatAmount(BigInt(raw.maxAmountRequired));
    currency = typeof raw.assetSymbol === "string" ? raw.assetSymbol : "USDC";
  }
  if (!amount || !currency) return undefined;

  return {
    scheme: typeof raw.scheme === "string" ? raw.scheme : "exact",
    network: typeof raw.network === "string" ? raw.network : "mock",
    amount,
    currency,
    payTo: raw.payTo,
    resource: typeof raw.resource === "string" ? raw.resource : target,
    description: typeof raw.description === "string" ? raw.description : undefined,
  };
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function forwardableHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "accept"]) {
    const v = headerValue(req, name);
    if (v) out[name] = v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function relay(res: ServerResponse, upstream: Response): Promise<void> {
  res.statusCode = upstream.status;
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
