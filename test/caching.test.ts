import { describe, expect, it, vi } from "vitest";
import { CachingRateProvider, type RateFetcher } from "../src/fx/caching.js";
import { MONEY_SCALE } from "../src/money.js";

/** A fetcher returning a fixed scaled rate, counting calls. */
function countingFetcher(scaled: bigint): { fetcher: RateFetcher; calls: () => number } {
  let calls = 0;
  return {
    fetcher: async () => {
      calls += 1;
      return scaled;
    },
    calls: () => calls,
  };
}

describe("CachingRateProvider", () => {
  it("returns identity and pinned rates without fetching", async () => {
    const { fetcher, calls } = countingFetcher(140000n);
    const p = new CachingRateProvider({ fetcher, ttlMs: 1000, maxStalenessMs: 2000, pinned: { "USDC:USD": "1" } });
    expect(p.rate("USD", "USD")).toBe(MONEY_SCALE);
    expect(p.rate("USDC", "USD")).toBe(MONEY_SCALE);
    await p.refresh([["USDC", "USD"], ["USD", "USD"]]);
    expect(calls()).toBe(0); // neither needs the network
  });

  it("serves an uncached pair only after refresh", async () => {
    const { fetcher } = countingFetcher(140000n);
    const p = new CachingRateProvider({ fetcher, ttlMs: 1000, maxStalenessMs: 2000 });
    expect(p.rate("CNY", "USD")).toBeUndefined();
    await p.refresh([["CNY", "USD"]]);
    expect(p.rate("CNY", "USD")).toBe(140000n);
  });

  it("re-fetches only once TTL has elapsed", async () => {
    let t = 0;
    const { fetcher, calls } = countingFetcher(140000n);
    const p = new CachingRateProvider({ fetcher, ttlMs: 1000, maxStalenessMs: 5000, now: () => t });
    await p.refresh([["CNY", "USD"]]);
    expect(calls()).toBe(1);
    t = 500; // within TTL — no re-fetch
    await p.refresh([["CNY", "USD"]]);
    expect(calls()).toBe(1);
    t = 1500; // past TTL — re-fetch
    await p.refresh([["CNY", "USD"]]);
    expect(calls()).toBe(2);
  });

  it("denies a rate past the staleness limit", async () => {
    let t = 0;
    const { fetcher } = countingFetcher(140000n);
    const p = new CachingRateProvider({ fetcher, ttlMs: 1000, maxStalenessMs: 2000, now: () => t });
    await p.refresh([["CNY", "USD"]]);
    t = 1999;
    expect(p.rate("CNY", "USD")).toBe(140000n);
    t = 2001; // beyond maxStaleness → deny rather than price on a stale rate
    expect(p.rate("CNY", "USD")).toBeUndefined();
  });

  it("keeps the last good rate when a refresh fetch fails", async () => {
    let t = 0;
    const fetcher = vi.fn<RateFetcher>().mockResolvedValueOnce(140000n).mockResolvedValue(undefined);
    const p = new CachingRateProvider({ fetcher, ttlMs: 100, maxStalenessMs: 5000, now: () => t });
    await p.refresh([["CNY", "USD"]]); // succeeds
    t = 200; // past TTL, fetch now fails
    await p.refresh([["CNY", "USD"]]);
    expect(p.rate("CNY", "USD")).toBe(140000n); // still served — within staleness window
  });
});
