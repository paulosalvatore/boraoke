/**
 * TICKET-103 — the TV focus state's pure decisions.
 *
 * Jest here is node-env only (no jsdom), so the React surface is not testable in
 * this suite by design. What IS testable — and what actually carries the risk —
 * is the decision layer in `components/tv/focus-state.ts`: when the focus state
 * is active, whether the periodic up-next peek runs at all, and the timing of
 * each step of its cycle. The visual result is proven by Playwright and by the
 * committed 1080p screenshots.
 *
 * Weighted toward the failure modes the ticket names explicitly:
 *  - an overlay that is PERMANENTLY on screen (item 4 rules that out), and
 *  - an overlay that flashes with nothing in it (the "looks like a glitch" case).
 * Both are reachable through the timings, so both get direct assertions rather
 * than being left implied by a happy-path test.
 */
import {
  focusModeActive,
  shouldRunQueuePeek,
  nextQueuePeekStep,
  QUEUE_PEEK_LEAD_IN_MS,
  QUEUE_PEEK_PERIOD_MS,
  QUEUE_PEEK_VISIBLE_MS,
} from "@/components/tv/focus-state";

describe("focusModeActive", () => {
  it("is active exactly when the chrome has idled away AND a song is playing", () => {
    expect(focusModeActive({ chromeVisible: false, hasNowPlaying: true })).toBe(true);
  });

  it("is NOT active while the chrome is still showing — activity means the venue is interacting", () => {
    expect(focusModeActive({ chromeVisible: true, hasNowPlaying: true })).toBe(false);
  });

  it("is NOT active on an empty queue, even when idle — the idle poster owns that screen", () => {
    // Regression guard with teeth: collapsing `.meta` and enlarging a STOPPED,
    // parked player over the recruitment poster would replace a working big-QR
    // poster with a black rectangle. The gate is the `hasNowPlaying` conjunct.
    expect(focusModeActive({ chromeVisible: false, hasNowPlaying: false })).toBe(false);
    expect(focusModeActive({ chromeVisible: true, hasNowPlaying: false })).toBe(false);
  });
});

describe("shouldRunQueuePeek", () => {
  it("runs inside the focus state when there is something up next", () => {
    expect(shouldRunQueuePeek({ focusActive: true, upcomingCount: 1 })).toBe(true);
    expect(shouldRunQueuePeek({ focusActive: true, upcomingCount: 3 })).toBe(true);
  });

  it("does NOT run outside the focus state — the rail is already on screen there", () => {
    expect(shouldRunQueuePeek({ focusActive: false, upcomingCount: 3 })).toBe(false);
  });

  it("does NOT run with an empty up-next list — never flash an empty overlay", () => {
    // The ticket's "should look intentional" requirement, as an assertion: a
    // periodic reveal of nothing is indistinguishable from a rendering glitch.
    expect(shouldRunQueuePeek({ focusActive: true, upcomingCount: 0 })).toBe(false);
  });
});

describe("nextQueuePeekStep", () => {
  it("first transition after entering focus reveals on the SHORT lead-in, not the full period", () => {
    expect(nextQueuePeekStep({ visible: false, first: true })).toEqual({
      nextVisible: true,
      delayMs: QUEUE_PEEK_LEAD_IN_MS,
    });
    // And the lead-in really is shorter than a full cycle — otherwise the venue
    // watches the UI clear away and then sees nothing happen for half a minute.
    expect(QUEUE_PEEK_LEAD_IN_MS).toBeLessThan(QUEUE_PEEK_PERIOD_MS - QUEUE_PEEK_VISIBLE_MS);
  });

  it("a revealed overlay always schedules its own HIDE — it can never stick", () => {
    expect(nextQueuePeekStep({ visible: true, first: true })).toEqual({
      nextVisible: false,
      delayMs: QUEUE_PEEK_VISIBLE_MS,
    });
    expect(nextQueuePeekStep({ visible: true, first: false })).toEqual({
      nextVisible: false,
      delayMs: QUEUE_PEEK_VISIBLE_MS,
    });
  });

  it("later reveals wait out the REMAINDER of the period, so reveal-to-reveal spacing is exactly the period", () => {
    const hide = nextQueuePeekStep({ visible: true, first: false });
    const reveal = nextQueuePeekStep({ visible: false, first: false });
    expect(reveal).toEqual({
      nextVisible: true,
      delayMs: QUEUE_PEEK_PERIOD_MS - QUEUE_PEEK_VISIBLE_MS,
    });
    // The property that actually matters, asserted as a property rather than as
    // two magic numbers: one full round trip == one period.
    expect(hide.delayMs + reveal.delayMs).toBe(QUEUE_PEEK_PERIOD_MS);
  });

  it("walks a full cycle: hidden -> revealed -> hidden -> revealed, alternating", () => {
    let visible = false;
    let first = true;
    const seen: Array<{ visible: boolean; delayMs: number }> = [];
    for (let i = 0; i < 4; i++) {
      const step = nextQueuePeekStep({ visible, first }, { periodMs: 1000, visibleMs: 200, leadInMs: 50 });
      first = false;
      visible = step.nextVisible;
      seen.push({ visible, delayMs: step.delayMs });
    }
    expect(seen).toEqual([
      { visible: true, delayMs: 50 },
      { visible: false, delayMs: 200 },
      { visible: true, delayMs: 800 },
      { visible: false, delayMs: 200 },
    ]);
  });

  it("honours caller-supplied timings (the e2e suite drives its own cycle length)", () => {
    expect(
      nextQueuePeekStep({ visible: false, first: false }, { periodMs: 900, visibleMs: 300 })
    ).toEqual({ nextVisible: true, delayMs: 600 });
  });

  it("clamps a visible window that meets or exceeds the period — the hidden window can never collapse", () => {
    // Without the clamp this returns delayMs <= 0: a zero-delay timer loop and an
    // overlay that is effectively permanent. That is the exact outcome item 4
    // forbids ("not permanently on screen"), so it is asserted, not assumed.
    const equal = nextQueuePeekStep({ visible: false, first: false }, { periodMs: 1000, visibleMs: 1000 });
    expect(equal.delayMs).toBeGreaterThan(0);
    expect(equal).toEqual({ nextVisible: true, delayMs: 500 });

    const over = nextQueuePeekStep({ visible: false, first: false }, { periodMs: 1000, visibleMs: 4000 });
    expect(over.delayMs).toBeGreaterThan(0);
    expect(over).toEqual({ nextVisible: true, delayMs: 500 });

    // The clamp must apply to the HIDE step too, or the overlay stays revealed
    // for the caller's oversized window and the cycle is period-long-visible.
    const hide = nextQueuePeekStep({ visible: true, first: false }, { periodMs: 1000, visibleMs: 4000 });
    expect(hide).toEqual({ nextVisible: false, delayMs: 500 });
  });

  it("production constants themselves satisfy the never-permanent invariant", () => {
    // Guards the constants, not just the function: a later edit that bumps
    // QUEUE_PEEK_VISIBLE_MS past the period would silently make the overlay
    // permanent in production while every timings-injected test above stayed
    // green.
    expect(QUEUE_PEEK_VISIBLE_MS).toBeGreaterThan(0);
    expect(QUEUE_PEEK_VISIBLE_MS).toBeLessThan(QUEUE_PEEK_PERIOD_MS);
    const reveal = nextQueuePeekStep({ visible: false, first: false });
    expect(reveal.delayMs).toBeGreaterThan(0);
  });
});
