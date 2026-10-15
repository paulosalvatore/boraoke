/**
 * Free index-only lookups must never weaken the BILLED rate limit.
 *
 * Regression for the PR #89 security gate (HIGH 1): index lookups shared the
 * billed limiter's 2,000-key LRU map, so a host sending a few thousand free
 * lookups under fresh uuids evicted its own billed `ip:` bucket and got a new
 * billed window every time. Measured: 1,800 billed calls/min from ONE real IP
 * (vs 180 on PR #88). Adapted from the gate's probe (d).
 */
import type { NextRequest } from "next/server";

jest.mock("@/lib/search-budget", () => ({
  ...jest.requireActual("@/lib/search-budget"),
  // Measure the per-IP RATE ceiling, not the daily cap.
  reserveSearchCall: async () => ({ ok: true, remaining: 999, day: "d" }),
}));
jest.mock("@/lib/karaoke-index/store", () => ({ getKaraokeIndex: async () => null }));

import { GET } from "@/app/api/search/route";
import { _indexBucketCount, _rateBucketCount, _resetCache, _resetRateLimit, indexRateLimitOk, rateLimitOk, RATE_LIMIT } from "@/lib/youtube-search";
import { _resetLiveGate } from "@/lib/live-search-gate";

let T = 1_800_000_000_000;
let billed = 0;
const uuidN = (n: number) => `123e4567-e89b-42d3-a456-${String(n).padStart(12, "0")}`;
const req = (qs: string, ip: string) =>
  new Request(`http://127.0.0.1:3040/api/search?${qs}`, { headers: { "x-forwarded-for": ip } }) as unknown as NextRequest;

beforeEach(() => {
  _resetCache();
  _resetRateLimit();
  _resetLiveGate();
  billed = 0;
  process.env.YOUTUBE_API_KEY = "test-key";
  jest.spyOn(Date, "now").mockImplementation(() => T);
  global.fetch = jest.fn(async (u: RequestInfo | URL) => {
    const isSearch = String(u).includes("/youtube/v3/search");
    if (isSearch) billed++;
    const body = isSearch ? { items: [{ id: { videoId: `v${billed}` }, snippet: { title: "t" } }] } : { items: [] };
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  delete process.env.YOUTUBE_API_KEY;
});

describe("index-only lookups cannot evict the billed per-IP bucket", () => {
  it("unit: a full billed IP bucket stays full after 5,000 free lookups with fresh uuids from the same IP", () => {
    const ip = "198.51.100.99";
    let before = 0;
    for (let i = 0; i < 40; i++) if (rateLimitOk(uuidN(30000 + i), ip, T)) before++;
    expect(before).toBe(RATE_LIMIT.ipMax);
    for (let i = 0; i < 5000; i++) indexRateLimitOk(uuidN(40000 + i), ip, T + 1);
    let after = 0;
    for (let i = 0; i < 40; i++) if (rateLimitOk(uuidN(50000 + i), ip, T + 2)) after++;
    expect(after).toBe(0);
  });

  it("unit: index lookups never add billed buckets, and a rejected lookup adds no uuid key", () => {
    const ip = "198.51.100.98";
    for (let i = 0; i < 5000; i++) indexRateLimitOk(uuidN(60000 + i), ip, T);
    expect(_rateBucketCount()).toBe(0);
    // 240 accepted (one uuid key each) + the one IP key; the 4,760 rejected added nothing.
    expect(_indexBucketCount()).toBe(RATE_LIMIT.indexIpMax + 1);
  });

  it("route (probe d): ONE real IP, rotating uuids + a free index flood stays at the per-IP billed ceiling", async () => {
    const ip = "198.51.100.200";
    let n = 0;
    const SECONDS = 10; // exactly one RATE window
    for (let tick = 0; tick < SECONDS; tick++) {
      for (let i = 0; i < 40; i++) {
        await GET(req(`q=drain+${tick}+${i}&uuid=${uuidN(100000 + n++)}&v=2&live=1`, ip));
      }
      for (let i = 0; i < 2100; i++) {
        await GET(req(`q=karaoke+free+${tick}+${i}&uuid=${uuidN(900000 + n++)}&v=2`, ip));
      }
      T += 1000;
    }
    // One 10 s window from one IP: at most RATE_IP_MAX billed calls.
    expect(billed).toBeLessThanOrEqual(RATE_LIMIT.ipMax);
  }, 120_000);
});
