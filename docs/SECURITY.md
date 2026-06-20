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
- **x402 asset allowlist** — the EIP-3009 signer refuses to sign for any token
  not on a per-network allowlist (default: canonical USDC), so a malicious `402`
  can't trick the wallet into authorizing a transfer of a different, more
  valuable token. Authorization validity is clamped (`maxAuthorizationSeconds`).
- **No double-spend under concurrency** — the decide → execute → record window
  is serialized per agent, so concurrent payments can't both pass the budget
  check (which reads the ledger) before either is recorded.
- **DoS limits** — 1 MiB request-body cap (`413`), 30 s upstream fetch timeout,
  and the upstream response is streamed, never buffered whole into memory.
- **Money & credential integrity** — exact `bigint` arithmetic (no floats near
  amounts), FX rounds up (budget-conservative), API keys stored only as
  SHA-256 hashes (raw secret shown once), and the upstream `Authorization`
  header is never forwarded to merchants.

Each item above has regression coverage in [`test/security.test.ts`](../test/security.test.ts).

## Known residuals

Called out so they aren't silent. Neither bites a deployment that follows the
checklist below.

- **Admin CSRF** — only if the operator runs with **no `ADMIN_TOKEN`** *and*
  exposes the port to a browser. Setting a token or keeping the loopback bind
  removes it.
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
