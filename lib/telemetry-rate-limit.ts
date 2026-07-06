/**
 * /api/t beacon rate limiter (TICKET-12, security gate M1) — the house
 * dual-bucket sliding-window pattern (same class as the TICKET-8 search and
 * TICKET-11 feedback limiters; implemented standalone so telemetry stays
 * dependency-free from other tickets' modules).
 *
 * Why dual-bucket: the session key (uuid/sessionKey) alone is client-minted —
 * an abuser bypasses a session-only limit by rotating keys. We therefore
 * limit on BOTH the session key AND the caller IP; whichever bucket trips
 * first drops the event. The IP ceiling is deliberately generous because a
 * whole bar shares one venue IP/NAT.
 *
 * Limits are beacon-appropriate (generous — telemetry, not a mutation API),
 * and the route SILENTLY DROPS over-limit events (204, nothing stored) rather
 * than erroring: telemetry must stay fail-open for the app (spec AC2).
 *
 * Heap-growth guard: the bucket map is LRU-capped (session keys are
 * attacker-minted; an unbounded Map grows the heap under rotation). Oldest-
 * touched buckets evict first past BUCKETS_MAX; the IP bucket (one key per
 * host, constantly re-touched, effectively never the LRU victim) holds the
 * line for evicted rotators.
 */

const RATE_SESSION_MAX = 60; // per session key (uuid/sessionKey) per window
const RATE_IP_MAX = 300; // per IP per window (shared venue-IP headroom)
const RATE_WINDOW_MS = 60_000;
const RATE_BUCKETS_MAX = 2000; // cap on total tracked buckets (session + ip keys)

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

/** Evict oldest-touched buckets past the cap (heap-growth guard). */
function evictOverflow(): void {
  while (hits.size > RATE_BUCKETS_MAX) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
}

/**
 * Returns true when the beacon event may be recorded (and charges both
 * buckets), false when EITHER the session bucket or the IP bucket exceeds its
 * window. `sessionKey`/`ip` may be "" when unavailable (then only the other
 * bucket applies; both "" = allowed — local unit tests).
 */
export function beaconRateLimitOk(
  sessionKey: string,
  ip = "",
  now = Date.now(),
): boolean {
  const sessionOk = sessionKey
    ? bucketOk(`s:${sessionKey}`, RATE_SESSION_MAX, now)
    : true;
  // Evaluate (and charge) the IP bucket even when the session bucket already
  // tripped, so rotating session keys can't dodge the IP window's accounting.
  const ipOk = ip ? bucketOk(`ip:${ip}`, RATE_IP_MAX, now) : true;
  evictOverflow();
  return sessionOk && ipOk;
}

export const BEACON_RATE_SESSION_MAX = RATE_SESSION_MAX;
export const BEACON_RATE_IP_MAX = RATE_IP_MAX;
export const BEACON_RATE_WINDOW_MS = RATE_WINDOW_MS;

/** Test helper — clear rate-limit state. */
export function _resetBeaconRateLimit(): void {
  hits.clear();
}

/** Test helper — current number of tracked buckets. */
export function _beaconRateBucketCount(): number {
  return hits.size;
}
