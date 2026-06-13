import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Append-only persistence backend for the ledger, audit log, and approvals.
 *
 * Every store keeps the full history in memory (the query engines in
 * SpendLedger / AuditLog operate on arrays) and mirrors each appended row to
 * durable storage so state survives a restart. `all()` is called once at
 * construction to replay history.
 *
 * Two backends ship:
 *   - JsonlStore   — one JSON object per line; greppable, zero dependencies.
 *   - SqliteStore  — a single transactional file via Node's built-in
 *                    `node:sqlite`; durable and inspectable with any SQL tool.
 */
export interface RecordStore<T> {
  /** Persist one row. Must be durable before returning. */
  append(row: T): void;
  /** Replay every row in insertion order. Called once at startup. */
  all(): T[];
}

/** Append-only JSONL file: one JSON object per line. */
export class JsonlStore<T> implements RecordStore<T> {
  constructor(private readonly path: string) {}

  append(row: T): void {
    appendFileSync(this.path, JSON.stringify(row) + "\n");
  }

  all(): T[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  }
}

/**
 * SQLite-backed store using Node's built-in `node:sqlite` (Node >= 22.5).
 * Each store gets its own table holding an auto-incrementing `seq` and the
 * row serialized as JSON, so the in-memory query engines are unchanged while
 * gaining atomic, single-file, externally-queryable durability.
 *
 * node:sqlite is loaded lazily so the experimental-feature warning only fires
 * when a SQLite store is actually opened (not for JSONL / in-memory setups).
 */
export class SqliteStore<T> implements RecordStore<T> {
  private readonly insert: { run(arg: string): unknown };
  private readonly select: { all(): Array<{ data: string }> };

  constructor(path: string, table: string) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      throw new Error(`Invalid SQLite table name ${JSON.stringify(table)}`);
    }
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)`);
    this.insert = db.prepare(`INSERT INTO ${table} (data) VALUES (?)`) as unknown as typeof this.insert;
    this.select = db.prepare(`SELECT data FROM ${table} ORDER BY seq`) as unknown as typeof this.select;
  }

  append(row: T): void {
    this.insert.run(JSON.stringify(row));
  }

  all(): T[] {
    return this.select.all().map((r) => JSON.parse(r.data) as T);
  }
}

/**
 * Open a store from a file path: a `.sqlite` extension selects the SQLite
 * backend, anything else uses JSONL. `table` names the SQLite table (ignored
 * for JSONL).
 */
export function openStore<T>(path: string, table: string): RecordStore<T> {
  return path.endsWith(".sqlite") ? new SqliteStore<T>(path, table) : new JsonlStore<T>(path);
}
