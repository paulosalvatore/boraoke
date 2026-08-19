/**
 * YouTube Data API v3 search — server-side helper.
 *
 * QUOTA MODEL (as of the 2026-06-01 Google change — TICKET-83/TICKET-85):
 *   - `search.list` is capped at 100 CALLS PER DAY in its OWN bucket. It is no
 *     longer "100 units out of 10,000". Caching cannot raise that ceiling; it
 *     can only stop us re-spending against it.
 *   - `videos.list` (and playlistItems/playlists/channels) cost 1 unit each
 *     against a SEPARATE 10,000/day pool that boraoke barely touches.
 * So a search costs "1 of 100 searches", and its duration lookup is effectively
 * free. Every design choice below follows from that.
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

/**
 * One fetched page of search results, plus the token that reaches the NEXT
 * Google page (absent when Google reports no further results) — TICKET-83.
 */
export interface SearchPage {
  results: SearchResult[];
  /** Google's `nextPageToken`, or undefined when this is the last page. */
  nextPageToken?: string;
}

export const SEARCH_DEFAULTS = {
  /**
   * TICKET-83 QUOTA DECISION — 8 → 50 (the API maximum).
   *
   * Under the post-2026-06-01 model this is not a tradeoff, it is simply right.
   * `search.list` is billed PER CALL (1 of the platform's 100 daily searches),
   * completely independent of `maxResults` (1..50). One call returning 50 rows
   * therefore costs exactly what the old 8-row call cost — 1 of 100 — while
   * giving the patron ~6 client-side pages instead of 8 rows and a dead end.
   * Five calls of 10 rows would have cost 5 of 100 for fewer results.
   *
   * The companion `videos.list` (durations) accepts up to 50 ids in ONE request
   * and bills 1 unit against the separate, near-untouched 10,000/day pool — so
   * widening the page does not meaningfully change that side either.
   *
   * Tradeoff (payload): a mapped SearchResult is ~180 bytes of JSON, so 50 rows
   * is ~9 KB uncompressed / ~2-3 KB gzipped — negligible on a phone, and it
   * buys back up to five of the day's 100 searches. Thumbnails are fetched by
   * the browser only for rendered rows, so the unrevealed tail costs no images.
   */
  maxResults: 50,
  regionCode: "BR",
  safeSearch: "moderate" as const,
};

/** Rows revealed per "load more" tap on the client (TICKET-83). */
export const CLIENT_PAGE_SIZE = 8;

/**
 * HARD CAP on how many `search.list` CALLS a single query may ever spend
 * (TICKET-83, revised for the post-2026-06-01 model).
 *
 * Page depth is a scarce daily budget, not a UX nicety: the whole platform gets
 * 100 searches per day across every venue, and caching cannot raise that
 * ceiling. So:
 *   - Page 1 (50 rows, ~6 client-side pages) costs 1 of 100 and covers the
 *     overwhelming majority of "I didn't find it" cases.
 *   - ONE deep page is allowed — up to 100 rows total — because "people might
 *     not find what they want on the first search" is a real, observed failure,
 *     and it only fires on a deliberate tap after the patron has already looked
 *     at 50 candidates.
 *   - Page 3+ is refused. A patron who has rejected 100 karaoke videos is not
 *     going to be rescued by another 50, and each further page is 1% of the
 *     platform's entire day.
 * NOTHING is ever prefetched: a page is fetched only after the patron asks for
 * it, so we never spend a daily search on results nobody scrolls to.
 */
export const MAX_SEARCH_PAGES = 2;

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
  nextPageToken?: string;
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
 * Run a live search against the Data API and return ONE page plus the token
 * that reaches the next one (TICKET-83). `key` is supplied by the route (read
 * from env there). Throws YouTubeQuotaError on quota, YouTubeSearchError otherwise.
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 *
 * QUOTA: one call here spends 1 of the platform's 100 DAILY SEARCHES (plus 1
 * unit of the separate, ample metadata pool for durations), whether it is the
 * first page or a deep page. Callers MUST consult the cache first
 * (lib/search-cache.ts), whose key includes the pageToken, and MUST respect
 * MAX_SEARCH_PAGES.
 */
export async function searchYouTubePage(
  q: string,
  key: string,
  opts: {
    maxResults?: number;
    regionCode?: string;
    pageToken?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<SearchPage> {
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
  // TICKET-83: opaque Google page cursor; omitted for the first page so the
  // outgoing URL (and therefore existing behavior) is unchanged there.
  if (opts.pageToken) searchUrl.searchParams.set("pageToken", opts.pageToken);
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

  return {
    results: mapSearchResponse(searchJson, videosJson),
    nextPageToken: searchJson.nextPageToken || undefined,
  };
}

/**
 * Back-compat wrapper: the pre-TICKET-83 signature, returning just the first
 * page's rows. Kept so callers that do not paginate stay unchanged.
 */
export async function searchYouTube(
  q: string,
  key: string,
  opts: { maxResults?: number; regionCode?: string; fetchImpl?: typeof fetch } = {},
): Promise<SearchResult[]> {
  return (await searchYouTubePage(q, key, opts)).results;
}

// ---------------------------------------------------------------------------
// In-memory LRU query cache (read cache, not state; per-instance/best-effort).
// Since TICKET-55 this is the L1 / no-Upstash fallback behind the
// cross-instance Redis cache in lib/search-cache.ts — routes go through that
// module; these primitives stay exported for it and for tests.
// ---------------------------------------------------------------------------

interface CacheEntry {
  page: SearchPage;
  expires: number;
}

const CACHE_MAX = 100;
const CACHE_TTL_MS = 60_000;
const queryCache = new Map<string, CacheEntry>();

/**
 * Normalized, region-scoped cache key: trim + lowercase + collapse internal
 * whitespace runs to a single space (TICKET-55 — "foo  bar" and "foo bar" are
 * the same search, so they must share one cross-instance cache entry).
 *
 * TICKET-83: a `pageToken` is folded in so each Google page of the SAME query
 * gets its own entry — paging forward then back is served from cache and burns
 * ZERO quota. The first page (no token) produces the byte-identical key it did
 * before this ticket, so pre-existing cache entries are not orphaned.
 */
export function cacheKey(q: string, regionCode: string, pageToken = ""): string {
  const normalized = q.trim().toLowerCase().replace(/\s+/g, " ");
  const page = pageToken ? `p:${pageToken}::` : "";
  return `${regionCode}::${page}${normalized}`;
}

/** Read a cached PAGE (results + nextPageToken) from the per-instance LRU. */
export function getCachedPage(key: string, now = Date.now()): SearchPage | null {
  const hit = queryCache.get(key);
  if (!hit) return null;
  if (hit.expires <= now) {
    queryCache.delete(key);
    return null;
  }
  // LRU touch — re-insert to move to the end.
  queryCache.delete(key);
  queryCache.set(key, hit);
  return hit.page;
}

/** Write a PAGE into the per-instance LRU. */
export function setCachedPage(key: string, page: SearchPage, now = Date.now()): void {
  queryCache.set(key, { page, expires: now + CACHE_TTL_MS });
  evictCacheOverflow();
}

/** Back-compat: results-only read (drops any nextPageToken). */
export function getCached(key: string, now = Date.now()): SearchResult[] | null {
  return getCachedPage(key, now)?.results ?? null;
}

/** Back-compat: results-only write. */
export function setCached(key: string, results: SearchResult[], now = Date.now()): void {
  setCachedPage(key, { results }, now);
}

function evictCacheOverflow(): void {
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
