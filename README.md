# agentpay

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

For how it's built and *why* — design principles, the full 402 request lifecycle, and where the simple parts grow — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
npm install
npm test        # 49 tests: money, FX (+ caching), policy, x402 sigs, persistence, approvals, e2e
npm run demo    # walkthrough: 2 rails, 2 currencies, 1 unified USD budget, human-in-the-loop
npm run dev     # start the gateway on :4020 (dashboard at http://localhost:4020/admin)
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
      "requireApprovalOver": "0.50",            // hold payments >= this for human review (base ccy)
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
| `GET /admin` | Web dashboard (single self-contained page) — live spend, pending approvals with approve/reject buttons, the audit trail, and inline policy editing. |
| `GET /admin/policy` | The full live policy config. |
| `GET /admin/agents` | Configured agents with their resolved limits. |
| `PUT /admin/agents/:id` | Create or replace an agent's policy (validated). Takes effect on the next request; written back to the policy file. |
| `DELETE /admin/agents/:id` | Remove an agent (reverts to deny-by-default). |
| `GET /admin/keys` · `POST /admin/keys` · `DELETE /admin/keys/:id` | Multi-tenant API keys: list, mint (secret returned once), revoke. |
| `GET /admin/spend/:agentId` | Unified spend vs. limits in the base currency, plus a per-rail breakdown in native currencies. |
| `GET /admin/audit?agent=&limit=` | Audit trail of every allow/deny/failure/hold. |
| `GET /admin/approvals?status=` | List payments held for human review (filter `pending`/`approved`/`rejected`). |
| `POST /admin/approvals/:id` | Decide a held payment: body `{ "decision": "approve" \| "reject" }`. |
| `GET /healthz` | Liveness. |

Successful paid responses carry `X-Gateway-Payment-Id`, `X-Gateway-Rail`, and `X-Gateway-Payment-Amount` headers. Denials return `403` with the violated rule id (`per_transaction_max`, `daily_budget`, `payee_blocklisted`, `no_fx_rate`, `approval_rejected`, ...) so the agent can explain itself or back off.

### Human-in-the-loop approvals

Set `requireApprovalOver` on an agent and any policy-approved payment at or above that base-currency amount is **held** instead of executed: the proxy returns `202` with an `approvalId` rather than paying. An operator approves or rejects via `POST /admin/approvals/:id`; the agent's retry then executes (approved) or is denied with `approval_rejected`. Each approval is single-use, so it unlocks exactly one payment. Budgets are still re-checked at execution time on the retry.

### Persistence

By default the ledger, audit log, and approvals live in memory. Point any of them at a file to make state survive restarts — `.sqlite` selects a transactional SQLite backend (Node's built-in `node:sqlite`, no extra dependency), anything else is append-only JSONL:

```bash
LEDGER_FILE=./ledger.sqlite AUDIT_FILE=./audit.jsonl APPROVALS_FILE=./approvals.sqlite APIKEYS_FILE=./keys.sqlite npm run dev
```

### Live FX rates

`FixedRateProvider` is fine for static pairs; `CachingRateProvider` wraps any async rate source (a `RateFetcher`, default `httpRateFetcher` hits exchangerate.host) with a TTL and a hard staleness limit. Past that limit a cached rate is refused (`no_fx_rate`) rather than used — a payment is never priced on a stale rate. Stablecoin pegs can be `pinned` so they never expire or fetch.

### Editing policies (live)

Policies change at runtime — no restart. The `PolicyManager` owns the live config; every decision reads through it, so an edit takes effect on the next request. Two ways in, kept in sync:

- **Admin API / dashboard** — `PUT`/`DELETE /admin/agents/:id` (the dashboard's edit pencils and "add agent" button drive these). Each edit is validated, audited as `policy_changed`, and written back to the policy file.
- **The file itself** — `npm run dev` watches the policy file and hot-reloads out-of-band edits. The write-back and the watcher don't fight: `reload()` no-ops when the file is byte-identical to the in-memory state, so a self-write doesn't trigger a reload loop. (`fxRates` are built once at startup and not hot-reloaded.)

### Multi-tenant API keys

Agents authenticate with `Authorization: Bearer <key>`. Keys are minted per agent (an agent can hold several, for rotation) via `POST /admin/keys` or the dashboard — the **raw secret is returned exactly once**; only its SHA-256 hash is stored, so a leaked store yields no usable credentials. Keys support an optional expiry and can be revoked instantly (`DELETE /admin/keys/:id`); both are audited (`apikey_created` / `apikey_revoked`).

By default a valid Bearer key authenticates *and* `X-Agent-Id` still works (convenient for local dev). Set `REQUIRE_API_KEY=1` (or `requireApiKey: true`) to reject `X-Agent-Id` so only a valid key authenticates. Persist keys across restarts with `APIKEYS_FILE=./keys.sqlite`.

## Payment rails

Rails implement one interface (`src/rails/rail.ts`): `supports(network)` + `pay(ctx) -> receipt`. Adding a rail never touches policy, FX, or routing code. Included:

- **`MockRail`** — instant in-process settlement; instantiate several to simulate a multi-rail deployment.
- **`X402Rail`** — adapter for [Coinbase's x402](https://www.x402.org/) protocol, with a **real client-side payment implementation**: `createEip3009Signer` produces signed EIP-3009 `transferWithAuthorization` payloads (the X-PAYMENT header) for USDC on Base / Base Sepolia. Signing is fully offline; the merchant's facilitator settles on-chain. Signatures are verified cryptographically in the test suite.
- **`AlipayActRail`** — adapter shaped for Alipay's agent-payment stack (AI付 under the ACT delegation model); bring your merchant integration via `executePayment`.

Credentials live inside the rail callbacks you supply — the gateway core never touches keys. Planned: Google AP2.

### Buying a real x402 resource on Base Sepolia

```bash
# 1. fund a throwaway wallet with testnet USDC: https://faucet.circle.com (Base Sepolia)
# 2. pick an x402-protected URL settling on base-sepolia
X402_PRIVATE_KEY=0x... TARGET_URL=https://... npx tsx demo/x402-live.ts
```

## Status & roadmap

This is an MVP. The policy engine, FX layer, cross-rail router, ledger, audit log, approvals, persistence, and 402 proxy flow are tested and working end to end against mock rails; the x402 client-side payment (EIP-3009 signing) is real and cryptographically verified in tests. Done since the first cut:

- [x] Live FX rate provider with caching and staleness limits (`CachingRateProvider`)
- [x] Persistent storage beyond JSONL — transactional SQLite via `node:sqlite`
- [x] Human-in-the-loop approvals ("hold payments over $X for review")
- [x] Web dashboard for spend + audit + approvals + policy editing (`GET /admin`)
- [x] Policy hot-reload and an admin API for editing policies
- [x] Multi-tenant API key management (hashed keys, mint/revoke, per-key expiry)

Not yet built:

- [ ] End-to-end x402 settlement against a live facilitator (needs a funded testnet wallet — see `demo/x402-live.ts`)
- [ ] Real Alipay AI付/ACT settlement (requires merchant onboarding)
