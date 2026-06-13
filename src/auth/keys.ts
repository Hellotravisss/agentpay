import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiKey } from "../types.js";
import type { RecordStore } from "../store/store.js";

/** Stored form: the public ApiKey plus the secret's hash (never the secret). */
interface StoredKey extends ApiKey {
  hash: string;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const sanitize = ({ hash, ...pub }: StoredKey): ApiKey => pub;

/**
 * Multi-tenant API keys. Each key authenticates a caller as one agent; an
 * agent can hold several (rotation). The raw secret is returned once at
 * creation — only its SHA-256 hash is persisted, so a leaked store reveals no
 * usable credentials. (Plain SHA-256 is appropriate here: keys are
 * high-entropy random tokens, not low-entropy passwords, so there is nothing
 * to brute-force.)
 *
 * Persistence is snapshot-append (like approvals): each mutation appends the
 * full current key, and `all()` is reduced by id on load. `lastUsedAt` is
 * tracked in memory only — it changes every request and persisting it would
 * amplify writes without buying much.
 */
export class ApiKeyStore {
  private readonly byId = new Map<string, StoredKey>();
  private readonly byHash = new Map<string, string>(); // secret hash -> key id
  private readonly now: () => number;

  // The store is typed RecordStore<ApiKey> (a nameable public type); the rows it
  // holds carry an extra `hash` at runtime, recovered with a cast on load.
  constructor(private readonly store?: RecordStore<ApiKey>, now: () => number = Date.now) {
    this.now = now;
    if (store) {
      for (const k of store.all() as StoredKey[]) {
        this.byId.set(k.id, k);
        this.byHash.set(k.hash, k.id);
      }
    }
  }

  private persist(k: StoredKey): void {
    this.byId.set(k.id, k);
    this.byHash.set(k.hash, k.id);
    this.store?.append(k);
  }

  /** Mint a key for an agent. Returns the one-time secret alongside the record. */
  create(label: string, agentId: string, opts?: { expiresAt?: number }): { apiKey: ApiKey; secret: string } {
    const secret = "ak_" + randomBytes(24).toString("base64url");
    const k: StoredKey = {
      id: randomUUID(),
      label,
      agentId,
      hash: sha256(secret),
      createdAt: this.now(),
      expiresAt: opts?.expiresAt,
    };
    this.persist(k);
    return { apiKey: sanitize(k), secret };
  }

  /** Resolve a presented secret to its agentId, or undefined if it's not valid. */
  verify(secret: string): string | undefined {
    const id = this.byHash.get(sha256(secret));
    if (!id) return undefined;
    const k = this.byId.get(id)!;
    if (k.revokedAt !== undefined) return undefined;
    if (k.expiresAt !== undefined && this.now() >= k.expiresAt) return undefined;
    k.lastUsedAt = this.now(); // in-memory only
    return k.agentId;
  }

  /** Revoke a key permanently. Returns false if unknown or already revoked. */
  revoke(id: string): boolean {
    const k = this.byId.get(id);
    if (!k || k.revokedAt !== undefined) return false;
    this.persist({ ...k, revokedAt: this.now() });
    return true;
  }

  get(id: string): ApiKey | undefined {
    const k = this.byId.get(id);
    return k ? sanitize(k) : undefined;
  }

  list(): ApiKey[] {
    return [...this.byId.values()].sort((a, b) => a.createdAt - b.createdAt).map(sanitize);
  }
}
