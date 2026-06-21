import { MONEY_SCALE } from "../money.js";
import type { RateProvider } from "./rates.js";

/**
 * Live FX with caching and staleness limits, layered on the synchronous
 * RateProvider seam the policy engine and router depend on.
 *
 * `rate()` stays synchronous and serves only from cache; the gateway calls
 * `refresh()` (async, best-effort) before it routes/evaluates so the cache is
 * warm. Two clocks govern a cached rate:
 *   - ttlMs:          older than this and refresh() re-fetches it.
 *   - maxStalenessMs: older than this and rate() returns undefined — a payment
 *                     in that currency is denied rather than priced on a stale
 *                     rate. (maxStaleness >= ttl; the gap absorbs fetch outages.)
 *
 * `pinned` rates (e.g. a stablecoin peg USDC:USD = 1) never expire and are
 * never fetched.
 */
export interface RefreshableRateProvider extends RateProvider {
  /** Best-effort: make the given directional pairs fresh enough to serve. */
  refresh(pairs: Array<[from: string, to: string]>): Promise<void>;
}

/** Fetch one directional rate as a scaled (6-dp) bigint, or undefined if unavailable. */
export type RateFetcher = (from: string, to: string) => Promise<bigint | undefined>;

export interface CachingRateProviderOptions {
  fetcher: RateFetcher;
  ttlMs: number;
  maxStalenessMs: number;
  /** Rates that never expire and are never fetched, e.g. { "USDC:USD": "1" }. */
  pinned?: Record<string, string>;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface CacheEntry {
  rate: bigint;
  fetchedAt: number;
}

export class CachingRateProvider implements RefreshableRateProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pinned: Record<string, bigint>;
  private readonly fetcher: RateFetcher;
  private readonly ttlMs: number;
  private readonly maxStalenessMs: number;
  private readonly now: () => number;

  constructor(opts: CachingRateProviderOptions) {
    this.fetcher = opts.fetcher;
    this.ttlMs = opts.ttlMs;
    this.maxStalenessMs = opts.maxStalenessMs;
    this.now = opts.now ?? Date.now;
    this.pinned = Object.fromEntries(
      Object.entries(opts.pinned ?? {}).map(([k, v]) => [k, scaleRate(v)]),
    );
  }

  rate(from: string, to: string): bigint | undefined {
    if (from === to) return MONEY_SCALE;
    const pin = this.pinned[`${from}:${to}`];
    if (pin !== undefined) return pin;
    const entry = this.cache.get(`${from}:${to}`);
    if (!entry) return undefined;
    if (this.now() - entry.fetchedAt > this.maxStalenessMs) return undefined; // too stale → deny
    return entry.rate;
  }

  async refresh(pairs: Array<[string, string]>): Promise<void> {
    const stale = pairs.filter(([from, to]) => {
      if (from === to || this.pinned[`${from}:${to}`] !== undefined) return false;
      const entry = this.cache.get(`${from}:${to}`);
      return !entry || this.now() - entry.fetchedAt > this.ttlMs;
    });
    await Promise.allSettled(
      stale.map(async ([from, to]) => {
        const rate = await this.fetcher(from, to);
        // On fetch failure (undefined) keep any prior entry; it ages toward the
        // staleness limit and then denies, rather than dropping immediately.
        if (rate !== undefined) this.cache.set(`${from}:${to}`, { rate, fetchedAt: this.now() });
      }),
    );
  }
}

/** Convert a decimal rate string to a scaled (6-dp) bigint. */
function scaleRate(s: string): bigint {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid rate ${JSON.stringify(s)}`);
  return BigInt(Math.round(n * Number(MONEY_SCALE)));
}

/**
 * Default fetcher backed by exchangerate.host's free convert endpoint. Suitable
 * for fiat pairs (CNY:USD, ...); supply your own RateFetcher for crypto assets
 * or a paid provider. Network failures (and a hung provider, via the timeout)
 * resolve to undefined — the pair simply isn't refreshed and ages toward the
 * staleness limit rather than stalling the request that triggered the refresh.
 */
export function httpRateFetcher(baseUrl = "https://api.exchangerate.host", timeoutMs = 5000): RateFetcher {
  return async (from, to) => {
    try {
      const res = await fetch(`${baseUrl}/convert?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { result?: number };
      return typeof body.result === "number" && body.result > 0 ? scaleRate(String(body.result)) : undefined;
    } catch {
      return undefined;
    }
  };
}
