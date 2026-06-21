import type { AgentPolicy, PolicyConfig } from "../types.js";
import { resolvePolicy } from "./engine.js";
import { parseAmount } from "../money.js";

/**
 * Owns the live policy config so it can change at runtime — via the admin API
 * or a hot-reloaded file — without restarting the gateway. The gateway reads
 * every decision through this manager, so an edit takes effect on the next
 * request.
 *
 * `persist` (optional) is called after an API edit to write the change back to
 * disk. Hot-reload (`reload`) does NOT call it, and `reload` no-ops when the
 * incoming file is byte-equivalent to the current agents/defaults — together
 * those break the write → file-watch → reload loop.
 */
export class PolicyManager {
  private config: PolicyConfig;

  constructor(config: PolicyConfig, private readonly persist?: (config: PolicyConfig) => void) {
    this.config = config;
  }

  snapshot(): PolicyConfig {
    return this.config;
  }

  resolve(agentId: string): AgentPolicy | undefined {
    return resolvePolicy(this.config, agentId);
  }

  /** Every configured agent with config defaults applied. */
  listResolved(): AgentPolicy[] {
    return this.config.agents.map((a) => resolvePolicy(this.config, a.agentId)!);
  }

  /** Add or replace one agent's policy and persist the change. */
  upsertAgent(agent: AgentPolicy): void {
    const agents = this.config.agents.filter((a) => a.agentId !== agent.agentId);
    agents.push(agent);
    this.config = { ...this.config, agents };
    this.persist?.(this.config);
  }

  /** Remove an agent (it reverts to deny-by-default). Returns false if absent. */
  removeAgent(agentId: string): boolean {
    const agents = this.config.agents.filter((a) => a.agentId !== agentId);
    if (agents.length === this.config.agents.length) return false;
    this.config = { ...this.config, agents };
    this.persist?.(this.config);
    return true;
  }

  /**
   * Replace agents + defaults from a reloaded file. Returns whether anything
   * actually changed (false → caller can skip the work, and self-writes from
   * `persist` are ignored). fxRates are intentionally not hot-reloaded — the
   * RateProvider is built once at startup.
   */
  reload(next: PolicyConfig): boolean {
    const key = (c: PolicyConfig) => JSON.stringify({ agents: c.agents, defaults: c.defaults });
    if (key(next) === key(this.config)) return false;
    this.config = { ...this.config, agents: next.agents, defaults: next.defaults };
    return true;
  }
}

const AMOUNT_FIELDS = ["perTransactionMax", "dailyBudget", "monthlyBudget", "requireApprovalOver"] as const;

/**
 * Validate untrusted JSON (from the admin API) into an AgentPolicy. Throws an
 * Error with a human-readable message on bad input; the caller maps that to a
 * 400. `agentId` falls back to the one from the URL path.
 */
export function validateAgentPolicy(input: unknown, agentIdFromPath: string): AgentPolicy {
  if (typeof input !== "object" || input === null) throw new Error("Body must be a JSON object");
  const o = input as Record<string, unknown>;

  if (typeof o.agentId === "string" && o.agentId && o.agentId !== agentIdFromPath) {
    throw new Error("agentId in body must match the URL");
  }
  const agentId = agentIdFromPath || (typeof o.agentId === "string" ? o.agentId : "");
  if (!agentId) throw new Error("agentId is required");

  if (typeof o.currency !== "string" || !o.currency) throw new Error("currency is required");

  const policy: AgentPolicy = {
    agentId,
    enabled: o.enabled === undefined ? true : Boolean(o.enabled),
    currency: o.currency,
  };

  for (const f of AMOUNT_FIELDS) {
    if (o[f] === undefined || o[f] === null || o[f] === "") continue;
    if (typeof o[f] !== "string") throw new Error(`${f} must be a decimal string`);
    parseAmount(o[f] as string); // throws on a malformed amount
    policy[f] = o[f] as string;
  }

  if (o.maxTransactionsPerDay !== undefined && o.maxTransactionsPerDay !== null) {
    const v = o.maxTransactionsPerDay;
    if (typeof v !== "number" && typeof v !== "string") throw new Error("maxTransactionsPerDay must be a number"); // reject arrays/objects/booleans
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error("maxTransactionsPerDay must be a non-negative integer");
    policy.maxTransactionsPerDay = n;
  }

  for (const f of ["railPreference", "payeeAllowlist", "payeeBlocklist"] as const) {
    if (o[f] === undefined || o[f] === null) continue;
    if (!Array.isArray(o[f]) || (o[f] as unknown[]).some((v) => typeof v !== "string")) {
      throw new Error(`${f} must be an array of strings`);
    }
    policy[f] = o[f] as string[];
  }

  return policy;
}
