#!/usr/bin/env node
import { runStdio } from "./server.js";

const gatewayUrl = process.env.AGENTPAY_URL ?? "http://127.0.0.1:4020";
const apiKey = process.env.AGENTPAY_API_KEY;
const agentId = process.env.AGENTPAY_AGENT_ID;
if (!apiKey && !agentId) {
  process.stderr.write("agentpay-mcp: set AGENTPAY_API_KEY (or AGENTPAY_AGENT_ID for a dev gateway)\n");
  process.exit(1);
}
runStdio({ gatewayUrl, apiKey, agentId });
