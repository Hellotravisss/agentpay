import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AgentPolicy, ApprovalStatus, PaymentRequirement, PolicyConfig } from "../types.js";
import { isBlockedTarget } from "./ssrf.js";
import type { PaymentRail } from "../rails/rail.js";
import { SpendLedger, startOfUtcDay, startOfUtcMonth } from "../ledger/ledger.js";
import { AuditLog } from "../audit/audit.js";
import { ApprovalStore } from "../approvals/approvals.js";
import { ApiKeyStore } from "../auth/keys.js";
import { dashboardHtml } from "./dashboard.js";
import { evaluate } from "../policy/engine.js";
import { PolicyManager, validateAgentPolicy } from "../policy/manager.js";
import { formatAmount, parseAmount } from "../money.js";
import { convert, FixedRateProvider, type RateProvider } from "../fx/rates.js";

/** Abort an upstream fetch that hangs, so a slow/huge target can't tie up the gateway. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** Cap on the inbound request body the gateway buffers, so a huge body can't exhaust memory. */
const MAX_REQUEST_BYTES = 1_048_576; // 1 MiB

/** A RateProvider that can asynchronously warm its cache (e.g. a live source). */
function isRefreshable(r: RateProvider): r is RateProvider & { refresh(pairs: Array<[string, string]>): Promise<void> } {
  return typeof (r as { refresh?: unknown }).refresh === "function";
}

export interface GatewayOptions {
  /** Static policy config. Wrapped in a PolicyManager; pass `policyManager` instead for hot-reload. */
  policyConfig?: PolicyConfig;
  /** Live, editable policy. Takes precedence over `policyConfig`. */
  policyManager?: PolicyManager;
  rails: PaymentRail[];
  /** Currency conversion for cross-rail budgets. Defaults to identity-only. */
  rates?: RateProvider;
  ledger?: SpendLedger;
  audit?: AuditLog;
  /** Holds payments over an agent's approval threshold for human review. */
  approvals?: ApprovalStore;
  /** Legacy static map of API key -> agentId. When set, agents must send `Authorization: Bearer <key>`. */
  apiKeys?: Record<string, string>;
  /** Multi-tenant API key store (mint/revoke via /admin/keys). Verified keys always authenticate. */
  apiKeyStore?: ApiKeyStore;
  /** When true, reject `X-Agent-Id` — only a valid Bearer API key authenticates. */
  requireApiKey?: boolean;
  /**
   * Token guarding the admin API (`/admin/*` data + mutations). When set,
   * those endpoints require `Authorization: Bearer <token>` or `X-Admin-Token`.
   * When unset the admin API is open — only safe behind a trusted network /
   * loopback bind (the CLI warns and binds 127.0.0.1 by default).
   */
  adminToken?: string;
  /**
   * Allow the proxy to fetch private/loopback addresses. Off by default (SSRF
   * guard on); turn on only for local testing against 127.0.0.1 targets.
   */
  allowPrivateTargets?: boolean;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface Gateway {
  server: Server;
  ledger: SpendLedger;
  audit: AuditLog;
  approvals: ApprovalStore;
  policy: PolicyManager;
  keys: ApiKeyStore;
}

/**
 * The gateway is a forward proxy for agents: instead of calling a paid API
 * directly (and holding payment credentials), the agent calls
 *
 *   GET /proxy?url=<target>   with   Authorization / X-Agent-Id
 *
 * On a 402 from the target, the gateway collects every payment option the
 * merchant accepts, routes to one rail (agent's rail preference first, then
 * cheapest in the policy's base currency), checks the agent's spend policy,
 * executes the payment, retries with X-PAYMENT, and returns the unlocked
 * response. Every decision is written to the audit log.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const ledger = options.ledger ?? new SpendLedger();
  const audit = options.audit ?? new AuditLog();
  const approvals = options.approvals ?? new ApprovalStore(undefined, options.now);
  const rates = options.rates ?? new FixedRateProvider({});
  const now = options.now ?? Date.now;
  const policy = options.policyManager ?? new PolicyManager(options.policyConfig ?? { agents: [] });
  const keys = options.apiKeyStore ?? new ApiKeyStore(undefined, options.now);

  // Per-agent FIFO lock: chains each agent's critical sections so they run one
  // at a time (different agents stay concurrent). Map entries self-clean.
  const agentLocks = new Map<string, Promise<unknown>>();
  function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const prior = agentLocks.get(agentId) ?? Promise.resolve();
    const run = prior.then(fn, fn); // run after the prior settles, success or failure
    const tail = run.then(
      () => {},
      () => {},
    );
    agentLocks.set(agentId, tail);
    tail.then(() => {
      if (agentLocks.get(agentId) === tail) agentLocks.delete(agentId);
    });
    return run;
  }

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

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return sendHtml(res, dashboardHtml()); // static page holds no secrets; its data fetches are gated below
    }

    // Every admin data/mutation endpoint requires the admin token (when configured).
    if (url.pathname.startsWith("/admin/") && !adminAuthorized(req)) {
      return sendJson(res, 401, { error: "admin_unauthorized", message: "Send Authorization: Bearer <admin token> or X-Admin-Token" });
    }

    if (url.pathname === "/admin/policy") {
      return sendJson(res, 200, policy.snapshot());
    }

    if (url.pathname === "/admin/agents" || url.pathname.startsWith("/admin/agents/")) {
      return handleAgents(req, res, url);
    }

    if (url.pathname.startsWith("/admin/spend/")) {
      return handleSpend(res, decodeURIComponent(url.pathname.slice("/admin/spend/".length)));
    }

    if (url.pathname === "/admin/audit") {
      const agent = url.searchParams.get("agent");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return sendJson(res, 200, { entries: agent ? audit.forAgent(agent, limit) : audit.tail(limit) });
    }

    if (url.pathname.startsWith("/admin/approvals")) {
      return handleApprovals(req, res, url);
    }

    if (url.pathname === "/admin/keys" || url.pathname.startsWith("/admin/keys/")) {
      return handleKeys(req, res, url);
    }

    if (url.pathname === "/proxy") {
      return handleProxy(req, res, url);
    }

    sendJson(res, 404, { error: "not_found" });
  }

  /** GET list · PUT /:id upsert · DELETE /:id remove — the policy admin API. */
  async function handleAgents(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET" && url.pathname === "/admin/agents") {
      return sendJson(res, 200, { agents: policy.listResolved() });
    }

