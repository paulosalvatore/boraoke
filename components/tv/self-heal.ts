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
