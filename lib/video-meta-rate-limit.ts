/**
 * GET /api/video-meta rate limit (TICKET-140 gap 4): the paste preview.
 *
 * Same sliding-window, LRU-capped shape as lib/queue-rate-limit.ts. The
 * endpoint only ever reads the title cache or calls keyless oEmbed (never the
 * Data API), so this bucket only has to stop a flood from turning the server
 * into an oEmbed relay. A patron pastes a handful of links a night; a whole
 * bar shares one venue IP, hence the IP ceiling's headroom.
 *
 * Per instance, like the other in-memory limiters (TICKET-67 tracks moving
 * them cross-instance). The per-videoId cache in front of oEmbed bounds the
 * outbound work regardless.
 */

const RATE_IP_MAX = 60; // previews per IP per window
const RATE_WINDOW_MS = 60_000;
const RATE_BUCKETS_MAX = 2000;

const hits = new Map<string, number[]>();

export function videoMetaRateLimitOk(ip: string, now = Date.now()): boolean {
  const key = `ip:${ip || "unknown"}`;
  const windowStart = now - RATE_WINDOW_MS;
  const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
  hits.delete(key);
  if (recent.length >= RATE_IP_MAX) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  while (hits.size > RATE_BUCKETS_MAX) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
  return true;
}

export const VIDEO_META_RATE_IP_MAX = RATE_IP_MAX;

/** Test helper — clear rate-limit state. */
export function _resetVideoMetaRateLimit(): void {
  hits.clear();
}