    const m = /^\/admin\/agents\/([^/]+)$/.exec(url.pathname);
    if (!m) return sendJson(res, 404, { error: "not_found" });
    const agentId = decodeURIComponent(m[1]!);

    if (req.method === "PUT") {
      let agent;
      try {
        const raw = (await readBody(req)).toString() || "{}";
        agent = validateAgentPolicy(JSON.parse(raw), agentId);
      } catch (err) {
        return sendJson(res, 400, { error: "invalid_policy", message: String(err instanceof Error ? err.message : err) });
      }
      policy.upsertAgent(agent);
      audit.log("policy_changed", agentId, { action: "upsert", agent }, now());
      return sendJson(res, 200, { agent: policy.resolve(agentId) });
    }

    if (req.method === "DELETE") {
      const removed = policy.removeAgent(agentId);
      if (removed) audit.log("policy_changed", agentId, { action: "remove" }, now());
      return sendJson(res, removed ? 200 : 404, { removed });
    }

    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  /** GET list · POST mint (secret shown once) · DELETE /:id revoke — multi-tenant API keys. */
  async function handleKeys(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === "GET" && url.pathname === "/admin/keys") {
      return sendJson(res, 200, { keys: keys.list() });
    }

    if (req.method === "POST" && url.pathname === "/admin/keys") {
      let body: { label?: unknown; agentId?: unknown; expiresAt?: unknown };
      try {
        body = JSON.parse((await readBody(req)).toString() || "{}");
      } catch {
        return sendJson(res, 400, { error: "bad_request", message: "Body must be JSON" });
      }
      if (typeof body.agentId !== "string" || !body.agentId) {
        return sendJson(res, 400, { error: "bad_request", message: "agentId is required" });
      }
      if (!policy.resolve(body.agentId)) {
        return sendJson(res, 400, { error: "unknown_agent", message: `No policy configured for agent "${body.agentId}"` });
      }
      const label = typeof body.label === "string" && body.label ? body.label : body.agentId;
      const expiresAt = typeof body.expiresAt === "number" ? body.expiresAt : undefined;
      const created = keys.create(label, body.agentId, { expiresAt });
      audit.log("apikey_created", body.agentId, { keyId: created.apiKey.id, label }, now());
      return sendJson(res, 201, created); // { apiKey, secret } — secret is returned only here
    }

