/**
 * Server-side video title lookup + cache (TICKET-140 gap 3/4/6).
 *
 * WHY: a pasted song used to show as "YouTube link" in the picker and as
 * `youtu.be/<id>` in the queue, the moderation view and on the TV, and the
 * title of every queued song was whatever the client sent. The title is now
 * resolved HERE, server-side. A client-sent title is never stored; when every
 * lookup failed the entry has no title and shows `youtu.be/<id>`.
 *
 * SOURCES, cheapest first:
 *  1. this cache (`vm:<videoId>` in Upstash + an in-process L1);
 *  2. the `videos.list` call the submit route already makes for the
 *     embeddability check, which now asks for `snippet,contentDetails` too and
 *     so returns title, channel and duration for the same 1 unit;
 *  3. YouTube oEmbed (no key, no Data API quota) when 2 was not made or gave
 *     no title.
 *
 * TTL (same rules as lib/embed-cache.ts): a found title 24 h; a definite
 * "missing" 10 min; a transient error is not cached at all.
 *
 * FAIL-OPEN: every Redis call is try/caught. A cache problem is a miss (get)
 * or a no-op (set); the worst case is a live lookup, never a broken submit.
 */

import "server-only";

import { Redis } from "@upstash/redis";

import { isValidVideoId, type EmbeddableStatus, type VideoMeta } from "@/lib/youtube";
import {
  cleanMetaText,
  fetchOEmbed,
  fetchVideoDetails,
  META_CHANNEL_MAX,
  META_TITLE_MAX,
  videoApiKey,
} from "@/lib/youtube-server";
import { getCachedEmbeddable, setCachedEmbeddable } from "@/lib/embed-cache";

export const META_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const META_CACHE_MISSING_TTL_MS = 10 * 60 * 1000;

const REDIS_PREFIX = "vm:";

/** What the cache holds: metadata, or a short-lived "no title to be had". */
type CachedMeta = VideoMeta | "missing";

interface StoredMeta {
  t?: string;
  c?: string;
  d?: string;
  missing?: true;
}

function toStored(v: CachedMeta): StoredMeta {
  if (v === "missing") return { missing: true };
  return {
    t: v.title,
    ...(v.channelTitle ? { c: v.channelTitle } : {}),
    ...(v.duration ? { d: v.duration } : {}),
  };
}

/** Parse and re-clean a stored value; anything malformed is a miss. */
function fromStored(raw: unknown): CachedMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as StoredMeta;
  if (s.missing === true) return "missing";
  const title = cleanMetaText(s.t, META_TITLE_MAX);
  if (!title) return null;
  const channelTitle = cleanMetaText(s.c, META_CHANNEL_MAX);
  const duration = typeof s.d === "string" && /^\d{1,3}(:\d{2}){1,2}$/.test(s.d) ? s.d : undefined;
  return { title, ...(channelTitle ? { channelTitle } : {}), ...(duration ? { duration } : {}) };
}

function ttlFor(v: CachedMeta): number {
  return v === "missing" ? META_CACHE_MISSING_TTL_MS : META_CACHE_TTL_MS;
}

// ─── Driver resolution (mirrors lib/embed-cache.ts) ──────────────────────────

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
    return null;
  }
}

// ─── In-process L1 ───────────────────────────────────────────────────────────

const L1_MAX = 500;
const l1 = new Map<string, { value: CachedMeta; expires: number }>();

function l1Get(videoId: string, now: number): CachedMeta | null {
  const hit = l1.get(videoId);
  if (!hit) return null;
  if (hit.expires <= now) {
    l1.delete(videoId);
    return null;
  }
  l1.delete(videoId);
  l1.set(videoId, hit);
  return hit.value;
}

function l1Set(videoId: string, value: CachedMeta, now: number): void {
  l1.set(videoId, { value, expires: now + ttlFor(value) });
  while (l1.size > L1_MAX) {
    const oldest = l1.keys().next().value;
    if (oldest === undefined) break;
    l1.delete(oldest);
  }
}

export async function getCachedMeta(videoId: string): Promise<CachedMeta | null> {
  if (!isValidVideoId(videoId)) return null;
  const now = Date.now();
  const local = l1Get(videoId, now);
  if (local) return local;
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = fromStored(await redis.get<unknown>(`${REDIS_PREFIX}${videoId}`));
    if (value) l1Set(videoId, value, now);
    return value;
  } catch {
    return null;
  }
}

export async function setCachedMeta(videoId: string, value: CachedMeta): Promise<void> {
  if (!isValidVideoId(videoId)) return;
  l1Set(videoId, value, Date.now());
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(`${REDIS_PREFIX}${videoId}`, toStored(value), { px: ttlFor(value) });
  } catch {
    /* fail-open */
  }
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/**
 * Title + channel for the patron's paste preview. Cache, then oEmbed only:
 * this path never spends Data API quota, so the public preview endpoint cannot
 * be used to drain the `videos.list` pool.
 */
export async function resolveVideoTitle(videoId: string): Promise<VideoMeta | null> {
  if (!isValidVideoId(videoId)) return null;
  const cached = await getCachedMeta(videoId);
  if (cached) return cached === "missing" ? null : cached;
  const o = await fetchOEmbed(videoId);
  if (o.kind === "found") {
    await setCachedMeta(videoId, o.meta);
    return o.meta;
  }
  if (o.kind === "missing") await setCachedMeta(videoId, "missing");
  return null;
}

export interface SubmitLookup {
  status: EmbeddableStatus;
  meta: VideoMeta | null;
}

/**
 * Everything the submit route needs about a video: the embeddability verdict
 * and the server-side title. At most ONE `videos.list` call (1 unit, only on an
 * `ec:` cache miss with a key) and at most ONE oEmbed call (only when neither
 * the cache nor that call produced a title). Never throws.
 */
export async function lookupForSubmit(videoId: string): Promise<SubmitLookup> {
  try {
    const key = videoApiKey();
    const [cachedStatus, cachedMeta] = await Promise.all([
      key ? getCachedEmbeddable(videoId) : Promise.resolve(null),
      getCachedMeta(videoId),
    ]);

    let status: EmbeddableStatus = cachedStatus ?? "unknown";
    let meta: VideoMeta | null = cachedMeta && cachedMeta !== "missing" ? cachedMeta : null;

    if (cachedStatus === null && key) {
      const details = await fetchVideoDetails(videoId, key);
      status = details.status;
      await setCachedEmbeddable(videoId, status);
      if (details.meta) {
        meta = details.meta;
        await setCachedMeta(videoId, details.meta);
      }
    }

    if (!meta && cachedMeta !== "missing") {
      meta = await resolveVideoTitle(videoId);
    }
    return { status, meta };
  } catch {
    return { status: "unknown", meta: null };
  }
}

/** Test-only: clear the in-process L1. */
export function _resetMetaCache(): void {
  l1.clear();
}

/** Test-only: drop the memoized Redis client so the next call re-resolves the driver. */
export function _resetMetaCacheClient(): void {
  redisClient = null;
}
