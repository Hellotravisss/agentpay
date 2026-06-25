---
name: agent-spend-control
description: Give an AI agent the ability to spend money — pay x402/USDC paid APIs, Alipay/WeChat-style agent payments, or any HTTP 402-gated resource — WITHOUT handing it the wallet, keys, or an uncapped budget. Stands up agentpay, a self-hosted cross-rail spend-policy gateway with per-agent budgets and per-transaction caps in one base currency across all rails, payee allow/blocklists, human-in-the-loop approval for large payments, and an append-only audit log. Use when you want an agent to pay for things (x402, pay-per-call APIs, bookings, purchases) on a capped, audited budget, or when asked to limit/approve/audit what an agent spends.
homepage: https://github.com/Hellotravisss/agentpay
---

# agent-spend-control — give an AI agent money without giving it your wallet

Built on **[agentpay](https://github.com/Hellotravisss/agentpay)**, an open-source
(MIT) cross-rail spend-policy gateway for AI agent payments. The agent never
holds a credential: it calls paid resources *through* the gateway, which speaks
the `402 Payment Required` handshake, checks the spend against that agent's
policy, pays on a rail it controls, and logs every decision.

The x402/USDC path is real — it has settled a live on-chain payment on Base
Sepolia, not just in tests.

## When to use this skill

Reach for it whenever an agent's task involves paying for something and the
operator wants control + an audit trail rather than handing over keys:
- buying access to paid / metered APIs (x402, pay-per-call),
- an agent booking, ordering, or purchasing on a budget,
- a fleet of agents that each need their own capped allowance,
- mixing rails (crypto USDC and CNY/fiat) under one base-currency budget.

## Setup (one time)

```bash
git clone https://github.com/Hellotravisss/agentpay
cd agentpay
npm install
npm test          # 94 tests: money math, FX, policy, x402 signatures, security
npm run dev       # gateway on http://127.0.0.1:4020 — dashboard at /admin
```

Define the agent's allowance in `policies/example.json` (deny-by-default — an
agent with no entry cannot spend at all):

```jsonc
{
  "fxRates": { "USDC:USD": "1", "CNY:USD": "0.14" },
  "agents": [{
    "agentId": "my-bot",
    "enabled": true,
    "currency": "USD",              // all limits below are in this base currency
    "perTransactionMax": "0.25",    // cap on any single payment
    "dailyBudget": "5.00",          // UTC day, across all rails/currencies
    "monthlyBudget": "50.00",
    "requireApprovalOver": "1.00",  // payments >= this are held for human review
    "payeeBlocklist": ["merchant-shady"]
  }]
}
```

## How the agent uses it

Instead of calling a paid URL directly, the agent calls it **through the proxy**
and identifies itself — it never sees a key or wallet:

```bash
curl "http://127.0.0.1:4020/proxy?url=<TARGET_URL>" -H "X-Agent-Id: my-bot"
# (or Authorization: Bearer <api key> when keys are configured)
```

- Allowed → the gateway pays on the cheapest eligible rail, retries with the
  payment proof, and returns the unlocked response (with `X-Gateway-Payment-*`
  headers).
- Over a limit / blocklisted → `403` with the violated rule
  (`per_transaction_max`, `daily_budget`, `payee_blocklisted`, ...) so the agent
  can back off or explain itself.
- Over the approval threshold → `202` held; a human approves via the dashboard
  or `POST /admin/approvals/:id`, then the agent's retry goes through.

Check spend and history any time:

```bash
curl http://127.0.0.1:4020/admin/spend/my-bot     # spent vs limits, per-rail breakdown
curl http://127.0.0.1:4020/admin/audit?agent=my-bot   # every allow/deny/hold
```

## Guidance for the assisting agent

- Treat the gateway as the ONLY way this agent spends money — never put raw keys
  or a wallet in the agent itself.
- Start every agent deny-by-default; widen limits deliberately.
- Set `requireApprovalOver` for anything that should get a human glance.
- For production: set `ADMIN_TOKEN`, enable `REQUIRE_API_KEY=1`, keep it behind
  TLS — see [`docs/SECURITY.md`](https://github.com/Hellotravisss/agentpay/blob/agentpay-export/docs/SECURITY.md).

Rails included: MockRail (instant, for dev), X402Rail (real EIP-3009 signing for
USDC on Base / Base Sepolia), AlipayActRail (bring your merchant integration).
Full docs and architecture: <https://github.com/Hellotravisss/agentpay>.