    const m = /^\/admin\/keys\/([^/]+)$/.exec(url.pathname);
    if (req.method === "DELETE" && m) {
      const id = decodeURIComponent(m[1]!);
      const existing = keys.get(id);
      const revoked = keys.revoke(id);
      if (revoked && existing) audit.log("apikey_revoked", existing.agentId, { keyId: id, label: existing.label }, now());
      return sendJson(res, revoked ? 200 : 404, { revoked });
    }

    return sendJson(res, 405, { error: "method_not_allowed" });
  }

  function handleSpend(res: ServerResponse, agentId: string): void {
    const resolved = policy.resolve(agentId);
    if (!resolved) return sendJson(res, 404, { error: "unknown_agent", agentId });
    const t = now();

    const perRail: Record<string, { transactions: number; amounts: Record<string, string> }> = {};
    for (const r of ledger.receiptsFor(agentId)) {
      const entry = (perRail[r.rail] ??= { transactions: 0, amounts: {} });
      entry.transactions += 1;
      const prev = entry.amounts[r.currency] ? parseAmount(entry.amounts[r.currency]!) : 0n;
      entry.amounts[r.currency] = formatAmount(prev + parseAmount(r.amount));
    }

    sendJson(res, 200, {
      agentId,
      currency: resolved.currency,
      spentToday: formatAmount(ledger.spentSince(agentId, resolved.currency, startOfUtcDay(t), t)),
      spentThisMonth: formatAmount(ledger.spentSince(agentId, resolved.currency, startOfUtcMonth(t), t)),
      transactionsToday: ledger.transactionsSince(agentId, startOfUtcDay(t), t),
      perRail,
      limits: {
        perTransactionMax: resolved.perTransactionMax ?? null,
        dailyBudget: resolved.dailyBudget ?? null,
        monthlyBudget: resolved.monthlyBudget ?? null,
        maxTransactionsPerDay: resolved.maxTransactionsPerDay ?? null,
        requireApprovalOver: resolved.requireApprovalOver ?? null,
      },
    });
  }

  async function handleApprovals(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // GET /admin/approvals[?status=pending] — list held payments.
    if (req.method === "GET" && url.pathname === "/admin/approvals") {
      const status = url.searchParams.get("status") as ApprovalStatus | null;
      return sendJson(res, 200, { approvals: approvals.list(status ?? undefined) });
    }

    // POST /admin/approvals/:id  { "decision": "approve" | "reject" }
    const m = /^\/admin\/approvals\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const id = decodeURIComponent(m[1]!);
      const existing = approvals.get(id);
      if (!existing) return sendJson(res, 404, { error: "unknown_approval", id });

      let decision: string | undefined;
      try {
        const raw = (await readBody(req)).toString() || "{}";
        decision = (JSON.parse(raw) as { decision?: string }).decision;
      } catch {
        return sendJson(res, 400, { error: "bad_request", message: 'Body must be JSON { "decision": "approve" | "reject" }' });
      }
      if (decision !== "approve" && decision !== "reject") {
        return sendJson(res, 400, { error: "bad_decision", message: 'decision must be "approve" or "reject"' });
      }

      const updated = approvals.decide(id, decision === "approve" ? "approved" : "rejected");
      if (!updated) return sendJson(res, 409, { error: "already_decided", id, status: existing.status });

      audit.log(
        updated.status === "approved" ? "payment_approved" : "payment_rejected",
        updated.agentId,
        { approvalId: id, requirement: updated.requirement, baseAmount: updated.baseAmount },
        now(),
      );
      return sendJson(res, 200, { approval: updated });
    }

    sendJson(res, 404, { error: "not_found" });
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
    if (!options.allowPrivateTargets && (await isBlockedTarget(target))) {
      return sendJson(res, 403, { error: "blocked_target", message: "Target resolves to a private or loopback address" });
    }

    if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) {
      req.resume(); // drain the upload so the client can read the response cleanly
      return sendJson(res, 413, { error: "request_too_large", message: `Request body exceeds ${MAX_REQUEST_BYTES} bytes` });
    }
    let body: Buffer;
    try {
      body = await readBody(req); // streaming cap is the fallback for chunked bodies with no content-length
    } catch {
      return sendJson(res, 413, { error: "request_too_large", message: `Request body exceeds ${MAX_REQUEST_BYTES} bytes` });
    }
    const upstreamInit: RequestInit = {
      method: req.method,
      headers: forwardableHeaders(req),
      body: body.length > 0 ? body : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    };

    const first = await fetch(target, upstreamInit);
    if (first.status !== 402) {
      return relay(res, first);
    }

    // --- 402 handshake ---
    const requirements = await parseRequirements(first, target);
    if (requirements.length === 0) {
      return sendJson(res, 502, { error: "unparseable_402", message: "Target returned 402 without recognizable payment requirements" });
    }

    const timestamp = now();
    const agentPolicy = policy.resolve(agentId);
    if (!agentPolicy) {
      audit.log("policy_missing", agentId, { requirements }, timestamp);
      return sendJson(res, 403, { error: "policy_missing", message: `No spend policy configured for agent "${agentId}"` });
    }

    // Warm a live rate cache (if any) before routing/evaluating, which read rates synchronously.
    if (isRefreshable(rates)) {
      const pairs = requirements.map((r) => [r.currency, agentPolicy.currency] as [string, string]);
      await rates.refresh(pairs).catch(() => {}); // best-effort; stale/missing rates deny downstream
    }

    const chosen = route(requirements, options.rails, agentPolicy, rates);
    if (!chosen) {
      return sendJson(res, 502, {
        error: "no_rail",
        message: `No configured rail settles any of the offered networks: ${requirements.map((r) => r.network).join(", ")}`,
      });
    }
    const { requirement, rail } = chosen;
    const ctx = { agentId, requirement, timestamp };

    // Serialize the decide → execute → record window per agent. Without this,
    // two concurrent payments for the same agent could both pass the budget
    // check (which reads the ledger) before either records, overspending the cap.
    return withAgentLock(agentId, async () => {
      const decision = evaluate(agentPolicy, ctx, ledger, rates);
      if (!decision.allow) {
        audit.log("payment_denied", agentId, { requirement, rail: rail.name, rule: decision.rule, reason: decision.reason }, timestamp);
        return sendJson(res, 403, { error: "payment_denied", rule: decision.rule, reason: decision.reason });
      }

      // evaluate() already proved the rate exists; amount in the policy's base currency.
      const rate = rates.rate(requirement.currency, agentPolicy.currency)!;
      const baseAmount = convert(parseAmount(requirement.amount), rate);

      // --- human-in-the-loop: hold payments at/over the approval threshold ---
      if (agentPolicy.requireApprovalOver !== undefined && baseAmount >= parseAmount(agentPolicy.requireApprovalOver)) {
        const held = approvals.findMatch(agentId, requirement);
        if (!held) {
          const a = approvals.create(agentId, requirement, formatAmount(baseAmount), agentPolicy.currency);
          audit.log("payment_held", agentId, { requirement, rail: rail.name, approvalId: a.id, baseAmount: a.baseAmount }, timestamp);
          return sendJson(res, 202, {
            status: "held_for_approval",
            approvalId: a.id,
            reason: `Payment of ${a.baseAmount} ${agentPolicy.currency} requires approval (threshold ${agentPolicy.requireApprovalOver} ${agentPolicy.currency})`,
          });
        }
        if (held.status === "pending") {
          return sendJson(res, 202, { status: "awaiting_approval", approvalId: held.id });
        }
        if (held.status === "rejected") {
          approvals.consume(held.id);
          audit.log("payment_denied", agentId, { requirement, rail: rail.name, rule: "approval_rejected", approvalId: held.id }, timestamp);
          return sendJson(res, 403, { error: "payment_denied", rule: "approval_rejected", reason: "A reviewer rejected this payment" });
        }
        approvals.consume(held.id); // approved → consume once and execute
      }

      let receipt;
      try {
        receipt = await rail.pay(ctx);
      } catch (err) {
        audit.log("payment_failed", agentId, { requirement, rail: rail.name, message: String(err) }, timestamp);
        return sendJson(res, 502, { error: "payment_failed", message: String(err) });
      }

      receipt.baseAmount = formatAmount(baseAmount);
      receipt.baseCurrency = agentPolicy.currency;

      ledger.record(receipt);
      audit.log("payment_executed", agentId, { receipt }, timestamp);

      const second = await fetch(target, {
        ...upstreamInit,
        headers: { ...forwardableHeaders(req), "X-PAYMENT": receipt.proof },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      res.setHeader("X-Gateway-Payment-Id", receipt.id);
      res.setHeader("X-Gateway-Rail", rail.name);
      res.setHeader("X-Gateway-Payment-Amount", `${receipt.amount} ${receipt.currency}`);
      return relay(res, second);
    });
  }

  /** Constant-time check of the admin token. Open (true) when no token is configured. */
  function adminAuthorized(req: IncomingMessage): boolean {
    if (!options.adminToken) return true; // unauthenticated mode — rely on the loopback bind + startup warning
    const provided =
      headerValue(req, "x-admin-token") ?? headerValue(req, "authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!provided) return false;
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(options.adminToken).digest();
    return timingSafeEqual(a, b); // hashes equalize length, so no length leak
  }

  function resolveAgentId(req: IncomingMessage): string | undefined {
    const token = headerValue(req, "authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      const viaStore = keys.verify(token);
      if (viaStore) return viaStore;
      if (options.apiKeys?.[token]) return options.apiKeys[token];
    }
    // A configured legacy map, or requireApiKey, means Bearer is mandatory — no X-Agent-Id fallback.
    if (options.requireApiKey || options.apiKeys) return undefined;
    return headerValue(req, "x-agent-id");
  }

  return { server, ledger, audit, approvals, policy, keys };
}

/**
 * Pick one (requirement, rail) pair out of everything the merchant accepts:
 * the agent's railPreference order wins, ties broken by cheapest cost in the
 * policy's base currency (unconvertible options rank last).
 */
export function route(
  requirements: PaymentRequirement[],
  rails: PaymentRail[],
  policy: AgentPolicy,
  rates: RateProvider,
): { requirement: PaymentRequirement; rail: PaymentRail } | undefined {
  const preference = policy.railPreference ?? [];
  const candidates = requirements.flatMap((requirement) => {
    const rail = rails.find((r) => r.supports(requirement.network));
    return rail ? [{ requirement, rail }] : [];
  });

  const rank = (c: { requirement: PaymentRequirement; rail: PaymentRail }) => {
    const pref = preference.indexOf(c.rail.name);
    const rate = rates.rate(c.requirement.currency, policy.currency);
    const cost = rate === undefined ? null : convert(parseAmount(c.requirement.amount), rate);
    return { pref: pref === -1 ? Number.MAX_SAFE_INTEGER : pref, cost };
  };

  return candidates.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra.pref !== rb.pref) return ra.pref - rb.pref;
    if (ra.cost === null) return rb.cost === null ? 0 : 1;
    if (rb.cost === null) return -1;
    return ra.cost < rb.cost ? -1 : ra.cost > rb.cost ? 1 : 0;
  })[0];
}

