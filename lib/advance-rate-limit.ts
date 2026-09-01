/**
 * Per-room advance rate limiter (TICKET-45) — the defense-in-depth backstop rung
 * under the screen token. Same house dual-bucket sliding-window pattern as
 * `queue-rate-limit.ts` (and the TICKET-8 search / TICKET-11 feedback limiters);
 * standalone so the advance path stays dependency-free from other tickets.
 *
 * WHY, even with the screen token: the token is scrapeable off the public TV
 * page (see the honest threat note in screen-token.ts). A scraper who lifts a
 * valid token could still spam advance and grief a room. A per-room throttle
 * caps how fast ANY caller — token-holder or not — can drain a queue, which
 * blunts skip-spam without touching the legitimate TV cadence: the TV advances
 * once per song (minutes apart) and the watchdog skips at most once per stall.
 *
 * TWO INDEPENDENT PER-ROOM BUCKETS (TICKET-47):
 *
 *   - singer-skip bucket (non-`unplayable` advances): 12 / room / 60s. This is
 *     the anti-grief limit the PR #26 opus finding F2 says must NOT weaken — a
 *     scraped-token caller skipping the current *playing* singer hits this.
 *
 *   - unplayable bucket (`reason=unplayable` watchdog drains): 40 / room / 60s.
 *     When a run of queue entries are *instantly* unembeddable the watchdog
 *     fires advances in rapid succession (instant onError, no stall ladder to
 *     pace it); after 12 the old single bucket 429'd and the TV wedged on an
 *     unplayable video for up to 60s — the exact recovery the watchdog exists
 *     for, blocked by the anti-grief throttle. A separate higher-but-bounded
 *     bucket clears the wedge (a real bad-run rarely exceeds ~20 in a row)
 *     while still capping a forged/runaway loop — `reason` is caller-supplied
 *     and forgeable, so a full exemption would let a forger bypass the throttle
 *     entirely; the 40-ceiling keeps a hard backstop on ANY advance.
 *
 * THIRD BUCKET (TICKET-96 / TICKET-47 FU-1 design spike, recommended option (c)):
 *
 *   - total bucket (EVERY advance, whatever the claimed reason): 40 / room / 60s.
 *     The two buckets above share no state, so a caller alternating
 *     `?reason=unplayable` with a reasonless advance could draw 12 + 40 = 52
 *     successful advances/room/60s — the `reason` is client-supplied and the
 *     server cannot verify it, so this was a real alternation bonus, not a
 *     theoretical one (see the spike, `work/plans/TICKET-47-FU-1-playability-signal.md`).
 *     Charging a third bucket on every advance, independent of the specific
 *     bucket, closes that gap without ever needing to tell an honest skip from
 *     a forged one: the worst case becomes 40/min instead of 52/min, and a pure
 *     singer-skip forger is still capped at 12/min by the unchanged strict
 *     bucket. An advance must clear BOTH its specific bucket AND the total
 *     bucket to succeed.
 *
 * Bucketed PER ROOM (not per IP/uuid): the venue TV is one caller per room, and
 * an attacker rotating IPs still hits the same room bucket. Heap-growth guard:
 * LRU-capped map (room ids are attacker-mintable slugs), oldest-touched evict.
 * All three buckets share the one map via distinct key prefixes, so the single
 * LRU guard covers all of them — a room now occupies up to 3 LRU slots instead
 * of 2 against ADVANCE_BUCKETS_MAX (still ~666 concurrent rooms at 2000 slots).
 */

const ADVANCE_ROOM_MAX = 12; // singer-skip advances per room per window
const ADVANCE_UNPLAYABLE_ROOM_MAX = 40; // unplayable watchdog drains per room per window
const ADVANCE_TOTAL_ROOM_MAX = 40; // EVERY advance, any claimed reason, per room per window
const ADVANCE_WINDOW_MS = 60_000;
const ADVANCE_BUCKETS_MAX = 2000;

const hits = new Map<string, number[]>();

