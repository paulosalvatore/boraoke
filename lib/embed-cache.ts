/**
 * Cross-instance cache for the TICKET-61 embeddability pre-check (TICKET-95,
 * MEDIUM-1 of the TICKET-67 cyber follow-ups).
 *
 * WHY: `checkEmbeddable` (`lib/youtube.ts`) calls `videos.list` on every
 * paste-path submit with no memoization at all — every repeat paste of the
 * same `videoId` (a bar re-queues the same handful of songs all night) re-spent
 * an outbound call and up to ~1.5s of held serverless concurrency for a fact
 * that had already been answered.
 *
 * QUOTA-MODEL NOTE (see `lib/search-cache.ts` for the full correction): since
 * 2026-06-01 `search.list` is capped at 100 CALLS/DAY in its own bucket;
 * `videos.list` — what `checkEmbeddable` calls — costs 1 unit against a
 * SEPARATE ~10,000-unit/day pool boraoke barely touches. So this module is a
 * latency/hold-time and general-hygiene win, not a `search.list`-quota fix —
 * the original TICKET-67 framing predates that split and named the wrong
 * bucket. It is still worth doing: `videos.list` shares its pool with every
 * other metadata call, and the far bigger win is removing ~1.5s of held
 * concurrency from the hottest mutation route on a cache hit (see MEDIUM-3's
 * timeout change in `lib/youtube.ts`).
 *
 * SHAPE: deliberately mirrors `lib/search-cache.ts` (TICKET-55) — the house
 * pattern for a cross-instance Upstash-backed cache with an in-process L1 in
 * front and fail-open on any Redis trouble. This module keeps its OWN L1 and
 * OWN driver-resolution copy (same convention `lib/search-budget.ts` and
 * `lib/search-cache.ts` already follow independently) because the cached
 * shape here (a single `EmbeddableStatus` string per `videoId`) is unrelated
 * to the `SearchPage` L1 in `lib/youtube-search.ts`.
 *
 * TTL DECISIONS:
 *  - `embeddable` / `not-embeddable` (definitive): 24 hours
 *    (`EMBED_CACHE_TTL_MS`). A video's embeddable flag is a channel-owner
 *    setting that essentially never flips within a day; 24h means the same
 *    handful of songs a venue re-queues all night costs ONE outbound call
 *    total, while still picking up an owner's rare mid-day change well within
 *    a day.
 *  - `unknown` (no answer — no key, bad id, HTTP error, quota exhaustion,
 *    timeout, malformed JSON): 10 minutes (`EMBED_CACHE_UNKNOWN_TTL_MS`).
 *    `unknown` is the fail-open verdict for BOTH a permanent state (e.g. a
 *    deleted video) and a purely transient one (a network blip, a momentary
 *    upstream 5xx) — the cache cannot tell those apart, so it must not pin
 *    "unknown" for anywhere near as long as a definitive answer. Matches the
 *    short TTL `lib/search-cache.ts` gives an empty result set for the same
 *    reason.
 *
 * FAIL-OPEN (mandatory — this check is advisory and MUST NOT be able to block
 * a submit): every Redis call is try/caught. Any Redis error behaves as a
 * cache miss (get) or a no-op (set) — worst case on a Redis blip is exactly
 * pre-ticket behavior (a live `checkEmbeddable` call).
 */

import "server-only";

import { Redis } from "@upstash/redis";

import { isValidVideoId, type EmbeddableStatus } from "@/lib/youtube";

/** Redis + L1 TTL for a DEFINITIVE result (`embeddable` / `not-embeddable`). */
export const EMBED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Redis + L1 TTL for an `unknown` result — short so a transient failure is never pinned. */
export const EMBED_CACHE_UNKNOWN_TTL_MS = 10 * 60 * 1000;

/** Namespace prefix — collision-free with `sc:` (search cache) and `sb:` (search budget). */
const REDIS_PREFIX = "ec:";

function redisKey(videoId: string): string {
  return `${REDIS_PREFIX}${videoId}`;
}

const VALID_STATUSES: readonly EmbeddableStatus[] = [
  "embeddable",
  "not-embeddable",
  "unknown",
];

