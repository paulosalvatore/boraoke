/**
 * TICKET-103 — the TV "focus state": pure decision logic.
 *
 * WHY THIS MODULE EXISTS (the product finding, worth keeping next to the code):
 *
 * The Tech Lead reported liking a state where "the screen goes black with only
 * the video playing", and reported that the join QR disappeared in it. Step 0
 * measurement (work/reports/testing/TICKET-103-test-report.md) established that
 * the state he liked was an ACCIDENT: `fs: 0` removes YouTube's fullscreen
 * BUTTON but not its keyboard shortcut, so a click inside the iframe followed by
 * `F` makes the IFRAME the fullscreen element. The video then fills the whole
 * viewport and nothing of ours composites at all — which is simultaneously why
 * he liked it (big video, no clutter) and why the QR vanished (a DOM overlay on
 * top of a fullscreen cross-origin iframe is not possible, not merely hard).
 *
 * So the fix is not to restore the QR inside that state — it cannot be done.
 * It is to make an equivalent-looking state OURS, inside our own DOM, where the
 * QR and the up-next overlay still paint. Two consequences shape this module:
 *
 *  1. The focus state is entered on the SAME idle signal the venue already
 *     experiences — the `CHROME_HIDE_MS` window in TvScreen. Remote/pointer
 *     activity brings the full UI back, which is exactly the cycle he described
 *     ("used the remote, UI showed, then black again"). No second idle concept.
 *  2. It is a CSS class, never a `requestFullscreen()` call. Re-entering
 *     fullscreen requires a user gesture, and the one path that lands us here
 *     without a gesture is precisely the accidental iframe-fullscreen we are
 *     redirecting AWAY from. A fix that silently no-ops in the field is worse
 *     than no fix (the same reasoning TICKET-89 recorded for its exit-only
 *     posture); a class change always works.
 *
 * Jest on this repo is node-env only (no jsdom), so every DECISION lives here as
 * a pure function and TvScreen only wires it to timers and classes. Visual
 * behaviour is proven by Playwright + committed screenshots instead.
 */

/**
 * Lead-in before the FIRST up-next peek after entering the focus state.
 *
 * Deliberately short: the venue has just watched the UI clear away, and a first
 * reveal a few seconds later reads as "the screen is doing something on purpose"
 * rather than as a glitch that happened once, half a minute ago, when nobody was
 * looking. Subsequent reveals use the full period.
 */
export const QUEUE_PEEK_LEAD_IN_MS = 3000;

/** Full reveal-to-reveal cycle length once the lead-in has passed. */
export const QUEUE_PEEK_PERIOD_MS = 30_000;

/** How long the up-next cards stay revealed on each cycle. */
export const QUEUE_PEEK_VISIBLE_MS = 6000;

/**
 * Is the app-owned focus state active?
 *
 * `chromeVisible` is TvScreen's existing idle signal (false == no pointer/remote
 * activity for `CHROME_HIDE_MS`). The focus state deliberately rides on it so
 * there is ONE idle notion on this surface rather than two that can disagree.
 *
 * Gated on a song actually playing: with an empty queue the screen is already
 * the full-bleed recruitment poster, whose whole job is the big QR. Collapsing
 * the meta panel and enlarging a parked, stopped player there would replace a
 * working poster with a black rectangle.
 */
export function focusModeActive(input: {
  chromeVisible: boolean;
  hasNowPlaying: boolean;
}): boolean {
  return !input.chromeVisible && input.hasNowPlaying;
}

/**
 * Should the periodic up-next peek cycle run at all?
 *
 * Only inside the focus state (outside it the rail is permanently on screen, so
 * a "reveal" would be meaningless), and only when there is something to reveal —
 * flashing an empty overlay every 30s is the "looks like a glitch" failure the
 * ticket explicitly asks us to avoid.
 */
export function shouldRunQueuePeek(input: {
  focusActive: boolean;
  upcomingCount: number;
}): boolean {
  return input.focusActive && input.upcomingCount > 0;
}

/** Overridable timings — tests pass their own; production uses the constants. */
export interface QueuePeekTimings {
  leadInMs?: number;
  periodMs?: number;
  visibleMs?: number;
}

/**
 * One step of the peek cycle: "after `delayMs`, visibility becomes
 * `nextVisible`".
 *
 * Expressed as a next-transition rather than as a tick on purpose. A ticking
 * interval would re-render the TV several times a second forever on a kiosk;
 * this produces exactly TWO state writes per cycle. That matters beyond
 * efficiency: TICKET-62 made the 3s queue poll an if-changed write specifically
 * so a no-op poll does not re-render, and several timers now depend on that. A
 * self-scheduling two-step timer cannot defeat it (it never touches `queue`).
 *
 * @param state.visible current visibility
 * @param state.first   true only for the first transition after entering focus
 */
export function nextQueuePeekStep(
  state: { visible: boolean; first: boolean },
  timings: QueuePeekTimings = {}
): { nextVisible: boolean; delayMs: number } {
  const leadInMs = timings.leadInMs ?? QUEUE_PEEK_LEAD_IN_MS;
  const periodMs = timings.periodMs ?? QUEUE_PEEK_PERIOD_MS;
  const visibleMs = clampVisibleMs(timings.visibleMs ?? QUEUE_PEEK_VISIBLE_MS, periodMs);

  if (state.visible) {
    // Revealed → hide again after the visible window.
    return { nextVisible: false, delayMs: visibleMs };
  }
  // Hidden → reveal. The first reveal uses the short lead-in; every later one
  // waits out the remainder of the period, so reveal-to-reveal spacing is
  // exactly `periodMs` rather than `periodMs + visibleMs` (which would make the
  // observed cycle 20% longer than the constant says).
  return {
    nextVisible: true,
    delayMs: state.first ? leadInMs : periodMs - visibleMs,
  };
}

/**
 * Keep the visible window strictly shorter than the period.
 *
 * A caller passing `visibleMs >= periodMs` would otherwise produce a
 * `delayMs <= 0` hidden window — a permanently-revealed overlay (or a
 * zero-delay timer loop), i.e. exactly the "permanently on screen" outcome the
 * ticket rules out. Clamped to half the period: still obviously a reveal, and
 * the hidden window can never collapse to nothing.
 */
function clampVisibleMs(visibleMs: number, periodMs: number): number {
  if (!(visibleMs > 0)) return 0;
  return visibleMs < periodMs ? visibleMs : Math.floor(periodMs / 2);
}
