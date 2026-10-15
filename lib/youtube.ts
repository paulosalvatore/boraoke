/**
 * YouTube URL parser — extracts the video ID from common YouTube URL formats.
 * No API key required; purely string parsing. The SAME function runs in the
 * patron's search box (components/SongSearch.tsx) and on the server
 * (`POST /api/queue` with a `youtubeUrl` body), so the two can never disagree.
 *
 * Supported forms (TICKET-140 adds the starred ones):
 *   https://www.youtube.com/watch?v=VIDEO_ID   (any param order, &t= &list= &si=)
 *   https://m.youtube.com/watch?v=VIDEO_ID
 * * https://music.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID                  (?si= &t= …)
 * * https://youtu.be/VIDEO_ID/                 (trailing slash)
 *   https://www.youtube.com/{embed,shorts,live,v}/VIDEO_ID
 * * https://www.youtube-nocookie.com/embed/VIDEO_ID
 * * HTTPS://YOUTU.BE/VIDEO_ID                  (upper-case scheme / host)
 * * "olha esse https://youtu.be/VIDEO_ID 🔥"   (share text around the link)
 *   youtube.com/watch?v=VIDEO_ID               (no scheme)
 *   VIDEO_ID                                   (bare, see looksLikeBareVideoId)
 *
 * Look-alike hosts (`youtube.com.evil.com`, `evil.com/youtube.com/…`,
 * `youtube.com@evil.com`) are refused: the host is compared exactly after
 * URL parsing, never by substring.
 */
export function parseYouTubeVideoId(input: string): string | null {
  if (!input || typeof input !== "string") return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Share text ("olha esse https://youtu.be/… 🔥"): the patron pasted a whole
  // message. Only a URL-shaped token is taken from it — a bare word inside a
  // sentence is never read as an id.
  if (/\s/.test(trimmed)) {
    for (const token of trimmed.split(/\s+/)) {
      if (!/youtu/i.test(token)) continue;
      const id = parseYouTubeUrl(stripSharePunctuation(token));
      if (id) return id;
    }
    return null;
  }

  // TICKET-140 gap 1: a bare 11-character token is an id only when it cannot
  // plausibly be a word, so typing "Imagination" searches instead of
  // auto-selecting a video that does not exist.
  if (looksLikeBareVideoId(trimmed)) return trimmed;

  return parseYouTubeUrl(stripSharePunctuation(trimmed));
}

/**
 * A bare 11-character token counts as a video id only when it cannot
 * plausibly be a typed word (TICKET-140 gap 1). Rule: it is a valid id shape
 * AND it contains a digit or `_`, OR it mixes case beyond Title Case (an
 * upper-case letter after the first character next to a lower-case one).
 *
 * Trade-off, both directions:
 *  - Words are safe: "Imagination", "unbreakable", "BITTERSWEET" and also
 *    hyphenated 11-character queries such as "rock-n-roll" or "hip-hop-pop"
 *    search as text. A hyphen alone is deliberately NOT enough, for that reason.
 *  - Real ids lost: roughly 1 in 6,000 real ids has no digit and no `_` AND
 *    happens to be all lower case, all upper case or Title Case. Pasted as a
 *    bare id, such an id is searched as text instead; pasted as a link (what
 *    the share button produces) it still resolves, because URLs never go
 *    through this check.
 *  - Words lost the other way: an 11-character query with a digit or odd
 *    casing ("Blink182abc", "AC-DC-Rocks") is taken as an id. Rare, and the
 *    patron sees the pasted row and can keep typing.
 */
export function looksLikeBareVideoId(token: string): boolean {
  if (!isValidVideoId(token)) return false;
  if (/[0-9_]/.test(token)) return true;
  const hasLower = /[a-z]/.test(token);
  const upperAfterFirst = /[A-Z]/.test(token.slice(1));
  return hasLower && upperAfterFirst;
}

