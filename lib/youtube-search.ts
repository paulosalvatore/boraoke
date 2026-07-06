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
// ---------------------------------------------------------------------------

interface CacheEntry {
  results: SearchResult[];
  expires: number;
}

const CACHE_MAX = 100;
const CACHE_TTL_MS = 60_000;
const queryCache = new Map<string, CacheEntry>();

export function cacheKey(q: string, regionCode: string): string {
  return `${regionCode}::${q.trim().toLowerCase()}`;
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
// Per-uuid sliding-window rate limiter (quota hygiene; best-effort per instance).
// Allow RATE_MAX requests per RATE_WINDOW_MS; the (RATE_MAX+1)th is rejected.
// ---------------------------------------------------------------------------

const RATE_MAX = 5;
const RATE_WINDOW_MS = 10_000;
const hits = new Map<string, number[]>();

/**
 * Returns true if the request is allowed (and records it), false if the caller
 * has exceeded RATE_MAX within the window.
 */
export function rateLimitOk(uuid: string, now = Date.now()): boolean {
  const windowStart = now - RATE_WINDOW_MS;
  const recent = (hits.get(uuid) ?? []).filter((t) => t > windowStart);
  if (recent.length >= RATE_MAX) {
    hits.set(uuid, recent); // keep the pruned window
    return false;
  }
  recent.push(now);
  hits.set(uuid, recent);
  return true;
}

/** Test helper — clear rate-limit state. */
export function _resetRateLimit(): void {
  hits.clear();
}

export const RATE_LIMIT = { max: RATE_MAX, windowMs: RATE_WINDOW_MS };
