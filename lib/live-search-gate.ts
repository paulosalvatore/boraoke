/**
 * Server-side gate for BILLED live searches (the platform's 100 daily
 * `search.list` calls).
 *
 * The client fires a billed search only on Enter, after an idle pause, or on a
 * deliberate tap ("load more", "search again"); every other as-you-type lookup
 * is index-only and free. The client is not trusted to keep that promise, so
 * the server enforces it in two layers:
 *
 *  1. `liveAllowed` — a first-page request may reach live search ONLY when it
 *     says so explicitly (`live=1`). Anything else is answered from the free
 *     tiers (cache, karaoke index) or gets `liveRequired`. Fail-closed: a naive
 *     or stale client that sends nothing never bills. A `pageToken` request is
 *     a deliberate "load more" tap and is live-allowed by definition.
 *
 *  2. `liveCooldown` — a client that is modified to send `live=1` on every
 *     keystroke is still held to ONE billed attempt per LIVE_COOLDOWN_MS per
 *     uuid. Keystrokes arrive a few hundred ms apart, so per-keystroke billing
 *     is impossible for one uuid. Rotating uuids is bounded by the existing
 *     per-IP rate bucket and, across instances, by the platform's daily budget
 *     (lib/search-budget.ts), which remains the hard cap.
 *
 * The cooldown is per instance and in memory, like the rate limiter in
 * lib/youtube-search.ts: it is a demand shaper, not the budget's guarantee.
 */

/** Parse the request's explicit live permission. */
export function liveAllowed(params: URLSearchParams, pageToken: string): boolean {
  if (pageToken !== "") return true;
  return params.get("live") === "1";
}

/**
 * Minimum spacing between two billed attempts from one uuid. An honest client
 * never comes close: the idle search waits several seconds after the last
 * keystroke and fires once per text, and a second Enter inside 2 s is answered
 * with `retryAfterMs`, which the client honours once.
 */
export const LIVE_COOLDOWN_MS = 2000;
const GATE_MAX_KEYS = 2000; // uuid keys are client-minted: cap the map (LRU)

const lastBilled = new Map<string, number>();

export type CooldownResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Check-and-record one billed attempt for `uuid`. Records only when allowed,
 * so a client hammering inside the window cannot extend its own lockout
 * indefinitely, and cannot shorten it either.
 */
export function liveCooldown(uuid: string, now = Date.now()): CooldownResult {
  const last = lastBilled.get(uuid);
  if (last !== undefined && now - last < LIVE_COOLDOWN_MS) {
    return { ok: false, retryAfterMs: LIVE_COOLDOWN_MS - (now - last) };
  }
  lastBilled.delete(uuid); // LRU touch: re-insert at the tail
  lastBilled.set(uuid, now);
  while (lastBilled.size > GATE_MAX_KEYS) {
    const oldest = lastBilled.keys().next().value;
    if (oldest === undefined) break;
    lastBilled.delete(oldest);
  }
  return { ok: true };
}

/** Test helper — clear the cooldown state. */
export function _resetLiveGate(): void {
  lastBilled.clear();
}
