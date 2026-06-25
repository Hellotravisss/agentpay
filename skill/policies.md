# Policy templates & field reference

Bundled with the `agent-spend-control` skill. Copy a template into
`policies/example.json` (or whatever `POLICY_FILE` points at) and adjust. All
amounts are **decimal strings** in the agent's `currency`. Policies are
**deny-by-default** — an agent with no entry cannot spend.

## Field reference (one agent entry)

| Field | Type | Meaning |
|---|---|---|
| `agentId` | string (required) | How the agent identifies itself (`X-Agent-Id` or via its API key). |
| `enabled` | boolean | `false` → all spend denied (`agent_disabled`). |
| `currency` | string (required) | Base currency; every limit below is in it, enforced across all rails via FX. |
| `perTransactionMax` | string | Cap on any single payment. |
| `dailyBudget` | string | Spend cap per UTC calendar day, across all rails/currencies. |
| `monthlyBudget` | string | Spend cap per UTC calendar month. |
| `maxTransactionsPerDay` | number | Count cap per UTC day. |
| `requireApprovalOver` | string | Payments ≥ this are held (`202`) for human approval. |
| `railPreference` | string[] | Routing order when a merchant accepts several rails; ties broken by cheapest in base currency. |
| `payeeAllowlist` | string[] | If present, ONLY these payees are allowed (checked before blocklist). |
| `payeeBlocklist` | string[] | These payees are always denied. |

Top-level: `fxRates` (directional pairs like `"CNY:USD":"0.14"`; a payment in a
currency with no rate to the agent's base is denied `no_fx_rate`), `defaults`
(applied to every agent unless overridden), `agents` (the list).

---

## Template: cautious research bot (paid APIs, small budget)

```json
{
  "fxRates": { "USDC:USD": "1" },
  "agents": [{
    "agentId": "research-bot",
    "enabled": true,
    "currency": "USD",
    "perTransactionMax": "0.10",
    "dailyBudget": "2.00",
    "monthlyBudget": "20.00",
    "maxTransactionsPerDay": 100,
    "requireApprovalOver": "0.50"
  }]
}
```

## Template: purchasing agent (larger buys, human gate, allowlist)

```json
{
  "fxRates": { "USDC:USD": "1", "CNY:USD": "0.14" },
  "agents": [{
    "agentId": "buyer",
    "enabled": true,
    "currency": "USD",
    "perTransactionMax": "50.00",
    "dailyBudget": "200.00",
    "requireApprovalOver": "20.00",
    "payeeAllowlist": ["merchant-flights", "merchant-hotels"]
  }]
}
```

## Template: a fleet (shared defaults, per-agent overrides)

```json
{
  "fxRates": { "USDC:USD": "1" },
  "defaults": { "enabled": true, "currency": "USD", "perTransactionMax": "1.00", "dailyBudget": "10.00", "maxTransactionsPerDay": 200 },
  "agents": [
    { "agentId": "bot-a" },
    { "agentId": "bot-b", "dailyBudget": "50.00", "requireApprovalOver": "5.00" },
    { "agentId": "bot-c", "enabled": false }
  ]
}
```

## Template: crypto-only (x402 / USDC), no fiat

```json
{
  "fxRates": { "USDC:USD": "1" },
  "agents": [{
    "agentId": "x402-bot",
    "enabled": true,
    "currency": "USD",
    "perTransactionMax": "0.25",
    "dailyBudget": "5.00",
    "railPreference": ["x402"]
  }]
}
```

## Template: cross-rail, one budget (USDC + CNY under one USD cap)

```json
{
  "fxRates": { "USDC:USD": "1", "CNY:USD": "0.14" },
  "agents": [{
    "agentId": "global-bot",
    "enabled": true,
    "currency": "USD",
    "perTransactionMax": "1.00",
    "dailyBudget": "10.00",
    "railPreference": ["x402", "alipay-act"]
  }]
}
```
A 0.36 CNY purchase consumes ~0.0504 USD of the daily budget; a 0.05 USDC
purchase consumes 0.05 USD. One USD budget governs both.

---

Edits take effect on the next request — live via `PUT /admin/agents/:id`, or by
editing the policy file (hot-reloaded). FX rate changes need a restart.
