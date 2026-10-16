/**
 * Server-only YouTube calls: the `videos.list` embeddability + metadata call,
 * the keyless oEmbed title lookup, the API key reader and the loopback origin
 * overrides the e2e suite uses.
 *
 * Kept apart from lib/youtube.ts on purpose. That module is imported by a
 * client component (the patron's search box) for the link parser, so anything
 * that reads `YOUTUBE_API_KEY` must not live there, even if tree-shaking would
 * drop it today. `server-only` makes a client import of this file a build
 * error instead of a silent bundle risk.
 */

import "server-only";

import { isValidVideoId, type EmbeddableStatus, type VideoMeta } from "@/lib/youtube";

export type { EmbeddableStatus, VideoMeta };

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

/**
 * Test seam: whether the queue route may store the client-sent title when every
 * server lookup failed. Production never does (a client title is free text on
 * the venue TV). Test builds point every YouTube call at a closed or stub port,
 * so without this the suites that seed songs by title would all read
 * `youtu.be/<id>`. Needs BOTH the explicit BORAOKE_TEST_CLIENT_TITLES=1 flag
 * and the same non-deployed gate as the origin overrides, so it is off on
 * Vercel whatever the env says.
 */
export function clientTitleFallbackAllowed(): boolean {
  return process.env.BORAOKE_TEST_CLIENT_TITLES === "1" && overrideAllowed();
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

/** ISO-8601 duration ("PT4M13S") → "4:13". Mirrors `formatISODuration` in lib/youtube-search.ts. */
export function formatDuration(iso: string): string {
  const m = iso.match(/^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m || !/\d/.test(iso)) return "";
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  const seconds = Number(m[3] ?? 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}
