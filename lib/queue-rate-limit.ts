/**
 * POST /api/queue submit rate limiter (TICKET-10, security MEDIUM-1 track 2) —
 * the house dual-bucket sliding-window pattern (same class as the TICKET-8
 * search, TICKET-11 feedback, and TICKET-12 beacon limiters; standalone so the
 * queue path stays dependency-free from other tickets' modules).
 *
 * Why it exists here: full-karaoke has no per-patron sing cap by design, and
 * every accepted submit triggers a queue re-lay. Without a rate limit one
 * scripted patron can flood submits until QUEUE_MAX, riding the relay on every
 * request. Limits are bar-appropriate and generous — a human queuing songs
 * never hits them:
 *
 *   - 10 submits / min / patronUuid (uuid is client-minted → dual-bucket)
 *   - 60 submits / min / IP (a whole bar shares one venue NAT/IP)
 *
 * Over-limit gets a polite pt-BR 429 (a mutation API — unlike the fail-open
 * telemetry beacon, we tell the patron to slow down rather than silently drop).
 *
 * Heap-growth guard: LRU-capped bucket map (uuids are attacker-minted; an
 * unbounded Map grows the heap under rotation). Oldest-touched buckets evict
 * first past BUCKETS_MAX; the IP bucket (one key per host, constantly
 * re-touched) holds the line for evicted rotators.
 */

const RATE_UUID_MAX = 10; // submits per patronUuid per window
const RATE_IP_MAX = 60; // submits per IP per window (shared venue-IP headroom)
const RATE_WINDOW_MS = 60_000;
const RATE_BUCKETS_MAX = 2000;

/** Friendly pt-BR copy for the 429 (spec tone: helpful, not punitive). */
export const SUBMIT_RATE_MESSAGE =
  "Calma, cantor! Muitos pedidos em pouco tempo — espere um minutinho e tente de novo.";

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
 * Returns true when this submit may proceed (and charges both buckets), false
 * when EITHER the uuid bucket or the IP bucket exceeds its window. `uuid`/`ip`
 * may be "" when unavailable (then only the other bucket applies).
 */
export function submitRateLimitOk(
  uuid: string,
  ip = "",
  now = Date.now(),
): boolean {
  const uuidOk = uuid ? bucketOk(`u:${uuid}`, RATE_UUID_MAX, now) : true;
  // Evaluate (and charge) the IP bucket even when the uuid bucket already
  // tripped, so rotating uuids can't dodge the IP window's accounting.
  const ipOk = ip ? bucketOk(`ip:${ip}`, RATE_IP_MAX, now) : true;
  evictOverflow();
  return uuidOk && ipOk;
}

export const SUBMIT_RATE_UUID_MAX = RATE_UUID_MAX;
export const SUBMIT_RATE_IP_MAX = RATE_IP_MAX;
export const SUBMIT_RATE_WINDOW_MS = RATE_WINDOW_MS;

/** Test helper — clear rate-limit state. */
export function _resetSubmitRateLimit(): void {
  hits.clear();
}
