# Framework examples

The same agentpay MCP server, dropped into four agent frameworks. In every one the agent can pay for APIs, but the gateway — not the agent — holds the wallet and enforces the budget.

| Framework | Language | Folder |
| --- | --- | --- |
| Claude Agent SDK | TypeScript | [`claude-agent-sdk`](claude-agent-sdk) |
| Vercel AI SDK | TypeScript | [`vercel-ai-sdk`](vercel-ai-sdk) |
| OpenAI Agents SDK | Python | [`openai-agents-python`](openai-agents-python) |
| LangChain | Python | [`langchain-python`](langchain-python) |

## Run one in two minutes

**1. Start the playground** — a gateway with mock settlement (no real money) and a toy paid API:

```bash
npx -p agentpay-gateway agentpay-demo
```

Its three endpoints land on the three outcomes:

| Endpoint | Price | Under the demo policy |
| --- | --- | --- |
| `/weather` | $0.05 | paid |
| `/market-report` | $0.50 | held for human approval (threshold $0.25) |
| `/dataset` | $5.00 | denied (cap $1.00 per transaction) |

**2. Run an example** in a second terminal:

```bash
# TypeScript
cd claude-agent-sdk && npm install && ANTHROPIC_API_KEY=... npm start
cd vercel-ai-sdk    && npm install && ANTHROPIC_API_KEY=... npm start

# Python
pip install -r openai-agents-python/requirements.txt && OPENAI_API_KEY=... python openai-agents-python/main.py
pip install -r langchain-python/requirements.txt     && ANTHROPIC_API_KEY=... python langchain-python/main.py
```

Each agent fetches all three endpoints and reports what happened. Approve the held one at `http://127.0.0.1:4020/admin`, ask again, and it goes through.

## Going to production

- Point `AGENTPAY_URL` at your own gateway (`npx agentpay-gateway`, with your policy file).
- Replace `AGENTPAY_AGENT_ID` with `AGENTPAY_API_KEY`, minted per agent via `POST /admin/keys`, and set `REQUIRE_API_KEY=1` on the gateway.
- For real USDC settlement, wire the x402 rail — see the main [README](../README.md).
