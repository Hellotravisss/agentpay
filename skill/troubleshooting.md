# Troubleshooting & API reference

Bundled with the `agent-spend-control` skill. When a call doesn't do what you
expect, find the status/error here.

## Proxy outcomes (`/proxy?url=...`)

| Status / error | Cause | Fix |
|---|---|---|
| `401 unauthenticated` | No `X-Agent-Id` (dev) or invalid/absent `Authorization: Bearer` (when keys/`REQUIRE_API_KEY` are on). | Send the agent id / a valid key. |
| `400 bad_target` | `?url=` missing or not absolute `http(s)`. | Pass an absolute, URL-encoded target. |
| `403 blocked_target` | SSRF guard — target resolves to a private/loopback/metadata address. | Use a public target; for local testing only, start with `ALLOW_PRIVATE_TARGETS=1`. |
| `413 request_too_large` | Request body > 1 MiB. | Reduce the body. |
| `403 policy_missing` | The agent id has no policy entry (deny-by-default). | Add it to the policy (Step 2) or `PUT /admin/agents/:id`. |
| `403 payment_denied` + `rule` | A spend rule was violated (see rule table). | Adjust the policy or the spend — don't blind-retry. |
| `202 held_for_approval` / `awaiting_approval` | Amount ≥ `requireApprovalOver`. | A human approves via dashboard or `POST /admin/approvals/:id`, then retry. |
| `502 no_rail` | No configured rail settles any offered network. | Configure a rail for that network (mock/x402/alipay). |
| `502 unparseable_402` | Merchant returned a 402 with no recognizable / malformed requirements. | Check the merchant; agentpay skips malformed amounts rather than crashing. |
| `502 payment_failed` | The rail's `pay()` threw (e.g. signing/settlement error). | See the message; for x402 check the wallet/network/asset. |
| `502 upstream_error` | The target couldn't be reached or timed out (30 s). | Check the target URL / network. |
| non-402 response | Target isn't paywalled. | Passed straight through — nothing to pay. |

## `payment_denied` rule codes

`per_transaction_max` · `daily_budget` · `monthly_budget` ·
`max_transactions_per_day` · `payee_blocklisted` · `payee_not_allowlisted` ·
`no_fx_rate` (payment currency has no rate to the agent's base currency) ·
`agent_disabled` · `approval_rejected` (a reviewer rejected a held payment).

## Success headers

`X-Gateway-Payment-Id` · `X-Gateway-Rail` · `X-Gateway-Payment-Amount`.

---

## Admin API (all under `/admin`)

When `ADMIN_TOKEN` is set, every endpoint except the dashboard page needs
`Authorization: Bearer $ADMIN_TOKEN` (or `X-Admin-Token`); cross-origin
mutations are rejected (`403 csrf_blocked`).

| Method · path | Purpose |
|---|---|
| `GET /admin` | Dashboard (spend, approvals, audit, policy & key editors). |
| `GET /admin/policy` | Full live policy config. |
| `GET /admin/agents` | Agents with resolved limits. |
| `PUT /admin/agents/:id` | Create/replace an agent's policy (validated; hot-written to file). |
| `DELETE /admin/agents/:id` | Remove an agent (→ deny-by-default). |
| `GET /admin/spend/:agentId` | Spent vs limits in base currency + per-rail breakdown. |
| `GET /admin/audit?agent=&limit=` | Audit trail (allow/deny/hold/approve/reject/policy_changed). `limit` 1–1000. |
| `GET /admin/approvals?status=` | Held payments (`pending`/`approved`/`rejected`). |
| `POST /admin/approvals/:id` | `{"decision":"approve"\|"reject"}`. |
| `GET /admin/keys` | List API keys (hashes only, never secrets). |
| `POST /admin/keys` | `{"agentId","label","expiresAt?"}` → mint; secret returned **once**. |
| `DELETE /admin/keys/:id` | Revoke a key. |
| `GET /healthz` | Liveness. |

## Environment variables

`PORT` (4020) · `HOST` (127.0.0.1) · `POLICY_FILE` · `LEDGER_FILE` ·
`AUDIT_FILE` · `APPROVALS_FILE` · `APIKEYS_FILE` (`.sqlite` → SQLite, else JSONL) ·
`ADMIN_TOKEN` · `REQUIRE_API_KEY=1` · `ALLOW_PRIVATE_TARGETS=1` (testing only).

## Common setup issues

- **`npm test` fails on install** → wrong Node (need ≥ 20; ≥ 22.5 for SQLite).
- **Dashboard loads but data is empty / 401** → `ADMIN_TOKEN` is set; open
  `/admin#token=<token>` once (fragment, not `?token=`) so it's stored locally.
- **Agent still "holds keys"** → you didn't actually reroute its calls through
  `/proxy` (Step 5). The agent should never see a wallet/key.
- **"It didn't charge real money"** → expected: `npm run dev` uses mock rails.
  Real settlement = SKILL.md Step 7B (x402 with a funded wallet).
