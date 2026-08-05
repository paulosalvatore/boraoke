/**
 * YouTube Data API v3 search — server-side helper.
 *
 * The API key is NEVER imported here; callers (the /api/search route) pass it in
 * after reading process.env server-side, so this module stays pure and testable
 * and no key ever reaches the client bundle.
 *
 * Two Google calls are needed for a full result row:
 *   1. search.list  → candidate videoIds + snippet (title, channel, thumbnails)
 *   2. videos.list  → contentDetails.duration (ISO-8601) for those ids
 * `mapSearchResponse()` fuses the two JSON payloads into SearchResult[] and is
 * unit-tested against fixtures (never against the live API).
 */

export interface SearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
  /** Human "m:ss" / "h:mm:ss" duration, or "" when unavailable. */
  duration: string;
  /** Best-fit thumbnail URL (default 120×90 tier is plenty for a 64×48 slot). */
  thumbnailUrl: string;
}

/** Thrown when Google reports the daily quota is exhausted (403 quotaExceeded). */
export class YouTubeQuotaError extends Error {
  constructor(message = "YouTube search quota exceeded") {
    super(message);
    this.name = "YouTubeQuotaError";
  }
}

/** Thrown for any other non-OK response from the Data API. */
export class YouTubeSearchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "YouTubeSearchError";
    this.status = status;
  }
}

const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

export const SEARCH_DEFAULTS = {
  maxResults: 8,
  regionCode: "BR",
  safeSearch: "moderate" as const,
};

/**
 * Convert an ISO-8601 duration (e.g. "PT4M13S", "PT1H2M", "PT45S") to a
 * display string ("4:13", "1:02:00", "0:45"). Returns "" for unparseable input.
 */
export function formatISODuration(iso: string | undefined | null): string {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return "";
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  const seconds = Number(m[3] ?? 0);
  if (hours === 0 && minutes === 0 && seconds === 0 && !/\d/.test(iso)) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

/** Pick the smallest adequate thumbnail; falls back through the tiers. */
function pickThumbnail(thumbnails: Record<string, { url?: string }> | undefined): string {
  if (!thumbnails) return "";
  return (
    thumbnails.medium?.url ??
    thumbnails.default?.url ??
    thumbnails.high?.url ??
    ""
  );
}

// Minimal shapes of the Google payloads we consume (not exhaustive).
interface SearchListJson {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      channelTitle?: string;
      thumbnails?: Record<string, { url?: string }>;
    };
  }>;
}
interface VideosListJson {
  items?: Array<{
    id?: string;
    contentDetails?: { duration?: string };
  }>;
}

/**
 * Fuse a search.list payload with a videos.list payload into SearchResult[].
 * Ordering follows the search.list order; items without a videoId are dropped.
 * Durations are looked up by videoId (missing → "").
 */
export function mapSearchResponse(
  searchJson: SearchListJson,
  videosJson: VideosListJson,
): SearchResult[] {
  const durations = new Map<string, string>();
  for (const v of videosJson.items ?? []) {
    if (v.id) durations.set(v.id, formatISODuration(v.contentDetails?.duration));
  }

  const out: SearchResult[] = [];
  for (const item of searchJson.items ?? []) {
    const videoId = item.id?.videoId;
    if (!videoId) continue;
    out.push({
      videoId,
      title: decodeHtmlEntities(item.snippet?.title ?? ""),
      channelTitle: decodeHtmlEntities(item.snippet?.channelTitle ?? ""),
      duration: durations.get(videoId) ?? "",
      thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
    });
  }
  return out;
}

/** Google returns HTML-escaped snippet text; undo the common entities for display. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** True when Google's error body signals a quota-exceeded condition. */
function isQuotaError(status: number, body: unknown): boolean {
  if (status !== 403) return false;
  const errs = (body as { error?: { errors?: Array<{ reason?: string }> } })?.error
    ?.errors;
  return Array.isArray(errs) && errs.some((e) => e.reason === "quotaExceeded" || e.reason === "dailyLimitExceeded");
}

/**
 * Run a live search against the Data API. `key` is supplied by the route (read
 * from env there). Throws YouTubeQuotaError on quota, YouTubeSearchError otherwise.
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */
export async function searchYouTube(
  q: string,
  key: string,
  opts: { maxResults?: number; regionCode?: string; fetchImpl?: typeof fetch } = {},
): Promise<SearchResult[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxResults = opts.maxResults ?? SEARCH_DEFAULTS.maxResults;
  const regionCode = opts.regionCode ?? SEARCH_DEFAULTS.regionCode;

  const searchUrl = new URL(SEARCH_ENDPOINT);
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("videoEmbeddable", "true");
  // TICKET-41: only videos playable OUTSIDE youtube.com — a syndication-blocked
  // video passes videoEmbeddable yet still refuses to play on the venue TV.
  // Both filters require type=video (set above). Paste-link entries bypass
  // search and can't be pre-filtered — the TV watchdog's onError path covers
  // them at play time.
  searchUrl.searchParams.set("videoSyndicated", "true");
  searchUrl.searchParams.set("safeSearch", SEARCH_DEFAULTS.safeSearch);
  searchUrl.searchParams.set("regionCode", regionCode);
  searchUrl.searchParams.set("maxResults", String(maxResults));
  searchUrl.searchParams.set("q", q);
  searchUrl.searchParams.set("key", key);

  const searchRes = await fetchImpl(searchUrl.toString());
  if (!searchRes.ok) {
    const body = await searchRes.json().catch(() => ({}));
    if (isQuotaError(searchRes.status, body)) throw new YouTubeQuotaError();
    throw new YouTubeSearchError(searchRes.status, "search.list failed");
  }
  const searchJson: SearchListJson = await searchRes.json();

  const ids = (searchJson.items ?? [])
    .map((i) => i.id?.videoId)
    .filter((v): v is string => Boolean(v));

  let videosJson: VideosListJson = {};
  if (ids.length > 0) {
    const videosUrl = new URL(VIDEOS_ENDPOINT);
    videosUrl.searchParams.set("part", "contentDetails");
    videosUrl.searchParams.set("id", ids.join(","));
    videosUrl.searchParams.set("key", key);
    const videosRes = await fetchImpl(videosUrl.toString());
    if (videosRes.ok) {
      videosJson = await videosRes.json();
    } else {
      const body = await videosRes.json().catch(() => ({}));
      if (isQuotaError(videosRes.status, body)) throw new YouTubeQuotaError();
      // Non-quota videos.list failure is non-fatal — return results without durations.
    }
  }

  return mapSearchResponse(searchJson, videosJson);
}