/** Trim the punctuation a chat app glues around a link ("(link)", "link,", "<link>"). */
function stripSharePunctuation(token: string): string {
  return token.replace(/^[(<\[{"'“‘]+/, "").replace(/[)>\]}"'”’.,;:!?]+$/, "");
}

const WATCH_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const NOCOOKIE_HOSTS = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"]);
const SHORT_HOSTS = new Set(["youtu.be", "www.youtu.be"]);

/** Parse one URL-shaped token (scheme optional, any case). Returns null for anything else. */
function parseYouTubeUrl(token: string): string | null {
  if (!token) return null;
  let url: URL;
  try {
    // Attach a scheme to a bare host. The test is case-insensitive so
    // "HTTPS://YOUTU.BE/…" is not turned into "https://HTTPS://…".
    url = new URL(/^https?:\/\//i.test(token) ? token : `https://${token}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  // URL lower-cases the hostname, so an upper-case host compares correctly.
  const host = url.hostname;
  const segments = url.pathname.split("/").filter((s, i, all) => s !== "" || i < all.length - 1);
  // segments[0] is "" (leading slash); a single trailing "" is dropped above.

  if (WATCH_HOSTS.has(host)) {
    const v = url.searchParams.get("v");
    if (v && isValidVideoId(v)) return v;
    // /embed/ID, /shorts/ID, /live/ID, /v/ID — exactly one id segment.
    if (segments.length === 3 && /^(embed|shorts|live|v)$/.test(segments[1]) && isValidVideoId(segments[2])) {
      return segments[2];
    }
    return null;
  }

  if (NOCOOKIE_HOSTS.has(host)) {
    if (segments.length === 3 && segments[1] === "embed" && isValidVideoId(segments[2])) {
      return segments[2];
    }
    return null;
  }

  if (SHORT_HOSTS.has(host)) {
    // youtu.be/ID, optionally with one trailing slash.
    if (segments.length === 2 && isValidVideoId(segments[1])) return segments[1];
    return null;
  }

  return null;
}

/** Strict YouTube video-ID check: exactly 11 chars of [A-Za-z0-9_-]. */
export function isValidVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

/* ------------------------------------------------------------------------- *
 * Embeddability pre-check (TICKET-61)
 *
 * A pasted YouTube link bypasses search, so it is never filtered by the
 * `videoEmbeddable`/`videoSyndicated` search params. Some videos refuse to play
 * outside youtube.com — on the venue TV they simply die and the TICKET-41
 * watchdog skips them mid-night. This helper asks `videos.list` for
 * `status.embeddable` (1 quota unit) at submit time.
 *
 * TICKET-140: the check now runs for EVERY submit (the client's `source` hint
 * no longer decides it), and a DEFINITE "not-embeddable" answer blocks the
 * submit with friendly copy. Anything short of a definite answer still lets
 * the song through.
 *
 * Design rules, deliberate and load-bearing:
 *   - It NEVER throws: every failure mode (no key, bad id, HTTP error, quota
 *     exhaustion, timeout, malformed JSON) collapses to "unknown", which the
 *     caller treats exactly like "embeddable" (fail-open).
 *   - It is bounded by an abort timeout, so a hanging Google call cannot pin an
 *     unauthenticated request open.
 *   - The id is re-validated here (not just at the route) before it is placed in
 *     an outbound URL, and it goes through URLSearchParams — no string
 *     concatenation into the query.
 * ------------------------------------------------------------------------- */

const VIDEOS_ENDPOINT_PATH = "/youtube/v3/videos";
const DEFAULT_API_ORIGIN = "https://www.googleapis.com";

/**
 * Outbound-call budget for the pre-check. Short: it must not slow a submit.
 *
 * TICKET-95 (MEDIUM-3 of the TICKET-67 cyber follow-ups) tightened this from
 * 1500ms to 800ms. Reasoning: `lib/embed-cache.ts` (TICKET-95 MEDIUM-1) now
 * answers the common case — a repeat videoId — with zero network calls, so
 * this budget only bites on a genuine cache miss (a videoId never checked
 * before, or one whose prior verdict was "unknown" and expired). On a miss,
 * Google's `videos.list` is normally well under 800ms end-to-end; a timeout
 * fails OPEN to "unknown" (never blocks the submit — see the design rules
 * above), so tightening this only trades a few accurate not-embeddable
 * warnings under real upstream slowness for materially less held concurrency
 * on this unauthenticated, most-hit mutation route during a slow-upstream or
 * miss-burst window (many distinct new videos submitted at once). 800ms was
 * chosen over going lower still because Data API p99s occasionally land in
 * the 400–700ms range from some regions, and cutting it much closer would
 * start trading away real warnings for negligible additional hold-time
 * savings.
 */
export const EMBEDDABLE_CHECK_TIMEOUT_MS = 800;

/**
 * Result of the pre-check. `unknown` is the fail-open value: the caller must
 * treat it exactly like `embeddable` (no error, submit proceeds). Only
 * `not-embeddable` refuses a submit (TICKET-140 gap 5).
 */
export type EmbeddableStatus = "embeddable" | "not-embeddable" | "unknown";

/**
 * Display facts about a video, fetched server-side (TICKET-140 gap 3). Every
 * field is optional: a failed lookup simply leaves the patron's existing
 * `youtu.be/<id>` display in place.
 */
export interface VideoMeta {
  title?: string;
  channelTitle?: string;
  /** Display duration ("3:45"), from `contentDetails.duration`. */
  duration?: string;
}

/** Longest title / channel name we keep (matches the queue route's MAX_TITLE). */
export const META_TITLE_MAX = 120;
export const META_CHANNEL_MAX = 80;

/**
 * Normalise an untrusted upstream string for display: drop control characters,
 * collapse whitespace, cap the length. React escapes it on render, so this is
 * about tidy UI and bounded storage, not about markup.
 */
export function cleanMetaText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Whether an origin override may be honoured. Never on a deployed site:
 *  - any non-production process (dev, jest) may use it, or
 *  - a production BUILD run locally by the e2e suite, which must say so
 *    explicitly with BORAOKE_E2E_STUBS=1 and is never on Vercel.
 * Either way the override must be a loopback origin (cyber gate, TICKET-61),
 * so a misconfiguration can at worst point the call at this machine.
 */
function overrideAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.BORAOKE_E2E_STUBS === "1" && !process.env.VERCEL;
}

/** Returns the loopback override in `envName` when it may be honoured, else null. */
function loopbackOverride(envName: string): string | null {
  const override = process.env[envName];
  if (!override || !overrideAllowed()) return null;
  try {
    const host = new URL(override).hostname;
    if (LOOPBACK_HOSTS.has(host)) return override;
  } catch {
    /* unparseable override → ignore it */
  }
  return null;
}

/**
 * Resolve the Data API origin. Production is always the constant above; a
 * non-production process (or the local e2e build, see `overrideAllowed`) may
 * point the helper at a local stub — there is no way to intercept a
 * server-side fetch from the browser.
 */
function apiOrigin(): string {
  return loopbackOverride("YOUTUBE_API_ORIGIN") ?? DEFAULT_API_ORIGIN;
}

/**
 * The key for the `videos.list` call. When the call goes to a local stub the
 * real key is never sent there: a placeholder is used instead, which also lets
 * the e2e suite exercise the check without any key provisioned.
 */
export function videoApiKey(): string | undefined {
  if (loopbackOverride("YOUTUBE_API_ORIGIN")) return "local-stub-key";
  return process.env.YOUTUBE_API_KEY || undefined;
}

/** Result of `fetchVideoDetails`: the embeddability verdict plus any metadata the same call returned. */
export interface VideoDetails {
  status: EmbeddableStatus;
  meta?: VideoMeta;
}

/**
 * ONE `videos.list` call for `part=status,snippet,contentDetails`: the
 * embeddability verdict, the title and channel, and the duration. Still
 * 1 quota unit (the cost is per call, not per part) from the separate
 * ~10k/day pool — never `search.list`.
 *
 * Every failure collapses to `{ status: "unknown" }`, see the design rules above.
 */
export async function fetchVideoDetails(
  videoId: string,
  key: string | undefined,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<VideoDetails> {
  if (!key) return { status: "unknown" }; // no key configured (dev/CI) → no check
  if (!isValidVideoId(videoId)) return { status: "unknown" }; // never put an unvalidated id in a URL

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EMBEDDABLE_CHECK_TIMEOUT_MS;

  try {
    const url = new URL(VIDEOS_ENDPOINT_PATH, apiOrigin());
    url.searchParams.set("part", "status,snippet,contentDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", key);

    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any non-OK (403 quotaExceeded, 400, 5xx, …) is a fail-open "unknown".
    if (!res.ok) return { status: "unknown" };

    const json = (await res.json()) as {
      items?: Array<{
        id?: string;
        status?: { embeddable?: boolean };
        snippet?: { title?: unknown; channelTitle?: unknown };
        contentDetails?: { duration?: unknown };
      }>;
    };
    const item = json?.items?.[0];
    // An answer about a different video is no answer.
    if (!item || (item.id !== undefined && item.id !== videoId)) return { status: "unknown" };

    const embeddable = item.status?.embeddable;
    const status: EmbeddableStatus =
      typeof embeddable !== "boolean" ? "unknown" : embeddable ? "embeddable" : "not-embeddable";

    const title = cleanMetaText(item.snippet?.title, META_TITLE_MAX);
    const channelTitle = cleanMetaText(item.snippet?.channelTitle, META_CHANNEL_MAX);
    const duration =
      typeof item.contentDetails?.duration === "string"
        ? formatDuration(item.contentDetails.duration)
        : "";
    const meta: VideoMeta | undefined = title
      ? { title, ...(channelTitle ? { channelTitle } : {}), ...(duration ? { duration } : {}) }
      : undefined;
    return meta ? { status, meta } : { status };
  } catch {
    // Network error, abort timeout, malformed JSON — all fail open.
    return { status: "unknown" };
  }
}

/**
 * Ask the YouTube Data API whether `videoId` may be embedded on a third-party
 * page. Costs 1 quota unit per call. Returns "unknown" for every failure —
 * see the design rules above. `fetchImpl` is injectable for tests.
 */
export async function checkEmbeddable(
  videoId: string,
  key: string | undefined,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EmbeddableStatus> {
  return (await fetchVideoDetails(videoId, key, opts)).status;
}

/* ------------------------------------------------------------------------- *
 * oEmbed title lookup (TICKET-140 gap 3)
 *
 * `https://www.youtube.com/oembed` needs no API key and spends no Data API
 * quota. It returns the title and channel name, and 404 (or 400/401/403) for a
 * video it will not describe. Same design rules as the pre-check above: fixed
 * host, URLSearchParams, re-validated id, bounded timeout, never throws.
 * ------------------------------------------------------------------------- */

const DEFAULT_OEMBED_ORIGIN = "https://www.youtube.com";
export const OEMBED_TIMEOUT_MS = 800;

/** `found` carries metadata; `missing` is a definite "no such public video"; `error` is a transient failure. */
export type OEmbedResult =
  | { kind: "found"; meta: VideoMeta }
  | { kind: "missing" }
  | { kind: "error" };

export async function fetchOEmbed(
  videoId: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<OEmbedResult> {
  if (!isValidVideoId(videoId)) return { kind: "missing" };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? OEMBED_TIMEOUT_MS;
  try {
    const url = new URL("/oembed", loopbackOverride("YOUTUBE_OEMBED_ORIGIN") ?? DEFAULT_OEMBED_ORIGIN);
    url.searchParams.set("url", `https://www.youtube.com/watch?v=${videoId}`);
    url.searchParams.set("format", "json");
    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if ([400, 401, 403, 404].includes(res.status)) return { kind: "missing" };
    if (!res.ok) return { kind: "error" };
    const json = (await res.json()) as { title?: unknown; author_name?: unknown };
    const title = cleanMetaText(json?.title, META_TITLE_MAX);
    if (!title) return { kind: "error" };
    const channelTitle = cleanMetaText(json?.author_name, META_CHANNEL_MAX);
    return { kind: "found", meta: { title, ...(channelTitle ? { channelTitle } : {}) } };
  } catch {
    return { kind: "error" };
  }
}

/** ISO-8601 duration ("PT4M13S") → "4:13". Mirrors `formatISODuration` in lib/youtube-search.ts (kept local: this file ships to the client). */
function formatDuration(iso: string): string {
  const m = iso.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m || !/\d/.test(iso)) return "";
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  const seconds = Number(m[3] ?? 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}
