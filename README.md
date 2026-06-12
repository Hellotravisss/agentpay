# agent-pay-gateway

A **cross-rail spend-policy gateway for AI agent payments**. It sits between your agents and anything that charges them money — x402-style paid APIs, Alipay-style agent payments, whatever comes next — and answers the question every company deploying paying agents will have to answer:

> *"How do I let my agent spend money — across several payment rails — without giving it my wallets?"*

Agents never hold payment credentials. They call paid resources **through** the gateway, which:

1. intercepts the `402 Payment Required` handshake and collects **every payment option the merchant accepts**,
2. **routes to one rail** (agent's rail preference first, ties broken by cheapest cost in the policy's base currency),
3. checks the payment against that agent's spend policy — budgets and caps are denominated in **one base currency** and enforced across all rails and currencies via exact FX conversion,
4. executes approved payments on the chosen rail,
5. retries the request with the payment proof and returns the unlocked response,
6. writes **every decision — denials included — to an append-only audit log**.

```
                       ┌────────────────────────────────────────────────┐      ─▶ paid API (x402, USDC)
  agent ──HTTP──▶      │  gateway                                       │
  (no keys, no wallet) │  policy ─ fx ─ router ─ ledger ─ audit ─ rails │      ─▶ paid API (Alipay, CNY)
                       └────────────────────────────────────────────────┘      ─▶ ...
```

## Quick start

```bash
npm install
npm test        # 29 tests: money math, FX, policy rules, cross-rail e2e
npm run demo    # walkthrough: 2 rails, 2 currencies, 1 unified USD budget
npm run dev     # start the gateway on :4020 with policies/example.json
```

The demo runs a merchant that accepts USDC (x402-style) **or** CNY (Alipay-style); two agents with different rail preferences get routed differently, and one USD budget governs both — a 0.36 CNY purchase consumes ~0.0504 USD of it. Per-transaction caps, payee blocklists, budget exhaustion, the per-rail spend breakdown, and the audit trail are all shown.

## Policies

Policies are deny-by-default: an agent with no policy entry cannot spend at all. See `policies/example.json`:

```jsonc
{
  "fxRates": { "USDC:USD": "1", "CNY:USD": "0.14" },  // directional pairs, exact decimals
  "defaults": { "currency": "USD", "perTransactionMax": "1.00", "dailyBudget": "10.00" },
  "agents": [
    {
      "agentId": "research-bot",
      "enabled": true,
      "currency": "USD",                        // base currency for ALL limits below
      "railPreference": ["alipay-act", "x402"], // routing order when merchants accept several rails
      "perTransactionMax": "0.25",              // cap on any single payment, in base currency
      "dailyBudget": "0.15",                    // UTC calendar day, across all rails/currencies
      "monthlyBudget": "3.00",                  // UTC calendar month
      "maxTransactionsPerDay": 200,
      "payeeBlocklist": ["merchant-shady"]
      // or "payeeAllowlist": [...] to whitelist instead
    }
  ]
}
```

All money is exact decimal (bigint micro-units, 6 dp — USDC precision); FX conversions round **up** so budgets are enforced conservatively. No floats anywhere near amounts. Payments in a currency with no configured rate to the base currency are denied (`no_fx_rate`).

## API

| Endpoint | Purpose |
|---|---|
| `ANY /proxy?url=<target>` | Proxy a request; routes + pays on 402 if policy allows. Identify the agent via `Authorization: Bearer <api key>` (when keys are configured) or `X-Agent-Id`. |
| `GET /admin/spend/:agentId` | Unified spend vs. limits in the base currency, plus a per-rail breakdown in native currencies. |
| `GET /admin/audit?agent=&limit=` | Audit trail of every allow/deny/failure. |
| `GET /healthz` | Liveness. |

Successful paid responses carry `X-Gateway-Payment-Id`, `X-Gateway-Rail`, and `X-Gateway-Payment-Amount` headers. Denials return `403` with the violated rule id (`per_transaction_max`, `daily_budget`, `payee_blocklisted`, `no_fx_rate`, ...) so the agent can explain itself or back off.

## Payment rails

Rails implement one interface (`src/rails/rail.ts`): `supports(network)` + `pay(ctx) -> receipt`. Adding a rail never touches policy, FX, or routing code. Included:

- **`MockRail`** — instant in-process settlement; instantiate several to simulate a multi-rail deployment.
- **`X402Rail`** — adapter for [Coinbase's x402](https://www.x402.org/) protocol; bring your own signer (e.g. a CDP or viem wallet) via `signPayment`.
- **`AlipayActRail`** — adapter shaped for Alipay's agent-payment stack (AI付 under the ACT delegation model); bring your merchant integration via `executePayment`.

The gateway never holds raw keys — credentials live inside the rail callbacks you supply. Planned: Google AP2.

## Status & roadmap

This is an MVP. The policy engine, FX layer, cross-rail router, ledger, audit log, and 402 proxy flow are tested and working end to end against mock rails. Not yet built:

- [ ] Real x402 settlement against Base Sepolia (signer integration + facilitator verification)
- [ ] Real Alipay AI付/ACT settlement (requires merchant onboarding)
- [ ] Live FX rate provider with caching and staleness limits
- [ ] Persistent storage beyond JSONL (SQLite/Postgres)
- [ ] Human-in-the-loop approvals ("hold payments over $X for review")
- [ ] Web dashboard for spend + audit
- [ ] Policy hot-reload and an admin API for editing policies
- [ ] Multi-tenant API key management