/** Evict oldest-touched buckets past the cap (heap-growth guard). */
function evictOverflow(): void {
  while (hits.size > ADVANCE_BUCKETS_MAX) {
    const oldest = hits.keys().next().value;
    if (oldest === undefined) break;
    hits.delete(oldest);
  }
}

export interface AdvanceRateOptions {
  /** true for a `reason=unplayable` watchdog drain — charges the separate,
   * more generous unplayable bucket instead of the anti-grief singer-skip one. */
  unplayable?: boolean;
}

/** LRU touch: delete + re-set moves the key to the Map's insertion-order tail. */
function touch(key: string, arr: number[]): void {
  hits.delete(key);
  hits.set(key, arr);
}

/**
 * Returns true when this advance may proceed (and charges the relevant room
 * bucket(s)), false when any applicable bucket has exceeded its per-minute
 * window. On denial neither bucket is charged with a new hit (only the pruned
 * window is persisted), matching the pre-TICKET-96 check-then-charge shape.
 *
 * The unplayable watchdog-drain path (`{ unplayable: true }`) is charged to a
 * separate, more generous bucket so a legitimate bad-instafail run can drain
 * without wedging, while the singer-skip anti-grief limit stays exactly 12/60s.
 *
 * TICKET-96: EVERY advance, regardless of the claimed reason, is additionally
 * charged to a third `total:<room>` bucket (40/60s). An advance must clear
 * BOTH its specific bucket (singer-skip or unplayable) AND the total bucket to
 * succeed — this caps the worst case at 40/min/room independent of how the
 * caller splits their calls across reasons, closing the alternation bonus the
 * two independent buckets used to allow (12 + 40 = 52).
 *
 * Back-compat: the 2nd arg may be either the options object or a `now`
 * timestamp number (the pre-TICKET-47 signature `advanceRateLimitOk(id, now)`).
 */
export function advanceRateLimitOk(
  roomId: string,
  optsOrNow: AdvanceRateOptions | number = {},
  now: number = Date.now(),
): boolean {
  // Support the legacy `advanceRateLimitOk(roomId, now)` 2-arg call.
  const opts: AdvanceRateOptions =
    typeof optsOrNow === "number" ? {} : optsOrNow;
  const at: number = typeof optsOrNow === "number" ? optsOrNow : now;

  const specificMax = opts.unplayable
    ? ADVANCE_UNPLAYABLE_ROOM_MAX
    : ADVANCE_ROOM_MAX;
  const specificKey = opts.unplayable ? `unplayable:${roomId}` : `room:${roomId}`;
  const totalKey = `total:${roomId}`;
  const windowStart = at - ADVANCE_WINDOW_MS;

  const specificRecent = (hits.get(specificKey) ?? []).filter(
    (t) => t > windowStart,
  );
  const totalRecent = (hits.get(totalKey) ?? []).filter((t) => t > windowStart);

  if (
    specificRecent.length >= specificMax ||
    totalRecent.length >= ADVANCE_TOTAL_ROOM_MAX
  ) {
    // keep the pruned windows even on trip
    touch(specificKey, specificRecent);
    touch(totalKey, totalRecent);
    evictOverflow();
    return false;
  }

  specificRecent.push(at);
  totalRecent.push(at);
  touch(specificKey, specificRecent);
  touch(totalKey, totalRecent);
  evictOverflow();
  return true;
}

export const ADVANCE_RATE_ROOM_MAX = ADVANCE_ROOM_MAX;
export const ADVANCE_RATE_UNPLAYABLE_ROOM_MAX = ADVANCE_UNPLAYABLE_ROOM_MAX;
export const ADVANCE_RATE_TOTAL_ROOM_MAX = ADVANCE_TOTAL_ROOM_MAX;
export const ADVANCE_RATE_WINDOW_MS = ADVANCE_WINDOW_MS;

/** Test helper — clear rate-limit state. */
export function _resetAdvanceRateLimit(): void {
  hits.clear();
}
