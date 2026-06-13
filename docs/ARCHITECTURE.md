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
  6  check the policy        evaluate()         first violated rule wins → 403 (audit)
  7  execute on the rail     rail.pay(ctx)      failure → 502 payment_failed (audit)
  8  record + audit          ledger.record()    convert to base ccy, append receipt
  9  retry with proof        fetch(+X-PAYMENT)  return unlocked body + X-Gateway-* headers
```

Every terminal branch that denies, fails, or executes writes to the audit log,
so the trail explains *why* a request did or didn't move money — not just that
it failed.

## Module map

| Module | Responsibility | Key idea |
|---|---|---|
| [`money.ts`](../src/money.ts) | Decimal ⇄ `bigint` micro-units | One scale (1e6); parse/format are the only boundary where strings meet integers |
| [`fx/rates.ts`](../src/fx/rates.ts) | Cross-currency conversion | Directional rates, round-up `convert()`; `RateProvider` is swappable for a live source |
| [`policy/engine.ts`](../src/policy/engine.ts) | The allow/deny decision | Pure function; rules checked cheapest-first, first violation wins |
| [`ledger/ledger.ts`](../src/ledger/ledger.ts) | Append-only spend record | Rolls every rail up into the base currency; UTC day/month windows; optional JSONL persistence |
| [`audit/audit.ts`](../src/audit/audit.ts) | Append-only decision log | Records denials and failures, not just successes |
| [`gateway/server.ts`](../src/gateway/server.ts) | The proxy + router + admin API | Orchestrates the lifecycle above; `route()` lives here |
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

## What's deliberately simple (and where it would grow)

This is an MVP; some choices trade durability for clarity, and the seams to
upgrade them already exist:

- **Storage is in-memory + optional JSONL.** The ledger and audit log replay
  from append-only files on startup. Swapping in SQLite/Postgres is a matter of
  reimplementing `SpendLedger`/`AuditLog` behind their current method shapes —
  nothing else reads the storage directly.
- **FX is a static table.** `FixedRateProvider` implements `RateProvider`; a
  live provider with caching and staleness limits drops in at the same seam
  without the policy engine knowing.
- **Budget windows are UTC calendar day/month.** Computed in
  [`ledger.ts`](../src/ledger/ledger.ts) via `startOfUtcDay`/`startOfUtcMonth`,
  not rolling windows — predictable and cheap, at the cost of a midnight reset.
- **No human-in-the-loop yet.** Every approved payment executes immediately.
  A "hold payments over $X" gate would sit between steps 6 and 7 of the
  lifecycle, where the decision is already made but no money has moved.

See the [roadmap](../README.md#status--roadmap) for the full list.