/**
 * Normalize a 402 response body into PaymentRequirements. Accepts both this
 * gateway's simplified shape and the x402 wire shape ({ accepts: [...] } with
 * maxAmountRequired in 6-dp atomic units).
 */
async function parseRequirements(res: Response, target: string): Promise<PaymentRequirement[]> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  if (typeof body !== "object" || body === null) return [];
  const accepts = (body as { accepts?: unknown[] }).accepts;
  const rawList = Array.isArray(accepts) ? accepts : [body];

  const out: PaymentRequirement[] = [];
  for (const raw of rawList as Record<string, unknown>[]) {
    if (!raw || typeof raw.payTo !== "string") continue;

    let amount: string | undefined;
    let currency: string | undefined;
    if (typeof raw.amount === "string") {
      amount = raw.amount;
      currency = typeof raw.currency === "string" ? raw.currency : undefined;
    } else if (typeof raw.maxAmountRequired === "string") {
      amount = formatAmount(BigInt(raw.maxAmountRequired));
      currency = typeof raw.assetSymbol === "string" ? raw.assetSymbol : "USDC";
    }
    if (!amount || !currency) continue;

    const extra = (typeof raw.extra === "object" && raw.extra !== null ? raw.extra : undefined) as
      | { name?: string; version?: string }
      | undefined;
    out.push({
      scheme: typeof raw.scheme === "string" ? raw.scheme : "exact",
      network: typeof raw.network === "string" ? raw.network : "mock",
      amount,
      currency,
      payTo: raw.payTo,
      resource: typeof raw.resource === "string" ? raw.resource : target,
      description: typeof raw.description === "string" ? raw.description : undefined,
      asset: typeof raw.asset === "string" ? raw.asset : undefined,
      maxTimeoutSeconds: typeof raw.maxTimeoutSeconds === "number" ? raw.maxTimeoutSeconds : undefined,
      extra,
    });
  }
  return out;
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

function readBody(req: IncomingMessage, maxBytes = MAX_REQUEST_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("request_body_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function relay(res: ServerResponse, upstream: Response): Promise<void> {
  res.statusCode = upstream.status;
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  if (!upstream.body) return void res.end();
  // Stream chunks through instead of buffering the whole body, so a huge
  // upstream response can't be read entirely into memory.
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) res.write(Buffer.from(value));
  }
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}
