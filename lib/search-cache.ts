/**
 * Cross-instance YouTube search-results cache (TICKET-55).
 *
 * WHY: a YouTube Data API search burns ~101 quota units (search.list 100 +
 * videos.list 1) against a 10,000/day default quota — ~99 searches/day TOTAL.
 * The pre-existing query cache in `lib/youtube-search.ts` is a per-lambda
 * in-memory Map, so on Vercel every cold/parallel instance re-burns quota for
 * the same query (the PR #8 opus reviewer's "biggest quota lever"). This module
 * backs that cache with Upstash Redis so a query answered once is answered from
 * Redis by EVERY instance for the TTL window.
 *
 * Driver resolution mirrors `lib/rate-limit-counter.ts` / `lib/store.ts`:
 * Upstash when configured (STORE_DRIVER=upstash or UPSTASH_REDIS_REST_URL
 * present), otherwise the exact pre-existing in-memory LRU in
 * `lib/youtube-search.ts` — local dev / CI / zero-secret boot behavior is
 * byte-identical to before this ticket.
 *
 * Two-tier on the Redis path: the per-instance memory LRU acts as an L1 in
 * front of Redis — a warm lambda serving the same hot query within the memory
 * TTL (60s) skips even the Redis round-trip, and a Redis hit warms the L1.
 * Correctness is unaffected (both tiers hold the same immutable, versioned
 * search payloads; staleness bounds are the tiers' TTLs).
 *
 * TTL DECISIONS (documented per ticket):
 *  - Non-empty result sets: 12 hours (`SEARCH_CACHE_TTL_MS`). Karaoke search
 *    results are highly static day-over-day; 12h means a query popular across
 *    an evening's venues costs ONE ~101-unit burn per day-part instead of one
 *    per instance per minute, while still picking up fresh uploads within a
 *    day. (Ticket guidance: 6–24h; 12h is the midpoint.)
 *  - Empty result sets: 10 minutes (`SEARCH_CACHE_EMPTY_TTL_MS`). Empties are
 *    cached (they are successful API answers and repeated typo/miss queries
 *    would otherwise re-burn 100 units each), but only briefly — an empty is
 *    more likely transient (typo, regional hiccup, brand-new upload) and must
 *    not pin "no results" for 12h.
 *  - API errors are NEVER cached: callers only write to this cache after
 *    `searchYouTube()` resolves successfully.
 *
 * FAIL-OPEN: every Redis call is try/caught. Any Redis error behaves as a
 * cache miss (get) or a no-op (set) — a blipped Redis must never break search;
 * worst case is the pre-ticket behavior (a quota-charged live call).
 */

import "server-only";

import { Redis } from "@upstash/redis";

import {
  getCached as memGet,
  setCached as memSet,
  type SearchResult,
} from "@/lib/youtube-search";

/** Redis TTL for cached NON-EMPTY search results (12h — see header). */
export const SEARCH_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Redis TTL for cached EMPTY search results (10min — see header). */
export const SEARCH_CACHE_EMPTY_TTL_MS = 10 * 60 * 1000;

/**
 * Namespace prefix for every Redis key this module writes (collision-free with
 * the queue/room store keys and the `rl:` rate-limit-counter namespace).
 */
const REDIS_PREFIX = "sc:";

// ─── Driver resolution (mirrors lib/rate-limit-counter.ts / lib/store.ts) ────

function useUpstash(): boolean {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash") return true;
  if (explicit === "memory") return false;
  // Auto: use Upstash when its REST URL is configured, else memory.
  return !!process.env.UPSTASH_REDIS_REST_URL;
}

/**
 * Lazily-built Redis client (same construction as the sibling stores —
 * `Redis.fromEnv()` reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
 * Built on first use so the memory path never touches Upstash and the module
 * imports with zero secrets.
 */
let redisClient: Redis | null = null;
function getRedis(): Redis | null {
  if (!useUpstash()) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = Redis.fromEnv();
    return redisClient;
  } catch {
    // Upstash selected but creds unusable — degrade to memory-only rather
    // than crash the search route.
    return null;
  }
}

function redisKey(key: string): string {
  return `${REDIS_PREFIX}${key}`;
}

/** Minimal shape guard for a Redis-roundtripped SearchResult[] payload. */
function isSearchResultArray(v: unknown): v is SearchResult[] {
  return (
    Array.isArray(v) &&
    v.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as SearchResult).videoId === "string",
    )
  );
}

/**
 * Read cached results for a normalized cache key (build it with
 * `cacheKey()` from lib/youtube-search — trim/lowercase/collapse-whitespace,
 * region-scoped). Returns null on miss, expiry, or ANY Redis error (fail-open).
 *
 * Order: per-instance memory L1 first (free), then Redis (cross-instance).
 * A Redis hit warms the L1 so the same warm lambda skips the next round-trip.
 */
export async function getCachedSearch(
  key: string,
): Promise<SearchResult[] | null> {
  // L1: the pre-existing in-memory LRU (also the sole tier without Upstash).
  const local = memGet(key);
  if (local) return local;

  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get<SearchResult[]>(redisKey(key));
    if (!isSearchResultArray(value)) return null; // absent or corrupt → miss
    memSet(key, value); // warm the L1 for this instance
    return value;
  } catch {
    // Fail-open: a Redis blip is a cache miss, never a broken search.
    return null;
  }
}

/**
 * Cache a SUCCESSFUL search response. Callers must only invoke this after
 * `searchYouTube()` resolved (errors are never cached). Non-empty results get
 * the 12h TTL; empty results the short 10min TTL (see header). Any Redis error
 * is swallowed (fail-open) — the memory L1 is always written regardless.
 */
export async function setCachedSearch(
  key: string,
  results: SearchResult[],
): Promise<void> {
  // Always warm the per-instance L1 (identical to pre-ticket behavior).
  memSet(key, results);

  const redis = getRedis();
  if (!redis) return;
  try {
    const ttlMs =
      results.length > 0 ? SEARCH_CACHE_TTL_MS : SEARCH_CACHE_EMPTY_TTL_MS;
    await redis.set(redisKey(key), results, { px: ttlMs });
  } catch {
    // Fail-open: on any Redis error, silently skip the cross-instance write.
  }
}
