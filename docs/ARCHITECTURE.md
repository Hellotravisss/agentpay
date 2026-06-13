# Architecture

This document explains *how agentpay is built and why*. For what it is and how
to run it, see the [README](../README.md).

agentpay is a **forward proxy that holds the spending authority an agent must
not**. An agent calls a paid resource *through* the gateway; the gateway speaks
the `402 Payment Required` handshake, decides whether the spend is allowed under
that agent's policy, executes the payment on a rail it controls, and returns the
unlocked response. The agent never sees a key.

## Design principles

These four constraints drove every decision below.

1. **Agents never hold credentials.** Payment keys live inside rail callbacks
   the operator supplies. The gateway core moves money but never sees a secret,
   so a compromised agent leaks at most its *policy-bounded* spend, not a wallet.
2. **Deny by default.** An agent with no policy entry cannot spend at all. New
   capability is opt-in, never inherited.
3. **Exact money, never floats.** Every amount is a `bigint` in micro-units
   (6 dp, USDC precision). No `Number` ever touches an amount. FX conversion
   rounds *up* so a budget is never accidentally overspent by a rounding error.
4. **The policy engine is pure.** `evaluate()` is a function of
   `(policy, context, ledger, rates)` with no clock or IO. Every decision is
   reproducible — the same inputs always yield the same allow/deny, which makes
   the rules testable and replayable.

## The request lifecycle

A single `GET /proxy?url=<target>` call drives the whole flow. Steps 3–9 only
run if the target actually charges (responds `402`); a free resource short-
circuits at step 2.

```
agent ──▶ /proxy?url=…                  src/gateway/server.ts
  │
  1  authenticate            resolveAgentId()   Bearer key → agentId, or X-Agent-Id
  2  forward upstream        fetch(target)      not 402? relay verbatim, done
  3  parse the 402           parseRequirements()  collect EVERY accepted option
  4  resolve policy          resolvePolicy()    no entry → 403 policy_missing (audit)
  5  route to one rail       route()            railPreference, then cheapest in base ccy
  ·  warm live FX (if any)   rates.refresh()    best-effort, before the sync rate() reads below
  6  check the policy        evaluate()         first violated rule wins → 403 (audit)
  ·  hold over threshold     approvals          amount >= requireApprovalOver → 202 held (audit)
  7  execute on the rail     rail.pay(ctx)      failure → 502 payment_failed (audit)
  8  record + audit          ledger.record()    convert to base ccy, append receipt
  9  retry with proof        fetch(+X-PAYMENT)  return unlocked body + X-Gateway-* headers
```

The hold step (`·` after policy) is the human-in-the-loop gate: when the
base-currency amount meets the agent's `requireApprovalOver`, the request gets
`202` + an `approvalId` instead of paying. An operator decides via
`POST /admin/approvals/:id`; the agent's retry re-enters the lifecycle and, on a
matching *approved* token, proceeds to step 7. The token is consumed once, and
the budget check at step 6 runs again on the retry — approval never bypasses it.

Every terminal branch that denies, fails, or executes writes to the audit log,
so the trail explains *why* a request did or didn't move money — not just that
it failed.

## Module map

| Module | Responsibility | Key idea |
|---|---|---|
| [`money.ts`](../src/money.ts) | Decimal ⇄ `bigint` micro-units | One scale (1e6); parse/format are the only boundary where strings meet integers |
| [`fx/rates.ts`](../src/fx/rates.ts) | Cross-currency conversion | Directional rates, round-up `convert()`; `RateProvider` is the swappable seam |
| [`fx/caching.ts`](../src/fx/caching.ts) | Live FX with caching | Async `refresh()` warms a cache that sync `rate()` serves; TTL + hard staleness limit |
| [`policy/engine.ts`](../src/policy/engine.ts) | The allow/deny decision | Pure function; rules checked cheapest-first, first violation wins |
| [`ledger/ledger.ts`](../src/ledger/ledger.ts) | Append-only spend record | Rolls every rail up into the base currency; UTC day/month windows |
| [`audit/audit.ts`](../src/audit/audit.ts) | Append-only decision log | Records denials, failures, and holds — not just successes |
| [`approvals/approvals.ts`](../src/approvals/approvals.ts) | Held-payment store | Human-in-the-loop gate; snapshot-append state so it persists over an append-only store |
| [`store/store.ts`](../src/store/store.ts) | Persistence backends | One `RecordStore` interface; JSONL or transactional SQLite (`node:sqlite`) |
| [`gateway/server.ts`](../src/gateway/server.ts) | The proxy + router + admin API | Orchestrates the lifecycle above; `route()` lives here |
| [`gateway/dashboard.html`](../src/gateway/dashboard.html) | Admin dashboard | One self-contained page served at `GET /admin`; reads the `/admin/*` JSON — a view, not a new data path |
| [`rails/rail.ts`](../src/rails/rail.ts) | The rail interface | `supports(network)` + `pay(ctx)` — the only seam between core and money movement |

