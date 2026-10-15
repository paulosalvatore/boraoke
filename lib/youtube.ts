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
 *
 * Input longer than MAX_PARSE_INPUT is refused before any regex runs. The
 * server parses `youtubeUrl` before its submit rate limit, so the parser's
 * cost must stay flat whatever an unauthenticated caller sends.
 *
 * This module ships to the browser. Anything that reads the API key or calls
 * YouTube lives in lib/youtube-server.ts, which is `server-only`.
 */
export function parseYouTubeVideoId(input: string): string | null {
  if (!input || typeof input !== "string") return null;
  if (input.length > MAX_PARSE_INPUT) return null;

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

/**
 * Longest input the parser looks at. A real share message ("olha esse
 * https://youtu.be/… 🔥") is far shorter; the patron's search box uses the
 * same cap as its `maxLength`.
 */
export const MAX_PARSE_INPUT = 512;

const LEADING_SHARE_PUNCTUATION = new Set(["(", "<", "[", "{", '"', "'", "“", "‘"]);
const TRAILING_SHARE_PUNCTUATION = new Set([")", ">", "]", "}", '"', "'", "”", "’", ".", ",", ";", ":", "!", "?"]);

/**
 * Trim the punctuation a chat app glues around a link ("(link)", "link,",
 * "<link>"). A plain index walk from each end, so the cost is linear in the
 * token length: an end-anchored regex here backtracked quadratically on a long
 * run of punctuation that is not at the end.
 */
function stripSharePunctuation(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_SHARE_PUNCTUATION.has(token[start])) start++;
  while (end > start && TRAILING_SHARE_PUNCTUATION.has(token[end - 1])) end--;
  return token.slice(start, end);
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

/**
 * Result of the embeddability pre-check (lib/youtube-server.ts). `unknown` is
 * the fail-open value: the caller must treat it exactly like `embeddable` (no
 * error, submit proceeds). Only `not-embeddable` refuses a submit.
 */
export type EmbeddableStatus = "embeddable" | "not-embeddable" | "unknown";

/**
 * Display facts about a video, fetched server-side. Every field is optional:
 * a failed lookup simply leaves the `youtu.be/<id>` display in place.
 */
export interface VideoMeta {
  title?: string;
  channelTitle?: string;
  /** Display duration ("3:45"), from `contentDetails.duration`. */
  duration?: string;
}
