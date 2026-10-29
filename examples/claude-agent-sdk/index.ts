// Claude Agent SDK + agentpay: Claude can pay for APIs, but only within the
// budget the gateway enforces. Start the playground first: npx -p agentpay-gateway agentpay-demo
import { query } from "@anthropic-ai/claude-agent-sdk";

const shop = process.env.DEMO_SHOP ?? "http://127.0.0.1:4021";

for await (const message of query({
  prompt: `Fetch ${shop}/weather, ${shop}/market-report and ${shop}/dataset with paid_fetch. ` +
    "Then check my budget and tell me, for each URL, whether it was paid, held for approval, or denied.",
  options: {
    mcpServers: {
      agentpay: {
        command: "npx",
        args: ["-y", "-p", "agentpay-gateway", "agentpay-mcp"],
        env: {
          AGENTPAY_URL: process.env.AGENTPAY_URL ?? "http://127.0.0.1:4020",
          // production: AGENTPAY_API_KEY (minted via POST /admin/keys) instead of an agent id
          AGENTPAY_AGENT_ID: process.env.AGENTPAY_AGENT_ID ?? "demo-agent",
        },
      },
    },
    allowedTools: ["mcp__agentpay__paid_fetch", "mcp__agentpay__check_budget"],
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") console.log(`→ ${block.name}`, JSON.stringify(block.input));
    }
  } else if (message.type === "result" && message.subtype === "success") {
    console.log(`\n${message.result}`);
  }
}
