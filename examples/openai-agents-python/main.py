"""OpenAI Agents SDK + agentpay: the agent pays for APIs through the gateway,
which enforces the budget. Start the playground first:
    npx -p agentpay-gateway agentpay-demo
"""
import asyncio
import os

from agents import Agent, Runner
from agents.mcp import MCPServerStdio

SHOP = os.environ.get("DEMO_SHOP", "http://127.0.0.1:4021")


async def main() -> None:
    async with MCPServerStdio(
        name="agentpay",
        params={
            "command": "npx",
            "args": ["-y", "-p", "agentpay-gateway", "agentpay-mcp"],
            "env": {
                **os.environ,
                "AGENTPAY_URL": os.environ.get("AGENTPAY_URL", "http://127.0.0.1:4020"),
                # production: AGENTPAY_API_KEY (minted via POST /admin/keys) instead of an agent id
                "AGENTPAY_AGENT_ID": os.environ.get("AGENTPAY_AGENT_ID", "demo-agent"),
            },
        },
    ) as agentpay:
        agent = Agent(
            name="Buyer",
            instructions="Use paid_fetch for URLs that may cost money. Never try to work around a denial.",
            mcp_servers=[agentpay],
        )
        result = await Runner.run(
            agent,
            f"Fetch {SHOP}/weather, {SHOP}/market-report and {SHOP}/dataset with paid_fetch. "
            "Then check my budget and tell me, for each URL, whether it was paid, held for approval, or denied.",
        )
        print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
