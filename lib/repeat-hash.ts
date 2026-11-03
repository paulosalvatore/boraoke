/**
 * Salted hashes for the cross-day repeat measurement.
 *
 * `search_performed{source:"live"}` carries a hash of the FOLDED cache key and
 * `song_queued` a hash of the `videoId`, so a read-only report can count how
 * often a billed question, or a song, comes back across days. The raw query
 * text and the raw `videoId` never reach telemetry.
 *
 * HMAC-SHA256 keyed by one env var, `TELEMETRY_HASH_SALT`. Without the salt a
 * plain hash of a video id (a small, enumerable space) could be reversed by
 * hashing every candidate, so there is deliberately NO fallback salt: when the
 * variable is unset or blank the helpers return `undefined`, the caller omits
 * the field, and the event is emitted exactly as before. Nothing here throws.
 *
 * Output is the first 16 hex characters (64 bits) of the digest. At the
 * volumes involved (well under 10^5 distinct keys) the collision odds are
 * around 10^-10, far below the noise in a repeat rate, and the value fits the
 * telemetry prop limit (MAX_PROP_STRING = 64) with room to spare. Each kind is
 * domain-separated so a key and a video id can never hash alike.
 *
 * The cost is one synchronous HMAC over a short string (microseconds), so it
 * sits on the request path without measurable effect.
 */

import { createHmac } from "node:crypto";

export const REPEAT_HASH_SALT_ENV = "TELEMETRY_HASH_SALT";
export const REPEAT_HASH_HEX_LENGTH = 16;

type HashKind = "key" | "video";

function hashWith(kind: HashKind, value: string): string | undefined {
  try {
    const salt = process.env[REPEAT_HASH_SALT_ENV];
    if (!salt || !salt.trim() || !value) return undefined;
    return createHmac("sha256", salt)
      .update(`${kind}\u0000${value}`)
      .digest("hex")
      .slice(0, REPEAT_HASH_HEX_LENGTH);
  } catch {
    return undefined;
  }
}

/**
 * Hash of a search cache key. Pass the output of `cacheKey()` (it already
 * contains the fold from `foldSearchKey`, the region and the page marker), so
 * the hash follows the cache's own notion of "the same question".
 */
export function hashCacheKey(cacheKeyValue: string): string | undefined {
  return hashWith("key", cacheKeyValue);
}

/** Hash of a YouTube `videoId`. */
export function hashVideoId(videoId: string): string | undefined {
  return hashWith("video", videoId);
}

/** Spreadable prop for `search_performed` (empty when no salt is configured). */
export function keyHashProp(cacheKeyValue: string): { keyHash?: string } {
  const h = hashCacheKey(cacheKeyValue);
  return h ? { keyHash: h } : {};
}

/** Spreadable prop for `song_queued` (empty when no salt is configured). */
export function videoHashProp(videoId: string): { videoHash?: string } {
  const h = hashVideoId(videoId);
  return h ? { videoHash: h } : {};
}