## Key design decisions

### Money is a `bigint`, not a `Decimal` library

Amounts are integers of micro-units. There is no dependency on a decimal
library because the only operations that matter — add, compare, multiply by a
scaled rate — are exact on `bigint`. Strings (`"0.05"`) appear only at the API
boundary; `parseAmount`/`formatAmount` in [`money.ts`](../src/money.ts) are the
single crossing point. This is why "no floats anywhere near amounts" is a
property you can actually verify rather than a hope.

### FX rounds up, and rates are directional

[`convert()`](../src/fx/rates.ts) rounds *up*: when a budget check is uncertain
at the sub-micro-unit level, it errs toward *denying* the spend, never toward
overshooting the limit. Rates are stored as one-directional pairs
(`"CNY:USD"`) on purpose — taking the `bigint` inverse of a rate loses
precision, so if you need both directions you declare both. A payment in a
currency with no path to the base currency is denied (`no_fx_rate`) rather than
silently assumed 1:1.

### One budget governs every rail

A receipt carries both its native amount (`0.36 CNY`) and a `baseAmount`
converted at execution time (`0.0504 USD`). The ledger's
[`spentSince()`](../src/ledger/ledger.ts) sums `baseAmount`, so a single
`dailyBudget: "0.15"` in USD constrains USDC and CNY spend together. This is the
cross-rail unification: limits live in one currency the operator reasons about,
while payments settle in whatever each merchant accepts.

### Routing: preference first, then price

When a merchant accepts several options, [`route()`](../src/gateway/server.ts)
ranks the `(requirement, rail)` candidates by the agent's `railPreference`
order, breaking ties by the cheapest cost *in the base currency* (so a CNY and a
USDC option are compared apples-to-apples). Options on networks no configured
rail can settle are dropped; unconvertible options rank last. The agent expresses
intent ("prefer my crypto rail"); the gateway optimizes cost within that intent.

### Rails are the only extension seam

Everything money-specific is behind the two-method
[`PaymentRail`](../src/rails/rail.ts) interface. Adding x402 mainnet, Alipay
ACT, or AP2 means writing one `pay()` — it never touches policy, FX, routing, or
the ledger. The included [`X402Rail`](../src/rails/x402.ts) pairs with
[`createEip3009Signer`](../src/rails/x402-signer.ts), which produces a real,
cryptographically-verifiable EIP-3009 `transferWithAuthorization` signature
offline; the operator's facilitator settles it on-chain. The gateway needs no
RPC connection — only the signing happens here, and the key stays in the
callback.

## How the seams paid off

The four originally-deferred features all landed without touching the core,
because each had a seam waiting for it:

- **Persistence** became one `RecordStore` interface
  ([`store/store.ts`](../src/store/store.ts)) with a JSONL and a SQLite backend.
  `SpendLedger`/`AuditLog`/`ApprovalStore` take an optional store and replay it
  at construction; with no store they stay in-memory, so the in-memory query
  engines never changed. The append-only `ApprovalStore` handles mutable status
  by appending a fresh snapshot per change and reducing by id on load.
- **Live FX** slotted behind the existing `RateProvider`.
  [`CachingRateProvider`](../src/fx/caching.ts) keeps `rate()` synchronous (the
  pure policy engine still can't await) by serving from a cache that the gateway
  warms with an async `refresh()` before it routes. Past the staleness limit it
  returns `undefined`, which the engine already treats as `no_fx_rate`.
- **Human-in-the-loop** is a gate between the policy decision and execution —
  exactly where no money has moved yet. It reuses the audit log and adds three
  events (`payment_held`/`approved`/`rejected`).

## What's still deliberately simple

- **Budget windows are UTC calendar day/month.** Computed in
  [`ledger.ts`](../src/ledger/ledger.ts), not rolling windows — predictable and
  cheap, at the cost of a midnight reset.
- **Approval matching is by value, single-use.** A held payment is matched back
  to its retry by (agent, payee, amount, currency, resource) and consumed once;
  there's no reservation, so two large holds are each re-checked against the
  budget at execution time rather than up front.
- **SQLite stores a JSON blob per row.** Durable and externally queryable, but
  the in-memory query engine still does the filtering; pushing budget queries
  into SQL would matter only at a scale this MVP doesn't target.

See the [roadmap](../README.md#status--roadmap) for what's next.
