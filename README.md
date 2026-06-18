# agentpay

A **cross-rail spend-policy gateway for AI agent payments**. It sits between your agents and anything that charges them money — x402-style paid APIs, Alipay/WeChat-style agent payments, whatever comes next — and answers the question every company deploying paying agents will have to answer:

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

## Where it fits — the neutral layer

The platforms are racing to let agents spend, and each is building a **closed loop**: Alipay's [ACT](https://www.qbitai.com/2026/01/369878.html) delegated-payment protocol, WeChat Pay's [isolated "AI card"](https://www.caixinglobal.com/2026-06-17/tencent-lets-ai-agent-make-purchases-through-wechat-pay-102455141.html) with user-set authorization scope and spend limits, x402 for crypto-native APIs. Every platform wants agents spending inside *its* wallet, on *its* rail — and the design they keep converging on (a wallet isolated from your real account, scoped authorization, per-spend limits, big payments held for confirmation, a full audit trail) is exactly the control surface this project is built around. The thesis is no longer speculative; it's where the giants are pointing their capex.

But a company running real agents doesn't get to live in one loop. Its agents pay an x402 API in USDC, a vendor in CNY, the next thing in whatever ships next quarter — and **no single platform gives it one neutral view across all of them**: one base-currency budget, one audit trail, one policy, one place where the agent never holds a credential. The more these closed loops fragment, the more that spanning layer is missing.

That layer is agentpay. It sits *above* the rails — x402, Alipay, WeChat, mock — behind a two-method interface ([`rails/rail.ts`](src/rails/rail.ts)), so budget, policy, FX, routing, and audit are written **once** and every rail plugs in underneath. It's rail-neutral and self-hosted by design: the value is precisely the part no platform racing to own its own loop will build for you.

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
- **`X402Rail`** — adapter for [Coinbase's x402](https://www.x402.org/) protocol, with a **real client-side payment implementation**: `createEip3009Signer` produces signed EIP-3009 `transferWithAuthorization` payloads (the X-PAYMENT header) for USDC on Base / Base Sepolia. Signing is fully offline; the merchant's facilitator settles on-chain. Verified two ways: signatures are checked cryptographically in the test suite, **and the rail has settled a real payment on Base Sepolia end to end** (see below).
- **`AlipayActRail`** — adapter shaped for Alipay's agent-payment stack (AI付 under the ACT delegation model); bring your merchant integration via `executePayment`.

Credentials live inside the rail callbacks you supply — the gateway core never touches keys. Planned: Google AP2.

### Buying a real x402 resource on Base Sepolia

This has been run for real: the gateway settled **0.01 USDC on Base Sepolia** through Coinbase's hosted testnet facilitator from a wallet holding zero ETH (the facilitator pays gas — x402 is gasless for the payer). On-chain proof: [`0x3108b5…54ff9d`](https://sepolia.basescan.org/tx/0x3108b58475338d6dc2aa113642b39c0128bfcbd711bff2bdb06691b76154ff9d).

To reproduce — public testnet endpoints come and go, so the reliable path is a local x402 merchant:

```bash
# 1. fund a throwaway wallet with testnet USDC: https://faucet.circle.com (Base Sepolia)

# 2. run a local x402 merchant settling on base-sepolia (official middleware + hosted facilitator)
mkdir x402-merchant && cd x402-merchant && npm init -y && npm i x402-express express
cat > server.mjs <<'JS'
import express from "express";
import { paymentMiddleware } from "x402-express";
const app = express();
app.use(paymentMiddleware("0xYourMerchantAddress", {       // any address — it just receives the USDC
  "/premium": { price: "$0.01", network: "base-sepolia", config: { description: "x402 test" } },
}));
app.get("/premium", (_q, r) => r.json({ message: "unlocked by a real on-chain payment" }));
app.listen(4021, () => console.log("merchant on http://localhost:4021/premium"));
JS
node server.mjs

# 3. buy it through the gateway (signs EIP-3009 offline, facilitator settles on-chain)
X402_PRIVATE_KEY=0x... TARGET_URL=http://localhost:4021/premium npx tsx demo/x402-live.ts
```

Or point `TARGET_URL` at any live x402 resource that settles on `base-sepolia`.

## Security

It moves money, so the control plane is hardened, not just the math:

- **Admin API auth** — set `ADMIN_TOKEN` and every `/admin/*` data/mutation endpoint requires it (`Authorization: Bearer` or `X-Admin-Token`, constant-time compared). Unset, the admin API is open, so the CLI **binds `127.0.0.1` by default** (override with `HOST`) and warns at startup. The dashboard carries the token (seed it once via `/admin#token=…`).
- **SSRF guard** — `/proxy` refuses targets that resolve to private/loopback/link-local ranges (incl. the `169.254.169.254` cloud-metadata IP) by default. Opt in with `allowPrivateTargets` only for local testing.
- **x402 asset allowlist** — the signer refuses to sign an EIP-3009 authorization for any token not on a per-network allowlist (default: canonical USDC), so a malicious `402` can't trick the wallet into authorizing a transfer of a different, more valuable token. Authorization validity is clamped (`maxAuthorizationSeconds`).
- **No double-spend under concurrency** — the decide→execute→record window is serialized per agent, so concurrent payments can't both pass the budget check before either is recorded.
- **DoS limits** — 1 MiB request-body cap (`413`), 30 s upstream fetch timeout, and the upstream response is streamed (not buffered whole into memory).
- **Money integrity** — exact `bigint` arithmetic (no floats), API keys stored only as SHA-256 hashes (raw secret shown once), and the upstream `Authorization` header is never forwarded.

**Deploy checklist:** set `ADMIN_TOKEN`, enable `REQUIRE_API_KEY=1`, keep `allowPrivateTargets` off, and put the gateway behind TLS. See the threat notes in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status & roadmap

This is an MVP. The policy engine, FX layer, cross-rail router, ledger, audit log, approvals, persistence, and 402 proxy flow are tested and working end to end against mock rails; the x402 rail has settled a real payment on Base Sepolia. Done since the first cut:

- [x] Live FX rate provider with caching and staleness limits (`CachingRateProvider`)
- [x] Persistent storage beyond JSONL — transactional SQLite via `node:sqlite`
- [x] Human-in-the-loop approvals ("hold payments over $X for review")
- [x] Web dashboard for spend + audit + approvals + policy editing (`GET /admin`)
- [x] Policy hot-reload and an admin API for editing policies
- [x] Multi-tenant API key management (hashed keys, mint/revoke, per-key expiry)
- [x] End-to-end x402 settlement against a live facilitator — [0.01 USDC settled on Base Sepolia](https://sepolia.basescan.org/tx/0x3108b58475338d6dc2aa113642b39c0128bfcbd711bff2bdb06691b76154ff9d) (reproduce: [above](#buying-a-real-x402-resource-on-base-sepolia))

Not yet built:

- [ ] Real Alipay AI付/ACT settlement (requires merchant onboarding)