// ---------------------------------------------------------------------------
// In-memory LRU query cache (read cache, not state; per-instance/best-effort).
// Since TICKET-55 this is the L1 / no-Upstash fallback behind the
// cross-instance Redis cache in lib/search-cache.ts — routes go through that
// module; these primitives stay exported for it and for tests.
// ---------------------------------------------------------------------------

interface CacheEntry {
  results: SearchResult[];
  expires: number;
}

const CACHE_MAX = 100;
const CACHE_TTL_MS = 60_000;
const queryCache = new Map<string, CacheEntry>();

/**
 * Normalized, region-scoped cache key: trim + lowercase + collapse internal
 * whitespace runs to a single space (TICKET-55 — "foo  bar" and "foo bar" are
 * the same search, so they must share one cross-instance cache entry).
 */
export function cacheKey(q: string, regionCode: string): string {
  return `${regionCode}::${q.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function getCached(key: string, now = Date.now()): SearchResult[] | null {
  const hit = queryCache.get(key);
  if (!hit) return null;
  if (hit.expires <= now) {
    queryCache.delete(key);
    return null;
  }
  // LRU touch — re-insert to move to the end.
  queryCache.delete(key);
  queryCache.set(key, hit);
  return hit.results;
}

export function setCached(key: string, results: SearchResult[], now = Date.now()): void {
  queryCache.set(key, { results, expires: now + CACHE_TTL_MS });
  while (queryCache.size > CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest === undefined) break;
    queryCache.delete(oldest);
  }
}

/** Test helper — clear the query cache. */
export function _resetCache(): void {
  queryCache.clear();
}

// ---------------------------------------------------------------------------
// Dual-bucket sliding-window rate limiter (quota hygiene; best-effort per instance).
//
// Security (PR #8 gate, MEDIUM #1): the uuid alone is client-controlled — an
// abuser bypasses a uuid-only limit by rotating uuids. We therefore limit on
// BOTH the uuid AND the caller IP; whichever bucket trips first rejects.
// The IP bucket is deliberately generous (RATE_IP_MAX) because a whole bar
// shares one venue IP/NAT — tradeoff: a single hot venue can legitimately
// burn up to RATE_IP_MAX searches per window (acceptable quota exposure),
// while unbounded uuid rotation from one host is capped at the same ceiling.
//
// MEDIUM #2: the bucket map is CAPPED (same LRU pattern as queryCache) —
// uuid keys are attacker-minted, so an unbounded Map grows the heap under
// rotation. Oldest-touched buckets evict first past RATE_BUCKETS_MAX; worst
// case an evicted rotator gets a fresh uuid window, but the IP bucket (one
// key per host, constantly re-touched so effectively never the LRU victim)
// still holds the line.
// ---------------------------------------------------------------------------

const RATE_MAX = 5; // per-uuid requests per window
const RATE_IP_MAX = 30; // per-IP requests per window (shared venue-IP headroom)
const RATE_WINDOW_MS = 10_000;
const RATE_BUCKETS_MAX = 2000; // cap on total tracked buckets (uuid + ip keys)
const hits = new Map<string, number[]>();

/** Check-and-record one bucket. Returns false when the bucket is at/over `max`. */
function bucketOk(key: string, max: number, now: number): boolean {
  const windowStart = now - RATE_WINDOW_MS;
  const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
  // LRU touch: delete + re-set moves the key to the Map's insertion-order tail.
  hits.delete(key);
  if (recent.length >= max) {
    hits.set(key, recent); // keep the pruned window
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

/** Evict oldest-touched buckets past the cap (heap-growth guard, MEDIUM #2). */
function evictOverflow(): void {
  while (hits.size > RATE_BUCKETS_MAX) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
}

/**
 * Returns true if the request is allowed (and records it in both buckets),
 * false when EITHER the uuid bucket or the IP bucket exceeds its window.
 * `ip` may be "" when unavailable (then only the uuid bucket applies).
 */
export function rateLimitOk(uuid: string, ip = "", now = Date.now()): boolean {
  const uuidOk = bucketOk(`u:${uuid}`, RATE_MAX, now);
  // Evaluate (and charge) the IP bucket even when the uuid bucket already
  // tripped, so rotating uuids can't dodge the IP window's accounting.
  const ipOk = ip ? bucketOk(`ip:${ip}`, RATE_IP_MAX, now) : true;
  evictOverflow();
  return uuidOk && ipOk;
}

/** Test helper — clear rate-limit state. */
export function _resetRateLimit(): void {
  hits.clear();
}

/** Test helper — current number of tracked buckets. */
export function _rateBucketCount(): number {
  return hits.size;
}

export const RATE_LIMIT = {
  max: RATE_MAX,
  ipMax: RATE_IP_MAX,
  windowMs: RATE_WINDOW_MS,
  bucketsMax: RATE_BUCKETS_MAX,
};
