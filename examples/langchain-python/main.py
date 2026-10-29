"""LangChain + agentpay: MCP tools from the gateway become ordinary LangChain
tools. Start the playground first:
    npx -p agentpay-gateway agentpay-demo
"""
import asyncio
import os

from langchain.agents import create_agent
from langchain_mcp_adapters.client import MultiServerMCPClient

SHOP = os.environ.get("DEMO_SHOP", "http://127.0.0.1:4021")


async def main() -> None:
    client = MultiServerMCPClient(
        {
            "agentpay": {
                "transport": "stdio",
                "command": "npx",
                "args": ["-y", "-p", "agentpay-gateway", "agentpay-mcp"],
                "env": {
                    **os.environ,
                    "AGENTPAY_URL": os.environ.get("AGENTPAY_URL", "http://127.0.0.1:4020"),
                    # production: AGENTPAY_API_KEY (minted via POST /admin/keys) instead of an agent id
                    "AGENTPAY_AGENT_ID": os.environ.get("AGENTPAY_AGENT_ID", "demo-agent"),
                },
            }
        }
    )
    agent = create_agent(os.environ.get("MODEL", "anthropic:claude-haiku-4-5"), await client.get_tools())
    result = await agent.ainvoke(
        {
            "messages": f"Fetch {SHOP}/weather, {SHOP}/market-report and {SHOP}/dataset with paid_fetch. "
            "Then check my budget and tell me, for each URL, whether it was paid, held for approval, or denied."
        }
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
