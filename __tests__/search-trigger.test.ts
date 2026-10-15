/**
 * The billed-search trigger: Enter fires now, otherwise ONE live search after
 * IDLE_SEARCH_MS of no typing, and only when the free tiers missed.
 */
import { IDLE_SEARCH_MS, isSearchKey, LiveSearchTrigger } from "@/lib/search-trigger";

let fired: string[];
let trigger: LiveSearchTrigger;

beforeEach(() => {
  jest.useFakeTimers();
  fired = [];
  trigger = new LiveSearchTrigger({ fire: (t) => fired.push(t) });
});
afterEach(() => jest.useRealTimers());

describe("IDLE_SEARCH_MS", () => {
  it("is inside the Tech Lead's 3-5 s range", () => {
    expect(IDLE_SEARCH_MS).toBeGreaterThanOrEqual(3000);
    expect(IDLE_SEARCH_MS).toBeLessThanOrEqual(5000);
  });
});

describe("idle auto-search", () => {
  it("fires ONE live search exactly IDLE_SEARCH_MS after the last edit, not before", () => {
    trigger.edited("bohemian");
    trigger.indexMissed("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS - 1);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(fired).toEqual(["bohemian"]);
  });

  it("every edit restarts the idle period", () => {
    trigger.edited("bohe");
    trigger.indexMissed("bohe");
    jest.advanceTimersByTime(IDLE_SEARCH_MS - 500);
    trigger.edited("bohem");
    trigger.indexMissed("bohem");
    jest.advanceTimersByTime(IDLE_SEARCH_MS - 500);
    expect(fired).toEqual([]);
    jest.advanceTimersByTime(500);
    expect(fired).toEqual(["bohem"]);
  });

  it("fires once: never again for the same text", () => {
    trigger.edited("bohemian");
    trigger.indexMissed("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 5);
    // the patron types and deletes a character, landing on the same text
    trigger.edited("bohemiann");
    trigger.edited("bohemian");
    trigger.indexMissed("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 5);
    expect(fired).toEqual(["bohemian"]);
  });

  it("a new idle period after an edit to different text may fire again", () => {
    trigger.edited("bohemian");
    trigger.indexMissed("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS);
    trigger.edited("bohemian rhap");
    trigger.indexMissed("bohemian rhap");
    jest.advanceTimersByTime(IDLE_SEARCH_MS);
    expect(fired).toEqual(["bohemian", "bohemian rhap"]);
  });

  it("never fires when the free tiers answered (index or cache hit)", () => {
    trigger.edited("evidencias");
    trigger.indexAnswered("evidencias");
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 3);
    expect(fired).toEqual([]);
  });

  it("never fires before the free tiers have answered", () => {
    trigger.edited("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 3);
    expect(fired).toEqual([]);
  });

  it("a late index miss (slow network) fires immediately if the idle period already passed", () => {
    trigger.edited("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS + 1500);
    expect(fired).toEqual([]);
    trigger.indexMissed("bohemian");
    expect(fired).toEqual(["bohemian"]);
  });

  it("ignores a stale miss for text the patron already edited away from", () => {
    trigger.edited("bohe");
    trigger.edited("bohem");
    trigger.indexMissed("bohe");
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 2);
    expect(fired).toEqual([]);
  });

  it("cancel() (empty / pasted link / too short / answered locally) disarms it", () => {
    trigger.edited("bohemian");
    trigger.indexMissed("bohemian");
    trigger.cancel();
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 3);
    expect(fired).toEqual([]);
  });
});

describe("Enter", () => {
  it("fires a live search immediately, with no wait", () => {
    trigger.edited("bohemian");
    expect(trigger.enter("bohemian")).toBe(true);
    expect(fired).toEqual(["bohemian"]);
  });

  it("cancels the pending idle search, so the text is billed once, not twice", () => {
    trigger.edited("bohemian");
    trigger.indexMissed("bohemian");
    trigger.enter("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 3);
    expect(fired).toEqual(["bohemian"]);
  });

  it("does not repeat a live search for text that was already searched live", () => {
    trigger.edited("bohemian");
    trigger.indexMissed("bohemian");
    jest.advanceTimersByTime(IDLE_SEARCH_MS);
    expect(trigger.enter("bohemian")).toBe(false);
    expect(fired).toEqual(["bohemian"]);
  });

  it("the once-guard is per mode: the same text in another mode may fire", () => {
    trigger.setScope("sing");
    trigger.enter("bohemian");
    trigger.setScope("listen-dance");
    expect(trigger.enter("bohemian")).toBe(true);
    // a second Enter in the same mode is still a repeat
    expect(trigger.enter("bohemian")).toBe(false);
    expect(fired).toEqual(["bohemian", "bohemian"]);
  });

  it("a mode change alone never fires anything (TICKET-83)", () => {
    trigger.edited("bohemian");
    trigger.setScope("listen-dance");
    jest.advanceTimersByTime(IDLE_SEARCH_MS * 3);
    expect(fired).toEqual([]);
  });

  it("can retry after a failed live search (allowRetry)", () => {
    trigger.enter("bohemian");
    trigger.allowRetry("bohemian");
    trigger.enter("bohemian");
    expect(fired).toEqual(["bohemian", "bohemian"]);
  });
});

describe("isSearchKey", () => {
  it("Enter (and the phone's search/go key, which arrives as Enter) is a search key", () => {
    expect(isSearchKey({ key: "Enter" })).toBe(true);
  });
  it("other keys are not", () => {
    for (const key of ["a", " ", "Tab", "Escape", "Backspace"]) expect(isSearchKey({ key })).toBe(false);
  });
  it("Enter during an IME composition only confirms the composed text", () => {
    expect(isSearchKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(isSearchKey({ key: "Enter", keyCode: 229 })).toBe(false);
  });
});
