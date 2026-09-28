/**
 * agentpay MCP server — lets an MCP client (Claude, Cursor, …) buy paid HTTP
 * resources THROUGH the gateway. It holds only the agent's gateway API key; the
 * wallet, the budget and the policy live in the gateway, where the agent cannot
 * reach them. That is the difference from honor-system budget tools: the agent
 * is never asked to check its budget — it simply cannot spend past it.
 *
 * Dependency-free: newline-delimited JSON-RPC 2.0 over stdio, per the MCP stdio transport.
 */
import { createInterface } from "node:readline";

export interface McpServerOptions {
  /** Base URL of the agentpay gateway, e.g. http://127.0.0.1:4020 */
  gatewayUrl: string;
  /** Agent API key minted via POST /admin/keys (preferred). */
  apiKey?: string;
  /** Dev-only fallback when the gateway does not require API keys. */
  agentId?: string;
  /** Cap on response text returned to the model. */
  maxResponseChars?: number;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;
interface RpcRequest { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Json }
interface ToolResult { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Json }

const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.9.0";

export const TOOLS = [
  {
    name: "paid_fetch",
    description:
      "Fetch a URL that may require payment (HTTP 402 / x402). The agentpay gateway pays within this agent's budget and policy, then returns the unlocked response. Free URLs pass straight through. If the payment is denied or held for human approval, this returns an error explaining why — do not retry a denial.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "GET" },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH)" },
        contentType: { type: "string", description: "Content-Type of body, default application/json" },
      },
      required: ["url"],
    },
  },
  {
    name: "check_budget",
    description: "Show how much this agent has spent today and this month, and its limits (per-transaction cap, daily/monthly budget, approval threshold).",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export function createMcpHandler(opts: McpServerOptions) {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.gatewayUrl.replace(/\/+$/, "");
  const maxChars = opts.maxResponseChars ?? 20_000;

  function authHeaders(): Record<string, string> {
    if (opts.apiKey) return { authorization: `Bearer ${opts.apiKey}` };
    if (opts.agentId) return { "x-agent-id": opts.agentId };
    return {};
  }

  const text = (t: string, isError = false, structured?: Json): ToolResult => ({
    content: [{ type: "text", text: t }],
    ...(isError ? { isError: true } : {}),
    ...(structured ? { structuredContent: structured } : {}),
  });

  async function paidFetch(args: Json): Promise<ToolResult> {
    const url = typeof args.url === "string" ? args.url : "";
    if (!/^https?:\/\//.test(url)) return text("url must be an absolute http(s) URL", true);
    const method = typeof args.method === "string" ? args.method.toUpperCase() : "GET";
    const body = typeof args.body === "string" && method !== "GET" ? args.body : undefined;
    const headers: Record<string, string> = { ...authHeaders() };
    if (body !== undefined) headers["content-type"] = typeof args.contentType === "string" ? args.contentType : "application/json";

    const res = await f(`${base}/proxy?url=${encodeURIComponent(url)}`, { method, headers, body });
    const raw = await res.text();
    const clipped = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…[truncated ${raw.length - maxChars} chars]` : raw;
    const paid = res.headers.get("x-gateway-payment-amount");
    const payment = paid
      ? { amount: paid, rail: res.headers.get("x-gateway-rail"), paymentId: res.headers.get("x-gateway-payment-id") }
      : undefined;
    return describeOutcome(res.status, clipped, payment);
  }

  /** Turn a gateway response into something the model can act on. */
  function describeOutcome(status: number, body: string, payment?: Json): ToolResult {
    let j: Json = {};
    try { j = JSON.parse(body) as Json; } catch { /* non-JSON upstream body */ }

    if (status === 403 && j.error === "payment_denied") {
      return text(`Payment DENIED by spend policy (rule: ${String(j.rule)}). ${String(j.reason ?? "")} Do not retry; tell the user.`, true, j);
    }
    if (status === 202 && j.status === "held_for_approval") {
      return text(`Payment HELD for human approval (approvalId: ${String(j.approvalId)}). Ask the user to approve it in the agentpay dashboard, then call paid_fetch again with the same arguments.`, true, j);
    }
    if (status === 403 && j.error === "policy_missing") {
      return text("This agent has no spend policy in agentpay, so it cannot pay for anything. Ask the user to add one.", true, j);
    }
    if (status === 401) return text("agentpay rejected this agent's credentials (check AGENTPAY_API_KEY).", true, j);
    if (status >= 400 && typeof j.error === "string" && body.length < 2000) {
      return text(`agentpay error ${status} ${j.error}: ${String(j.message ?? "")}`, true, j);
    }
    const head = payment ? `[paid ${String(payment.amount)} via ${String(payment.rail)}] ` : "";
    return text(`${head}HTTP ${status}\n${body}`, status >= 400, payment ? { status, payment } : { status });
  }

  async function checkBudget(): Promise<ToolResult> {
    const res = await f(`${base}/v1/budget`, { headers: authHeaders() });
    const raw = await res.text();
    if (!res.ok) return text(`agentpay error ${res.status}: ${raw}`, true);
    const j = JSON.parse(raw) as Json;
    const l = (j.limits ?? {}) as Json;
    const c = String(j.currency);
    const lines = [
      `Spent today: ${String(j.spentToday)} ${c}${l.dailyBudget ? ` of ${String(l.dailyBudget)}` : ""}`,
      `Spent this month: ${String(j.spentThisMonth)} ${c}${l.monthlyBudget ? ` of ${String(l.monthlyBudget)}` : ""}`,
      `Per-transaction max: ${l.perTransactionMax ? `${String(l.perTransactionMax)} ${c}` : "none"}`,
      `Human approval required at: ${l.requireApprovalOver ? `${String(l.requireApprovalOver)} ${c}` : "never"}`,
    ];
    return text(lines.join("\n"), false, j);
  }

  /** Handle one JSON-RPC message; returns the response, or null for notifications. */
  async function handle(msg: RpcRequest): Promise<Json | null> {
    const isNotification = msg.id === undefined;
    const ok = (result: Json) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });

    try {
      switch (msg.method) {
        case "initialize": {
          const asked = String(msg.params?.protocolVersion ?? "");
          return ok({
            protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "agentpay", version: VERSION },
            instructions: "Use paid_fetch for any URL that may cost money. Spending is enforced by the agentpay gateway; you cannot exceed the budget, so never try to work around a denial.",
          });
        }
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: TOOLS as unknown as Json[] });
        case "tools/call": {
          const name = msg.params?.name;
          const args = (msg.params?.arguments ?? {}) as Json;
          if (name === "paid_fetch") return ok((await paidFetch(args)) as unknown as Json);
          if (name === "check_budget") return ok((await checkBudget()) as unknown as Json);
          return fail(-32602, `Unknown tool: ${String(name)}`);
        }
        default:
          return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (err) {
      // A gateway that is down is a tool failure the model should see, not a protocol crash.
      if (msg.method === "tools/call") return ok(text(`agentpay gateway unreachable at ${base}: ${String(err)}`, true) as unknown as Json);
      return fail(-32603, String(err));
    }
  }

  return { handle };
}

/** Run over stdin/stdout. Logs go to stderr only — stdout is the protocol channel. */
export function runStdio(opts: McpServerOptions): void {
  const { handle } = createMcpHandler(opts);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: RpcRequest;
    try {
      msg = JSON.parse(line) as RpcRequest;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      return;
    }
    void handle(msg).then((r) => {
      if (r) process.stdout.write(JSON.stringify(r) + "\n");
    });
  });
}
