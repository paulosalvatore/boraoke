/**
 * When the patron's search may spend a BILLED live call.
 *
 * Free lookups (cache + karaoke index) run as the patron types. A billed live
 * search runs only when the patron asks for it (Enter / the phone keyboard's
 * search key) or after they stop typing for IDLE_SEARCH_MS, and then only
 * once per query text. This module holds that rule as plain logic with
 * injectable timers, so it is unit-tested without a browser; SongSearch only
 * wires events into it.
 */

/**
 * Idle delay before a live search fires on its own.
 *
 * Chosen from the TL's 3-5 s range on the replay of the production typing
 * traces (`npm run measure:t125`, work/measurements/ticket-125/RESULTS.txt).
 * The traces carry no timestamps, so the replay states a pause model and
 * sweeps it: every intermediate prefix that production billed was a pause of
 * at least 400 ms, and the question is what share of those pauses also lasts
 * N seconds (a patron recalling a spelling, glancing at the stage, taking a
 * sip) and would wrongly fire mid-title.
 *   - Under the stated model (pause lengths log-normal, median 1 s, sigma 1,
 *     conditioned on >= 0.4 s) 17% of mid-title pauses reach 3 s, 10% reach
 *     4 s and 7% reach 5 s. Billed calls per queued song: 0.91 at 3 s, 0.89
 *     at 4 s, 0.87 at 5 s (PR #88's every-pause client: 1.22; the Enter-only
 *     floor: 0.84). hit@10 is 25/28 at every value.
 *   - So the choice is decided by the patron, not the bill: 4 s gives up
 *     0.02 calls/song against 5 s, and 5 s makes a patron who never presses
 *     Enter (hint not read, a keyboard without a visible search key) wait
 *     noticeably long; 3 s fires on ~1.6x as many mid-title thinking pauses
 *     (recalling a spelling, glancing at the stage) as 4 s, and in a bar
 *     those pauses are plausibly longer than at a desk (assumed, unmeasured).
 *   - A wasted call costs 1% of the platform's daily search budget, shared by
 *     every venue; 4 s instead of 3 s costs a patron who did not press Enter
 *     one second, once per song.
 */
export const IDLE_SEARCH_MS = 4000;

/** The keyboard event fields this module reads (React and DOM both fit). */
export interface KeyLike {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * Is this key press the patron asking to search now? Enter, or the phone
 * keyboard's search/go key (which also arrives as "Enter" with
 * enterKeyHint="search"). Not while an IME composition is open: there Enter
 * confirms the composed text (keyCode 229 covers older Safari).
 */
export function isSearchKey(e: KeyLike): boolean {
  if (e.key !== "Enter") return false;
  if (e.isComposing || e.keyCode === 229) return false;
  return true;
}

type Timer = ReturnType<typeof setTimeout>;

export interface TriggerOptions {
  /** Fire one live-allowed search for `text`. */
  fire: (text: string) => void;
  idleMs?: number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (t: Timer) => void;
}

/**
 * The billed-search trigger for one search box.
 *
 * Lifecycle per query text:
 *   edited(text)       the input changed to `text` and needs a server answer;
 *                      arms the idle timer.
 *   indexMissed(text)  the free tiers had no answer for `text`; the idle
 *                      search may fire (now, if the idle deadline already
 *                      passed while the lookup was in flight).
 *   indexAnswered(text) the free tiers answered `text`; no idle search.
 *   enter(text)        the patron pressed Enter: fire now.
 *   cancel()           the input no longer wants a search (empty, a pasted
 *                      link, too short, or answered locally).
 *
 * "Once": the idle search never fires twice for the same text in the same
 * mode (setScope). A new idle
 * period after an edit to different text may fire again.
 */
export class LiveSearchTrigger {
  private readonly fireFn: (text: string) => void;
  private readonly idleMs: number;
  private readonly schedule: (fn: () => void, ms: number) => Timer;
  private readonly cancelFn: (t: Timer) => void;

  private timer: Timer | null = null;
  /** The text the current idle period belongs to. */
  private pending = "";
  /** The idle deadline for `pending` has passed. */
  private idleElapsed = false;
  /** The free tiers missed for `pending`. */
  private missed = false;
  /** Scope (the search mode) + text of the last live search fired. */
  private lastFired = "";
  /** The current search mode: the same text in another mode is a new search. */
  private scope = "";

  constructor(opts: TriggerOptions) {
    this.fireFn = opts.fire;
    this.idleMs = opts.idleMs ?? IDLE_SEARCH_MS;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelFn = opts.cancel ?? ((t) => clearTimeout(t));
  }

  /**
   * The search mode changed. Fires nothing (a mode flip never searches,
   * TICKET-83); it only means the same text in the new mode has not been
   * searched live yet, so Enter / idle may fire for it.
   */
  setScope(scope: string): void {
    this.scope = scope;
  }

  private keyOf(text: string): string {
    return `${this.scope}\u0000${text}`;
  }

  edited(text: string): void {
    this.clearTimer();
    this.pending = text;
    this.idleElapsed = false;
    this.missed = false;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.idleElapsed = true;
      this.maybeFire();
    }, this.idleMs);
  }

  indexMissed(text: string): void {
    if (text !== this.pending) return; // a stale response for older text
    this.missed = true;
    this.maybeFire();
  }

  indexAnswered(text: string): void {
    if (text !== this.pending) return;
    this.cancel();
  }

  /** Enter: fire immediately unless this exact text was already fired. */
  enter(text: string): boolean {
    this.clearTimer();
    this.pending = text;
    this.idleElapsed = false;
    this.missed = false;
    if (!text || this.keyOf(text) === this.lastFired) return false;
    this.lastFired = this.keyOf(text);
    this.fireFn(text);
    return true;
  }

  /** Forget the once-guard (e.g. after a failed live search, so Enter can retry). */
  allowRetry(text: string): void {
    if (this.lastFired === this.keyOf(text)) this.lastFired = "";
  }

  cancel(): void {
    this.clearTimer();
    this.pending = "";
    this.idleElapsed = false;
    this.missed = false;
  }

  private maybeFire(): void {
    if (!this.idleElapsed || !this.missed) return;
    const text = this.pending;
    if (!text || this.keyOf(text) === this.lastFired) return;
    this.lastFired = this.keyOf(text);
    this.fireFn(text);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.cancelFn(this.timer);
      this.timer = null;
    }
  }
}
