---
name: agent-spend-control
description: Give an AI agent the ability to spend money — pay x402/USDC paid APIs, Alipay/WeChat-style agent payments, or any HTTP 402-gated resource — WITHOUT handing it the wallet, keys, or an uncapped budget. Stands up agentpay, a self-hosted cross-rail spend-policy gateway with per-agent budgets and per-transaction caps in one base currency across all rails, payee allow/blocklists, human-in-the-loop approval for large payments, and an append-only audit log. Use when you want an agent to pay for things (x402, pay-per-call APIs, bookings, purchases) on a capped, audited budget, or when asked to limit/approve/audit what an agent spends.
homepage: https://github.com/Hellotravisss/agentpay
---

# agent-spend-control — set up & operate agentpay for an agent

This is an **executable runbook**, not a description. When the user wants an AI
agent to spend money safely (capped, audited, no keys in the agent), follow the
steps below to install [agentpay](https://github.com/Hellotravisss/agentpay),
write a spend policy, launch the gateway, route the agent's paid calls through
it, and operate it. Run the commands yourself; don't just explain them.

**What agentpay is:** a forward proxy that holds the spending authority the
agent must not. The agent calls paid resources *through* the gateway; on a
`402 Payment Required` it checks the agent's policy (budgets, caps, allow/
blocklists), pays on a rail it controls, retries with the proof, and logs every
decision. The agent never sees a credential.

**Mental model — read this first so you don't mislead the user:**
- The gateway is the **control plane** (policy, budgets, routing, audit). That
  part is fully real out of the box.
- **Settlement** is pluggable per "rail." `npm run dev` runs with **mock rails**
  → you get the complete spend-control/policy/audit experience with *simulated*
  payment (no real money moves). Perfect for wiring up and demoing.
- To settle **real** money: the **x402/USDC rail is real** (offline EIP-3009
  signing, settled on Base / Base Sepolia) — but it must be wired with a funded
  wallet (see Step 7B), not via the default `npm run dev`. Never imply the dev
  server moves real funds.

---

## Step 0 — Prerequisites

```bash
node --version   # need >= 20 (>= 22.5 if you want SQLite persistence)
git --version
```
If Node is too old, tell the user to upgrade (e.g. via nvm) before continuing.

## Step 1 — Install & self-test

```bash
git clone https://github.com/Hellotravisss/agentpay
cd agentpay
npm install
npm test          # expect "94 passed" — proves money math, FX, policy, x402 sigs, security
```
If `npm test` fails, stop and report the failure; do not proceed.

## Step 2 — Write the spend policy

