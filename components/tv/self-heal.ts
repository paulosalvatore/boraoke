/**
 * TICKET-46 — Kiosk-TV screen-token self-heal: pure decision logic.
 *
 * WHY: the `/[room]/tv` server page mints an HMAC screen token at page-load
 * (`mintScreenToken`, force-dynamic) and hands it to `TvScreen` as a static
 * prop. A venue kiosk commonly runs for DAYS without a reload, but the token is
 * valid only for its 24h bucket plus the previous one (`SCREEN_TOKEN_BUCKET_MS`
 * in lib/screen-token.ts) — i.e. ≤48h effective. Under `ADVANCE_AUTH=enforce`,
 * once the token ages out `/api/queue/advance` returns 401, `advance()` swallows
 * it, and the queue wedges silently. This module holds every self-heal DECISION
 * as pure functions (no React, no DOM, no timers) so the whole contract is
 * unit-testable in isolation. `TvScreen` wires the decisions to the real page
 * (`window.location.reload()` + a `sessionStorage` debounce marker).
 *
 * Two layers, both decided here:
 *  1. Proactive — reload when the token is OLD *and* the player is IDLE, well
 *     before the 48h expiry, so a reload always lands on a fresh token without
 *     ever cutting off a singer mid-song.
 *  2. Reactive backstop — on a 401 from advance, reload once, debounced by a
 *     sessionStorage timestamp so a genuinely bad config never hot-loops.
 *
 * Behavior-neutral in log mode (current prod default): in log mode advance never
 * 401s, so Layer 2 stays dormant, and Layer 1's only effect is an occasional
 * idle reload of a >20h-old page — a no-op for the singer, a fresh token for the
 * page. No behavior change for the current production default.
 */

/**
 * Proactive self-heal threshold. Chosen comfortably inside the FIRST 24h bucket
 * (`SCREEN_TOKEN_BUCKET_MS`) so a reload at this age always re-mints a token in
 * the current bucket — never one already in its grace/previous-bucket tail. 20h
 * leaves a 4h idle-window margin before the bucket rolls and a full ~28h before
 * the ≤48h hard expiry, which any venue reaches idle-between-songs long before.
 */
export const SELF_HEAL_TOKEN_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/**
 * Minimum spacing between reactive (401) self-heal reloads. A genuinely bad
 * config (e.g. the room secret rotated so every fresh token 401s) must NOT
 * hot-loop the page: after one reload attempt inside this window, stop and fail
 * quietly (the pre-existing silent behavior) rather than spin. 5 minutes.
 */
export const SELF_HEAL_RELOAD_DEBOUNCE_MS = 5 * 60 * 1000;

/** Inputs to the proactive reload decision (Layer 1). */
export interface ProactiveSelfHealInput {
  /** Age of the current screen token in ms (now - screenTokenMintedAt). */
  tokenAgeMs: number;
  /** True when a song is currently playing (reload would cut off the singer). */
  isPlaying: boolean;
}

/**
 * Layer 1 decision: should the TV proactively reload to re-mint a fresh token?
 *
 * Reload only when the token is OLD (past the safe threshold) AND the player is
 * IDLE. Reloading while idle re-mints via the force-dynamic page without
 * interrupting anyone's song; a reload mid-playback would cut off the current
 * singer, so an old-but-playing page waits for the next idle window (a busy
 * venue naturally reaches idle between songs long before the 48h expiry).
 *
 * NOTE (TICKET-62): this predicate is intentionally UNCLAMPED and unguarded —
 * it answers only "is the token old and the player idle?". It must never be
 * called on its own from the page: `tokenAgeMs` is `Date.now() - mintedAt`, so a
 * kiosk whose browser clock runs >20h AHEAD of the server computes a bogus old
 * age that a reload cannot cure (the re-minted token reads as old again), and an
 * unguarded caller would reload on every check forever. Callers go through
 * `shouldSelfHealReload`, whose sessionStorage debounce guards BOTH layers.
 */
export function shouldProactivelyReload({
  tokenAgeMs,
  isPlaying,
}: ProactiveSelfHealInput): boolean {
  if (isPlaying) return false; // never reload mid-song
  return tokenAgeMs >= SELF_HEAL_TOKEN_MAX_AGE_MS;
}

/** Inputs to the reactive (401) reload decision (Layer 2). */
export interface ReactiveSelfHealInput {
  /**
   * Timestamp (ms) of the last self-heal reload attempt, or null if none this
   * session. Read from the sessionStorage one-shot marker by `TvScreen`.
   */
  lastReloadAt: number | null;
  /** Current time (ms). */
  now: number;
}

/**
 * Layer 2 decision: on a 401 from advance, should the page reload now?
 *
 * Debounced: reload at most once per `SELF_HEAL_RELOAD_DEBOUNCE_MS`. If the last
 * attempt was within the window, do NOT reload — fail quietly so a bad config
 * (every fresh token still 401s) can never storm the page with reloads.
 */
export function shouldReactivelyReload({
  lastReloadAt,
  now,
}: ReactiveSelfHealInput): boolean {
  if (lastReloadAt === null) return true; // first 401 this session — heal
  return now - lastReloadAt >= SELF_HEAL_RELOAD_DEBOUNCE_MS;
}

