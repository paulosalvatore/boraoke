/**
 * YouTube URL parser — extracts the video ID from common YouTube URL formats.
 * No API key required; purely client-side string parsing.
 *
 * Supported formats:
 *   https://www.youtube.com/watch?v=VIDEO_ID
 *   https://youtu.be/VIDEO_ID
 *   https://youtube.com/shorts/VIDEO_ID
 *   https://www.youtube.com/embed/VIDEO_ID
 *   https://www.youtube.com/live/VIDEO_ID
 *   Raw 11-character video IDs
 */
export function parseYouTubeVideoId(input: string): string | null {
  if (!input) return null;

  const trimmed = input.trim();

  // Raw video ID: exactly 11 chars, alphanumeric + - + _
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // Try parsing as URL
  let url: URL;
  try {
    // Attach a scheme if it looks like a bare host
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtube.com" || host === "m.youtube.com") {
    // /watch?v=...
    const v = url.searchParams.get("v");
    if (v && isValidVideoId(v)) return v;

    // /embed/VIDEO_ID, /shorts/VIDEO_ID, /live/VIDEO_ID
    const match = url.pathname.match(
      /^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/
    );
    if (match) return match[2];
  }

  if (host === "youtu.be") {
    // youtu.be/VIDEO_ID
    const id = url.pathname.slice(1).split("?")[0];
    if (isValidVideoId(id)) return id;
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
 * `status.embeddable` (1 quota unit) so the patron can be warned at submit time.
 *
 * Design rules, deliberate and load-bearing:
 *   - It NEVER throws and NEVER blocks: every failure mode (no key, bad id,
 *     HTTP error, quota exhaustion, timeout, malformed JSON) collapses to
 *     "unknown", which the caller renders as "no warning".
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
 * treat it exactly like `embeddable` (no warning, no error, submit proceeds).
 */
export type EmbeddableStatus = "embeddable" | "not-embeddable" | "unknown";

/**
 * Resolve the Data API origin. Production is always the constant above; a
 * non-production process may point the helper at a local stub for end-to-end
 * testing (there is no way to intercept a server-side fetch from the browser).
 * Guarded by NODE_ENV so the override can never be honored on the live site.
 */
function apiOrigin(): string {
  const override = process.env.YOUTUBE_API_ORIGIN;
  if (process.env.NODE_ENV === "production" || !override) return DEFAULT_API_ORIGIN;
  // Loopback only (cyber gate): the call carries the API key, so the override
  // must not be able to ship a real key to an arbitrary host even by operator
  // mistake. A local stub is the only legitimate use.
  try {
    const host = new URL(override).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1") {
      return override;
    }
  } catch {
    /* unparseable override → ignore it */
  }
  return DEFAULT_API_ORIGIN;
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
  if (!key) return "unknown"; // no key configured (dev/CI) → no check, no warning
  if (!isValidVideoId(videoId)) return "unknown"; // never put an unvalidated id in a URL

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? EMBEDDABLE_CHECK_TIMEOUT_MS;

  try {
    const url = new URL(VIDEOS_ENDPOINT_PATH, apiOrigin());
    url.searchParams.set("part", "status");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", key);

    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any non-OK (403 quotaExceeded, 400, 5xx, …) is a fail-open "unknown".
    if (!res.ok) return "unknown";

    const json = (await res.json()) as {
      items?: Array<{ status?: { embeddable?: boolean } }>;
    };
    const embeddable = json?.items?.[0]?.status?.embeddable;
    if (typeof embeddable !== "boolean") return "unknown"; // deleted/private/absent
    return embeddable ? "embeddable" : "not-embeddable";
  } catch {
    // Network error, abort timeout, malformed JSON — all fail open.
    return "unknown";
  }
}