Policies are **deny-by-default**: an agent with no entry cannot spend at all.
Ask the user (or infer) the per-agent limits, then edit `policies/example.json`.
Shape (all amounts are decimal strings in the agent's `currency`):

```jsonc
{
  "fxRates": { "USDC:USD": "1", "CNY:USD": "0.14" }, // directional; payments in a currency with no rate are denied
  "defaults": { "enabled": true, "currency": "USD", "perTransactionMax": "1.00" },
  "agents": [{
    "agentId": "my-bot",            // how the agent identifies itself to the gateway
    "enabled": true,
    "currency": "USD",              // base currency; ALL limits below are in it, enforced across every rail via FX
    "perTransactionMax": "0.25",    // cap on any single payment
    "dailyBudget": "5.00",          // UTC calendar day, across all rails/currencies
    "monthlyBudget": "50.00",       // UTC calendar month
    "maxTransactionsPerDay": 200,
    "requireApprovalOver": "1.00",  // payments >= this are HELD for a human (202) until approved
    "railPreference": ["x402", "alipay-act"], // routing order when a merchant accepts several rails
    "payeeBlocklist": ["merchant-shady"]      // or "payeeAllowlist": [...] to whitelist instead
  }]
}
```
Start tight (small caps, `requireApprovalOver` set) and widen deliberately. See
`policies.md` (bundled with this skill) for ready-made templates (research bot,
purchasing agent, fleet of agents, crypto-only, etc.).

## Step 3 — Launch the gateway

```bash
npm run dev       # binds http://127.0.0.1:4020 ; dashboard at /admin
```
Useful env vars (set before the command): `PORT`, `HOST`, `POLICY_FILE`,
and for durable state `LEDGER_FILE`/`AUDIT_FILE`/`APPROVALS_FILE` (`.sqlite` →
transactional SQLite, anything else → JSONL). The policy file **hot-reloads** on
edit, and you can edit live via the admin API / dashboard.

## Step 4 — Verify

```bash
curl -s http://127.0.0.1:4020/healthz                 # {"ok":true}
npm run demo                                          # 2 rails, 2 currencies, 1 USD budget, approvals, audit
open http://127.0.0.1:4020/admin                      # dashboard: live spend, approvals, audit, policy editor
```

## Step 5 — Route the agent's paid calls through the gateway (the integration)

This is the point of the whole thing. Wherever the agent currently calls a paid
URL **directly**, change it to call **through the proxy** and identify itself —
it stops holding any key or wallet:

```text
BEFORE:  GET https://paid.example/api/thing
AFTER:   GET http://127.0.0.1:4020/proxy?url=https%3A%2F%2Fpaid.example%2Fapi%2Fthing
         header:  X-Agent-Id: my-bot          (dev)
                  Authorization: Bearer <key> (once API keys are minted — Step 7)
```
`?url=` must be URL-encoded. Method/body/`content-type` are forwarded. Outcomes:

- **Allowed** → gateway pays on the cheapest eligible rail, retries with the
  payment proof, returns the unlocked response + headers `X-Gateway-Payment-Id`,
  `X-Gateway-Rail`, `X-Gateway-Payment-Amount`.
- **Denied** → `403 {error:"payment_denied", rule:"..."}` (`per_transaction_max`,
  `daily_budget`, `monthly_budget`, `payee_blocklisted`, `max_transactions_per_day`,
  `no_fx_rate`, ...). The agent should back off or explain — not retry blindly.
- **Held for approval** → `202 {status:"held_for_approval", approvalId}`. A human
  approves in the dashboard or `POST /admin/approvals/:id {"decision":"approve"}`,
  then the agent **retries the same request** and it goes through.
- **No policy** → `403 policy_missing` (the agent isn't in the policy). **Free
  (non-402) URLs pass straight through** — the gateway only acts on a 402.

Update the agent's code/config to use this proxy form, then re-run its task and
confirm a payment shows up in the audit log (Step 6).

## Step 6 — Operate

```bash
curl -s http://127.0.0.1:4020/admin/spend/my-bot              # spent vs limits + per-rail breakdown
curl -s "http://127.0.0.1:4020/admin/audit?agent=my-bot"      # every allow / deny / hold
curl -s http://127.0.0.1:4020/admin/approvals?status=pending  # what's waiting on a human
# approve / reject:
curl -s -X POST http://127.0.0.1:4020/admin/approvals/<id> -H 'content-type: application/json' -d '{"decision":"approve"}'
# change limits live (also hot-reloaded into the file):
curl -s -X PUT http://127.0.0.1:4020/admin/agents/my-bot -H 'content-type: application/json' \
  -d '{"currency":"USD","perTransactionMax":"0.50","dailyBudget":"10.00"}'
```
The dashboard at `/admin` does all of this visually (spend meters, approve/reject
buttons, inline policy editing, API-key management).

## Step 7 — Production hardening (do before any real money)

1. `export ADMIN_TOKEN=<strong random>` → every `/admin/*` data/mutation endpoint
   now requires `Authorization: Bearer $ADMIN_TOKEN` (or `X-Admin-Token`).
2. `export REQUIRE_API_KEY=1` so agents authenticate with a real key, not
   `X-Agent-Id`. Mint one per agent: `POST /admin/keys {"agentId":"my-bot","label":"prod"}`
   → the secret is returned **once**; give it to the agent as `Authorization: Bearer`.
3. Keep `allowPrivateTargets` **off** (default; the proxy blocks private/loopback
   targets — SSRF guard). Put the gateway behind TLS; only set `HOST=0.0.0.0`
   when properly fronted. Point the `*_FILE` env vars at durable storage.
4. Full threat model + checklist: `docs/SECURITY.md` in the repo.

### 7B — Settle real payments (optional)

`npm run dev` uses mock rails (simulated settlement). For **real x402/USDC**:
fund a throwaway wallet with testnet USDC (faucet.circle.com, Base Sepolia) and
either run `X402_PRIVATE_KEY=0x... TARGET_URL=https://... npx tsx demo/x402-live.ts`,
or embed agentpay as a library and construct the gateway with
`new X402Rail({ networks:["base-sepolia"], signPayment: createEip3009Signer({ privateKey }) })`.
The wallet key lives only in that rail callback — the gateway core never touches it.
(This rail has settled a real on-chain USDC payment on Base Sepolia.)

---

## Rules for you, the assisting agent

- The gateway is the **only** way this agent spends — never put a raw key or
  wallet in the agent itself.
- Deny-by-default; start every agent with small caps and `requireApprovalOver`,
  widen on request.
- On a `403 payment_denied`, surface the `rule` to the user and stop — don't loop.
- On a `202 held_for_approval`, tell the user it needs their approval; don't try
  to bypass it.
- Never claim the dev server moves real money. Real settlement = Step 7B.
- When something breaks, consult `troubleshooting.md` (bundled) — it maps every
  error code to its cause and fix, and lists all endpoints.

Repo, architecture, and security docs: <https://github.com/Hellotravisss/agentpay>.
