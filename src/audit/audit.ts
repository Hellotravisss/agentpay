import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { AuditEntry, AuditEvent } from "../types.js";

/**
 * Append-only audit trail of every payment decision the gateway makes —
 * denials included. This is the compliance artifact: "which agent paid whom,
 * how much, why was it allowed, and who got blocked".
 */
export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private readonly persistPath?: string) {
    if (persistPath && existsSync(persistPath)) {
      const lines = readFileSync(persistPath, "utf8").split("\n").filter(Boolean);
      this.entries = lines.map((l) => JSON.parse(l) as AuditEntry);
    }
  }

  log(event: AuditEvent, agentId: string, details: Record<string, unknown>, timestamp = Date.now()): AuditEntry {
    const entry: AuditEntry = { timestamp, event, agentId, details };
    this.entries.push(entry);
    if (this.persistPath) {
      appendFileSync(this.persistPath, JSON.stringify(entry) + "\n");
    }
    return entry;
  }

  tail(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit);
  }

  forAgent(agentId: string, limit = 50): AuditEntry[] {
    return this.entries.filter((e) => e.agentId === agentId).slice(-limit);
  }
}