/**
 * Combined self-heal decision, kept for a single testable surface matching the
 * ticket's suggested signature. `trigger` is `"reload"` when the page should
 * reload, `"none"` otherwise. Proactive and reactive checks are OR'd: a 401
 * backstop (reactive) OR an old-and-idle page (proactive) both heal, and the
 * reactive debounce always applies so neither path can storm.
 */
export interface SelfHealInput {
  /** Age of the current screen token in ms. */
  tokenAgeMs: number;
  /** True when a song is currently playing. */
  isPlaying: boolean;
  /** Timestamp (ms) of the last self-heal reload, or null. */
  lastReloadAt: number | null;
  /** Current time (ms). */
  now: number;
  /**
   * True when this decision was triggered by a 401 from advance (reactive
   * backstop). When false, only the proactive old-and-idle path can fire.
   */
  got401?: boolean;
}

export function shouldSelfHealReload({
  tokenAgeMs,
  isPlaying,
  lastReloadAt,
  now,
  got401 = false,
}: SelfHealInput): boolean {
  // The reactive debounce guards BOTH paths so nothing can storm the page.
  if (!shouldReactivelyReload({ lastReloadAt, now })) return false;
  if (got401) return true; // reactive backstop: token rejected under enforce
  return shouldProactivelyReload({ tokenAgeMs, isPlaying });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * TICKET-62 — queue-poll if-changed diff.
 *
 * Lives here (rather than in TvScreen) for the same reason the self-heal
 * decisions do: this is pure logic with no React/DOM dependency, so it is
 * unit-provable in the node-env jest project, whereas `TvScreen.tsx` is a
 * "use client" React component the suite cannot import.
 *
 * WHY: the TV polls `/api/queue` every 3s and wrote the fetched items into
 * state unconditionally, so a kiosk re-rendered ~20x/min forever even with a
 * completely static queue. Skipping the state write when nothing changed is a
 * pure render optimization — but ONLY if the comparison is exactly right. A
 * comparison that misses a real change would freeze the TV on a stale queue,
 * which is far worse than the churn being fixed. So the rule for everything
 * below is: **when in doubt, report "not equal"** (a false "changed" costs one
 * needless re-render; a false "unchanged" wedges the screen).
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * True when `value` is a plain JSON-ish object (`{...}` from a literal or from
 * `JSON.parse`) — NOT an array, not `null`, and not a class instance such as
 * `Date`/`Map`/`Set`. Only plain objects are compared structurally; anything
 * exotic falls back to identity, because walking own-enumerable keys of a
 * `Date` (which has none) would call two different dates equal.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Structural deep equality for JSON-shaped values (the exact shape a
 * `/api/queue` response can produce: primitives, plain objects, arrays).
 *
 * Deliberately generic rather than a hand-written field-by-field `QueueEntry`
 * comparison: a field-list compare silently stops seeing any field added to the
 * entry shape later, which is precisely the freeze-on-stale-queue failure. A
 * structural walk keeps working when the shape grows.
 *
 * Deliberately NOT `JSON.stringify(a) === JSON.stringify(b)`: stringify is key-
 * order sensitive and drops `undefined` values, so it is both noisier and — for
 * key-order-equal-but-undefined-differing objects — subtly wrong.
 *
 * Semantics chosen to fail toward "changed":
 * - `Object.is` fast path, so `NaN` equals `NaN` and `0`/`-0` count as changed.
 * - Differing key SETS are unequal, so `{ title: undefined }` and `{}` are
 *   unequal (a field appearing/disappearing is a real change).
 * - Arrays are order-sensitive — a queue reorder IS a change.
 * - Mismatched kinds (array vs object vs primitive) are unequal.
 *
 * Inputs come from `JSON.parse`, so cycles are impossible and no depth guard is
 * needed.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualJson(a[i], b[i])) return false;
    }
    return true;
  }

  // Non-plain objects (Date, Map, class instances) and primitives: identity
  // only — already decided by the Object.is fast path above.
  if (!isPlainObject(a) || !isPlainObject(b)) return false;

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  // Both directions of key containment, not just a matching COUNT. Count +
  // one-way `hasOwnProperty` is sound only while `Object.keys` and
  // `hasOwnProperty` agree, which holds for JSON-parsed objects but is defeated
  // by a non-enumerable own property (equal counts, and b's extra enumerable
  // field never compared → a false "unchanged"). Unreachable from a JSON
  // payload, but the module's contract is fail-toward-changed REGARDLESS, and
  // closing it costs nothing.
  for (const key of bKeys) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) return false;
  }
  for (const key of aKeys) {
    // Own-key presence, not just an equal value: `{ x: undefined }` vs `{}`
    // have equal lookups but different shapes, and that is a change.
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqualJson(a[key], b[key])) return false;
  }
  return true;
}

/**
 * True when two fetched queue snapshots are identical, so the poll can skip the
 * `setQueue` write and avoid a re-render. Order-sensitive (a reorder is a real
 * change) and field-exact (any added/removed/changed field is a real change).
 */
export function queueItemsEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!deepEqualJson(a[i], b[i])) return false;
  }
  return true;
}
