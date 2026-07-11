/**
 * TICKET-46 — Kiosk-TV screen-token self-heal: pure decision tests.
 *
 * The self-heal DECISIONS (proactive old-and-idle reload, reactive 401 debounce)
 * live in a pure module with no React/DOM/timer dependency, so the whole
 * self-heal contract is provable here without a browser.
 */
import {
  shouldProactivelyReload,
  shouldReactivelyReload,
  shouldSelfHealReload,
  SELF_HEAL_TOKEN_MAX_AGE_MS,
  SELF_HEAL_RELOAD_DEBOUNCE_MS,
} from "@/components/tv/self-heal";

const HOUR = 60 * 60 * 1000;

describe("self-heal thresholds are in the ticket's sane ranges", () => {
  it("proactive threshold ~20h — inside the first 24h bucket", () => {
    expect(SELF_HEAL_TOKEN_MAX_AGE_MS).toBe(20 * HOUR);
    // Comfortably inside a bucket (24h) and well under the ≤48h hard expiry.
    expect(SELF_HEAL_TOKEN_MAX_AGE_MS).toBeLessThan(24 * HOUR);
    expect(SELF_HEAL_TOKEN_MAX_AGE_MS).toBeLessThan(48 * HOUR);
  });

  it("reactive debounce ≥5min — no reload storm", () => {
    expect(SELF_HEAL_RELOAD_DEBOUNCE_MS).toBe(5 * 60 * 1000);
    expect(SELF_HEAL_RELOAD_DEBOUNCE_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });
});

describe("shouldProactivelyReload — Layer 1 (old AND idle)", () => {
  it("(a) old token + idle → reload", () => {
    expect(
      shouldProactivelyReload({ tokenAgeMs: 21 * HOUR, isPlaying: false })
    ).toBe(true);
  });

  it("(b) old token + playing → NO reload (never cut off a singer)", () => {
    expect(
      shouldProactivelyReload({ tokenAgeMs: 21 * HOUR, isPlaying: true })
    ).toBe(false);
  });

  it("(c) fresh token + idle → NO reload", () => {
    expect(
      shouldProactivelyReload({ tokenAgeMs: 2 * HOUR, isPlaying: false })
    ).toBe(false);
  });

  it("fresh token + playing → NO reload", () => {
    expect(
      shouldProactivelyReload({ tokenAgeMs: 2 * HOUR, isPlaying: true })
    ).toBe(false);
  });

  describe("(e) ~20h boundary", () => {
    it("just below threshold + idle → NO reload", () => {
      expect(
        shouldProactivelyReload({
          tokenAgeMs: SELF_HEAL_TOKEN_MAX_AGE_MS - 1,
          isPlaying: false,
        })
      ).toBe(false);
    });

    it("exactly at threshold + idle → reload", () => {
      expect(
        shouldProactivelyReload({
          tokenAgeMs: SELF_HEAL_TOKEN_MAX_AGE_MS,
          isPlaying: false,
        })
      ).toBe(true);
    });

    it("exactly at threshold + playing → NO reload", () => {
      expect(
        shouldProactivelyReload({
          tokenAgeMs: SELF_HEAL_TOKEN_MAX_AGE_MS,
          isPlaying: true,
        })
      ).toBe(false);
    });
  });
});

describe("shouldReactivelyReload — Layer 2 (401 debounce)", () => {
  it("(d) first 401 this session (no marker) → reload", () => {
    expect(shouldReactivelyReload({ lastReloadAt: null, now: 10_000 })).toBe(true);
  });

  it("(d) a second 401 inside the debounce window → NO reload (no storm)", () => {
    const lastReloadAt = 1_000_000;
    const now = lastReloadAt + SELF_HEAL_RELOAD_DEBOUNCE_MS - 1;
    expect(shouldReactivelyReload({ lastReloadAt, now })).toBe(false);
  });

  it("a 401 after the debounce window elapses → reload again", () => {
    const lastReloadAt = 1_000_000;
    const now = lastReloadAt + SELF_HEAL_RELOAD_DEBOUNCE_MS;
    expect(shouldReactivelyReload({ lastReloadAt, now })).toBe(true);
  });

  it("bad config storm: repeated 401s inside one window never reload twice", () => {
    const lastReloadAt = 5_000_000;
    // Simulate advance 401s every 3s for the whole 5-min window: none reload.
    for (let now = lastReloadAt + 3_000; now < lastReloadAt + SELF_HEAL_RELOAD_DEBOUNCE_MS; now += 3_000) {
      expect(shouldReactivelyReload({ lastReloadAt, now })).toBe(false);
    }
  });
});

describe("shouldSelfHealReload — combined surface", () => {
  const base = {
    tokenAgeMs: 0,
    isPlaying: false,
    lastReloadAt: null as number | null,
    now: 0,
  };

  it("401 backstop reloads even on a fresh token (when not debounced)", () => {
    expect(shouldSelfHealReload({ ...base, got401: true })).toBe(true);
  });

  it("401 backstop is suppressed inside the debounce window", () => {
    const lastReloadAt = 1_000_000;
    expect(
      shouldSelfHealReload({
        ...base,
        got401: true,
        lastReloadAt,
        now: lastReloadAt + 1,
      })
    ).toBe(false);
  });

  it("no 401: proactive path fires on old + idle", () => {
    expect(
      shouldSelfHealReload({ ...base, tokenAgeMs: 21 * HOUR, isPlaying: false })
    ).toBe(true);
  });

  it("no 401: old + playing stays quiet", () => {
    expect(
      shouldSelfHealReload({ ...base, tokenAgeMs: 21 * HOUR, isPlaying: true })
    ).toBe(false);
  });

  it("no 401: fresh + idle stays quiet", () => {
    expect(
      shouldSelfHealReload({ ...base, tokenAgeMs: 2 * HOUR, isPlaying: false })
    ).toBe(false);
  });

  it("the reactive debounce also guards the proactive path (no storm on old+idle)", () => {
    const lastReloadAt = 2_000_000;
    expect(
      shouldSelfHealReload({
        tokenAgeMs: 30 * HOUR,
        isPlaying: false,
        lastReloadAt,
        now: lastReloadAt + 1,
      })
    ).toBe(false);
  });
});
