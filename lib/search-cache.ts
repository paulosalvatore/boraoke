/**
 * Cross-instance YouTube search-results cache (TICKET-55).
 *
 * WHY: a YouTube Data API search is the platform's scarcest resource.
 *
 * QUOTA MODEL CORRECTION (TICKET-83, verified by the TICKET-85 spike): since
 * 2026-06-01 `search.list` is capped at 100 CALLS PER DAY in its OWN bucket —
 * it is NOT "100 units out of a shared 10,000" as this file previously said.
 * `videos.list` and the other metadata endpoints cost 1 unit each against a
 * SEPARATE 10,000/day pool boraoke barely touches. So one search = 1 of 100 per
 * day across EVERY venue combined, and caching cannot raise that ceiling — it
 * can only stop us re-spending it on a question already answered.
 *
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
 *    an evening's venues costs ONE of the day's 100 searches per day-part instead of one
 *    per instance per minute, while still picking up fresh uploads within a
 *    day. (Ticket guidance: 6–24h; 12h is the midpoint.)
 *  - Empty result sets: 10 minutes (`SEARCH_CACHE_EMPTY_TTL_MS`). Empties are
 *    cached (they are successful API answers and repeated typo/miss queries
 *    would otherwise each re-spend one of the 100 daily searches), but only
 *    briefly — an empty is
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
  getCachedPage as memGetPage,
  setCachedPage as memSetPage,
  type SearchPage,
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
 * Coerce a Redis-roundtripped value into a SearchPage, or null when it is
 * absent/corrupt.
 *
 * TICKET-83 changed the stored shape from `SearchResult[]` to
 * `{ results, nextPageToken? }` so a page's forward cursor is cached alongside
 * its rows. A BARE ARRAY is still accepted — entries written by the previous
 * deploy stay valid for their 12h TTL instead of being treated as corrupt and
 * re-spending one of the day's 100 searches each.
 */
function toSearchPage(v: unknown): SearchPage | null {
  if (isSearchResultArray(v)) return { results: v }; // legacy pre-83 entry
  if (v && typeof v === "object" && isSearchResultArray((v as SearchPage).results)) {
    const token = (v as SearchPage).nextPageToken;
    return {
      results: (v as SearchPage).results,
      nextPageToken: typeof token === "string" && token ? token : undefined,
    };
  }
  return null;
}

/**
 * Read a cached PAGE for a normalized cache key (build it with `cacheKey()`
 * from lib/youtube-search — trim/lowercase/collapse-whitespace, region-scoped,
 * and since TICKET-83 pageToken-scoped). Returns null on miss, expiry, or ANY
 * Redis error (fail-open).
 *
 * Order: per-instance memory L1 first (free), then Redis (cross-instance).
 * A Redis hit warms the L1 so the same warm lambda skips the next round-trip.
 */
export async function getCachedSearchPage(
  key: string,
): Promise<SearchPage | null> {
  // L1: the pre-existing in-memory LRU (also the sole tier without Upstash).
  const local = memGetPage(key);
  if (local) return local;

  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get<unknown>(redisKey(key));
    const page = toSearchPage(value);
    if (!page) return null; // absent or corrupt → miss
    memSetPage(key, page); // warm the L1 for this instance
    return page;
  } catch {
    // Fail-open: a Redis blip is a cache miss, never a broken search.
    return null;
  }
}

/**
 * Cache a SUCCESSFUL search page. Callers must only invoke this after
 * `searchYouTubePage()` resolved (errors are never cached). Non-empty results
 * get the 12h TTL; empty results the short 10min TTL (see header). Any Redis
 * error is swallowed (fail-open) — the memory L1 is always written regardless.
 *
 * TICKET-83: deep pages are cached under their own pageToken-scoped key with
 * the same TTLs, so paging back and forth over an evening costs zero quota.
 */
export async function setCachedSearchPage(
  key: string,
  page: SearchPage,
): Promise<void> {
  // Always warm the per-instance L1 (identical to pre-ticket behavior).
  memSetPage(key, page);

  const redis = getRedis();
  if (!redis) return;
  try {
    const ttlMs =
      page.results.length > 0 ? SEARCH_CACHE_TTL_MS : SEARCH_CACHE_EMPTY_TTL_MS;
    await redis.set(redisKey(key), page, { px: ttlMs });
  } catch {
    // Fail-open: on any Redis error, silently skip the cross-instance write.
  }
}

/** Back-compat results-only read (drops any nextPageToken). */
export async function getCachedSearch(
  key: string,
): Promise<SearchResult[] | null> {
  return (await getCachedSearchPage(key))?.results ?? null;
}

/** Back-compat results-only write. */
export async function setCachedSearch(
  key: string,
  results: SearchResult[],
): Promise<void> {
  await setCachedSearchPage(key, { results });
}
