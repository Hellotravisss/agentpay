import type { AuditEntry, AuditEvent } from "../types.js";
import type { RecordStore } from "../store/store.js";

/**
 * Append-only audit trail of every payment decision the gateway makes —
 * denials included. This is the compliance artifact: "which agent paid whom,
 * how much, why was it allowed, and who got blocked". Optionally mirrored to a
 * persistence backend (JSONL or SQLite).
 */
export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private readonly store?: RecordStore<AuditEntry>) {
    if (store) this.entries = store.all();
  }

  log(event: AuditEvent, agentId: string, details: Record<string, unknown>, timestamp = Date.now()): AuditEntry {
    const entry: AuditEntry = { timestamp, event, agentId, details };
    this.entries.push(entry);
    this.store?.append(entry);
    return entry;
  }

  tail(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit);
  }

  forAgent(agentId: string, limit = 50): AuditEntry[] {
    return this.entries.filter((e) => e.agentId === agentId).slice(-limit);
  }
}
