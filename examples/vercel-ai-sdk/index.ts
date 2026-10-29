// Vercel AI SDK + agentpay: the gateway's MCP tools drop into generateText like any other tools.
// Start the playground first: npx -p agentpay-gateway agentpay-demo
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, isStepCount } from "ai";

const shop = process.env.DEMO_SHOP ?? "http://127.0.0.1:4021";

const agentpay = await createMCPClient({
  transport: new Experimental_StdioMCPTransport({
    command: "npx",
    args: ["-y", "-p", "agentpay-gateway", "agentpay-mcp"],
    env: {
      ...(process.env as Record<string, string>),
      AGENTPAY_URL: process.env.AGENTPAY_URL ?? "http://127.0.0.1:4020",
      AGENTPAY_AGENT_ID: process.env.AGENTPAY_AGENT_ID ?? "demo-agent", // production: AGENTPAY_API_KEY
    },
  }),
});

try {
  const { text, steps } = await generateText({
    model: anthropic(process.env.MODEL ?? "claude-haiku-4-5"),
    tools: await agentpay.tools(),
    stopWhen: isStepCount(8),
    prompt: `Fetch ${shop}/weather, ${shop}/market-report and ${shop}/dataset with paid_fetch. ` +
      "Then check my budget and tell me, for each URL, whether it was paid, held for approval, or denied.",
  });
  for (const call of steps.flatMap((s) => s.toolCalls)) console.log(`→ ${call.toolName}`, JSON.stringify(call.input));
  console.log(`\n${text}`);
} finally {
  await agentpay.close();
}
