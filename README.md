# agent-pay-gateway

A **spend-policy gateway for AI agent payments**. It sits between your agents and anything that charges them money (x402-style paid APIs today; more rails later), and answers the question every company deploying paying agents will have to answer:

> *"How do I let my agent spend money without giving it my wallet?"*

Agents never hold payment credentials. They call paid resources **through** the gateway, which:

1. intercepts the `402 Payment Required` handshake,
2. checks the payment against that agent's spend policy (budgets, per-transaction caps, payee allow/blocklists, rate limits),
3. executes approved payments on a pluggable payment rail,
4. retries the request with the payment proof and returns the unlocked response,
5. writes **every decision — denials included — to an append-only audit log**.

```
                       ┌──────────────────────────────────────────┐
  agent ──HTTP──▶      │  gateway                                 │      ──▶  paid API
  (no keys, no wallet) │  policy engine ─ ledger ─ audit ─ rails  │     (returns 402,
                       └──────────────────────────────────────────┘      then content)
```

## Quick start

```bash
npm install
npm test        # 23 tests: money math, policy rules, e2e 402 handshake
npm run demo    # full walkthrough against a local mock paid API
npm run dev     # start the gateway on :4020 with policies/example.json
```

The demo shows an agent buying a 0.05 USDC API response, then getting blocked in turn by the per-transaction cap, a payee blocklist, and its daily budget — with the audit trail and spend dashboard printed at the end.

## Policies

Policies are deny-by-default: an agent with no policy entry cannot spend at all. See `policies/example.json`:

```jsonc
{
  "defaults": { "currency": "USDC", "perTransactionMax": "1.00", "dailyBudget": "10.00" },
  "agents": [
    {
      "agentId": "research-bot",
      "enabled": true,
      "currency": "USDC",
      "perTransactionMax": "0.25",   // cap on any single payment
      "dailyBudget": "0.15",         // UTC calendar day
      "monthlyBudget": "3.00",       // UTC calendar month
      "maxTransactionsPerDay": 200,
      "payeeBlocklist": ["merchant-shady"]
      // or "payeeAllowlist": [...] to whitelist instead
    }
  ]
}
```

All money is exact decimal (bigint micro-units, 6 dp — USDC precision). No floats anywhere near amounts.

## API

| Endpoint | Purpose |
|---|---|
| `ANY /proxy?url=<target>` | Proxy a request; pays on 402 if policy allows. Identify the agent via `Authorization: Bearer <api key>` (when keys are configured) or `X-Agent-Id`. |
| `GET /admin/spend/:agentId` | Live spend vs. limits for one agent. |
| `GET /admin/audit?agent=&limit=` | Audit trail of every allow/deny/failure. |
| `GET /healthz` | Liveness. |

Successful paid responses carry `X-Gateway-Payment-Id` and `X-Gateway-Payment-Amount` headers. Denials return `403` with the violated rule id (`per_transaction_max`, `daily_budget`, `payee_blocklisted`, ...) so the agent can explain itself or back off.

## Payment rails

Rails implement one interface (`src/rails/rail.ts`): `supports(network)` + `pay(ctx) -> receipt`. Included:

- **`MockRail`** — instant in-process settlement for development and demos.
- **`X402Rail`** — adapter for [Coinbase's x402](https://www.x402.org/) protocol; bring your own signer (e.g. a CDP or viem wallet) via `signPayment`. The gateway never holds raw keys.

Planned: Alipay AI付 / ACT adapter, Google AP2.

## Status & roadmap

This is an MVP. The policy engine, ledger, audit log, and 402 proxy flow are tested and working end to end against the mock rail. Not yet built:

- [ ] Real x402 settlement against Base Sepolia (signer integration + facilitator verification)
- [ ] Persistent storage beyond JSONL (SQLite/Postgres)
- [ ] Human-in-the-loop approvals ("hold payments over $X for review")
- [ ] Web dashboard for spend + audit
- [ ] Policy hot-reload and an admin API for editing policies
- [ ] Multi-tenant API key management
