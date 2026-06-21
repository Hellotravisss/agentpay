# Security

agentpay moves money, so the control plane is treated as the primary attack
surface — not an afterthought. This document records the threat model, the
hardening in place, the known residuals, and the operator checklist. For the
design rationale see [ARCHITECTURE.md](ARCHITECTURE.md#threat-model).

## Threat model

| Attacker | Assumption | Bounded by |
|---|---|---|
| **Compromised / hostile agent** | The baseline — the whole point of the gateway | Deny-by-default policy, per-agent budgets & caps, payee allow/blocklist, full audit log; the agent never holds a credential |
| **Malicious merchant** (the `402` responder) | Not trusted; controls amount, payee, asset, EIP-712 domain | x402 asset allowlist (can't redirect the signature to another token), policy caps, payee allow/blocklist, clamped authorization validity |
| **Network attacker reaching the gateway** | Can send arbitrary requests | Admin token + loopback bind, SSRF guard (pinned DNS + redirect re-validation), body/response/timeout limits |
| **Concurrency as an attacker** | Races requests to slip past a budget | Per-agent serialization of the check → pay → record window |

## Hardening in place

- **Admin API authentication** — set `ADMIN_TOKEN` and every `/admin/*` data /
  mutation endpoint requires it (`Authorization: Bearer` or `X-Admin-Token`),
  compared in constant time (SHA-256 + `timingSafeEqual`). Unset, the admin API
  is open, so the CLI **binds `127.0.0.1` by default** and warns at startup.
- **SSRF guard** — the proxy fetches caller-supplied URLs through an
  SSRF-safe client: a pinned DNS lookup refuses private / loopback / link-local
  addresses (incl. the `169.254.169.254` cloud-metadata IP and non-canonical
  IPv6 loopback notations) **at connect time**, and the check is re-applied to
  **every redirect hop**. This closes DNS rebinding, redirect-to-internal, and
  decimal/hex/short-form IP tricks (resolved through the same `getaddrinfo` the
  connection uses). Credential headers (`X-PAYMENT`, `Authorization`, `Cookie`)
  are stripped before any **cross-origin** redirect. Opt in with
  `allowPrivateTargets` for local testing only.
- **x402 asset & currency binding** — the EIP-3009 signer refuses to sign for
  any token not on a per-network allowlist (default: canonical USDC), so a
  malicious `402` can't trick the wallet into authorizing a transfer of a
  different, more valuable token. It also refuses when the requirement's
  `currency` label doesn't match the settled asset's symbol, and the gateway
  values an x402 charge as USDC regardless of a merchant-supplied `assetSymbol`
  — together these stop a merchant from mislabeling the currency (e.g. "CNY") so
  the FX-based budget under-counts while the chain still moves USDC.
  Authorization validity is clamped (`maxAuthorizationSeconds`).
- **No double-spend under concurrency** — the decide → execute → record window
  is serialized per agent, so concurrent payments can't both pass the budget
  check (which reads the ledger) before either is recorded.
- **Admin CSRF defense** — admin mutations reject a request whose `Origin` host
  doesn't match `Host`. Browsers always send `Origin` on cross-site
  state-changing requests, so a malicious page can't drive `/admin/*` even in the
  open/no-token deployment; same-origin (the dashboard) and non-browser clients
  pass. The admin token is only seeded from the URL **fragment** (`#token=`),
  never `?token=`, so it can't leak into server/proxy logs.
- **DoS limits** — 1 MiB request-body cap (`413`); a per-socket idle timeout
  **and** a hard overall wall-clock deadline (so a slow-trickle body can't hold a
  connection open indefinitely); the FX rate fetch is itself timed out so a hung
  provider can't stall the payment path; responses are streamed, never buffered
  whole; `/admin/audit?limit=` is clamped to `[1, 1000]`.
- **Money & credential integrity** — exact `bigint` arithmetic (no floats near
  amounts), FX rounds up (budget-conservative), API keys stored only as
  SHA-256 hashes (raw secret shown once), prototype-chain tokens
  (`__proto__`/`constructor`) can't authenticate via the legacy key map, and the
  upstream `Authorization` header is never forwarded to merchants.

Each item above has regression coverage in [`test/security.test.ts`](../test/security.test.ts).

## Known residuals

Called out so they aren't silent. None bites a deployment that follows the
checklist below.

- **Changing an agent's base `currency` resets its spend window.** Historical
  receipts are stamped with the currency in effect when they executed, so
  re-denominating an agent (admin-only) orphans prior spend and re-opens the
  daily/monthly budget for that window. Admin-only and self-inflicted (an admin
  can already raise the budget directly), but re-convert at read time or block
  the change when prior spend exists if this matters to you.
- **Spend is recorded at authorization, not settlement confirmation.** For x402
  the gateway records the receipt once it signs + retries; it can't see whether
  the facilitator ultimately settles on-chain. A merchant returning 402s it never
  settles can grief an agent's budget (no theft, no value moved) — closing this
  needs on-chain settlement polling.
- **No up-front approval reservation** — concurrent held payments are
  re-checked against the budget at execution time rather than reserving the
  amount when held; they can't exceed the budget, but a burst of holds isn't
  pre-allocated.

## Deploy checklist

Before pointing this at real money:

1. Set `ADMIN_TOKEN` to a strong random value.
2. Enable `REQUIRE_API_KEY=1` so agents authenticate with a real key, not `X-Agent-Id`.
3. Keep `allowPrivateTargets` **off** (the default).
4. Put the gateway behind TLS, and only set `HOST=0.0.0.0` when it's properly fronted.
5. Point `LEDGER_FILE` / `AUDIT_FILE` / `APPROVALS_FILE` / `APIKEYS_FILE` at durable storage.
6. Configure each agent's policy with explicit caps and, for large payments, `requireApprovalOver`.

## Reporting

This is an MVP / portfolio project. If you find an issue, open a GitHub issue
(or, for something sensitive, contact the maintainer privately) rather than
filing it publicly with exploit detail.