function isEmbeddableStatus(v: unknown): v is EmbeddableStatus {
  return typeof v === "string" && (VALID_STATUSES as readonly string[]).includes(v);
}

function ttlFor(status: EmbeddableStatus): number {
  return status === "unknown" ? EMBED_CACHE_UNKNOWN_TTL_MS : EMBED_CACHE_TTL_MS;
}

// ─── Driver resolution (mirrors lib/search-cache.ts / lib/search-budget.ts) ──

function useUpstash(): boolean {
  const explicit = process.env.STORE_DRIVER?.toLowerCase();
  if (explicit === "upstash") return true;
  if (explicit === "memory") return false;
  return !!process.env.UPSTASH_REDIS_REST_URL;
}

let redisClient: Redis | null = null;
function getRedis(): Redis | null {
  if (!useUpstash()) return null;
  if (redisClient) return redisClient;
  try {
    redisClient = Redis.fromEnv();
    return redisClient;
  } catch {
    // Upstash selected but creds unusable — degrade to memory-only rather
    // than crash the submit route.
    return null;
  }
}

// ─── In-process L1 (mirrors the LRU shape in lib/youtube-search.ts) ──────────

interface L1Entry {
  status: EmbeddableStatus;
  expires: number;
}

/** Bounded so a burst of distinct videoIds cannot grow this unboundedly. */
const L1_MAX = 500;
const l1 = new Map<string, L1Entry>();

function l1Get(videoId: string, now: number): EmbeddableStatus | null {
  const hit = l1.get(videoId);
  if (!hit) return null;
  if (hit.expires <= now) {
    l1.delete(videoId);
    return null;
  }
  // LRU touch — re-insert to move to the end.
  l1.delete(videoId);
  l1.set(videoId, hit);
  return hit.status;
}

function l1Set(videoId: string, status: EmbeddableStatus, now: number): void {
  l1.set(videoId, { status, expires: now + ttlFor(status) });
  while (l1.size > L1_MAX) {
    const oldest = l1.keys().next().value;
    if (oldest === undefined) break;
    l1.delete(oldest);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Read a cached embeddability verdict for `videoId`. Returns `null` on miss,
 * expiry, an invalid id, or ANY Redis error (fail-open — a cache problem must
 * never block a submit; the caller falls back to a live `checkEmbeddable`
 * call exactly as if nothing were cached).
 *
 * Order: per-instance L1 first (free), then Redis (cross-instance). A Redis
 * hit warms the L1 so the same warm lambda skips the next round-trip.
 */
export async function getCachedEmbeddable(
  videoId: string,
): Promise<EmbeddableStatus | null> {
  if (!isValidVideoId(videoId)) return null;

  const now = Date.now();
  const local = l1Get(videoId, now);
  if (local) return local;

  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get<unknown>(redisKey(videoId));
    if (!isEmbeddableStatus(value)) return null; // absent or corrupt → miss
    l1Set(videoId, value, now); // warm the L1 for this instance
    return value;
  } catch {
    // Fail-open: a Redis blip is a cache miss, never a broken submit.
    return null;
  }
}

/**
 * Cache a REAL `checkEmbeddable` verdict for `videoId`. Callers must only
 * invoke this after a live check resolved (there is no separate "error"
 * verdict to guard against — `checkEmbeddable` already collapses every
 * failure mode to `"unknown"`, which this function caches with the SHORT TTL
 * so a transient failure is never pinned as long as a definitive answer).
 *
 * Always warms the per-instance L1, even when Redis is unavailable/errors
 * (fail-open — matches `lib/search-cache.ts`).
 */
export async function setCachedEmbeddable(
  videoId: string,
  status: EmbeddableStatus,
): Promise<void> {
  if (!isValidVideoId(videoId)) return;

  const now = Date.now();
  l1Set(videoId, status, now);

  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(redisKey(videoId), status, { px: ttlFor(status) });
  } catch {
    // Fail-open: on any Redis error, silently skip the cross-instance write.
  }
}

/** Test-only: clear the in-process L1. */
export function _resetEmbedCache(): void {
  l1.clear();
}

/** Test-only: drop the memoized Redis client so driver resolution re-runs. */
export function _resetEmbedCacheClient(): void {
  redisClient = null;
}
