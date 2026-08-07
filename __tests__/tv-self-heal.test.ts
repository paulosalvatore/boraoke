/**
 * Kiosk-TV `/tv` pure-logic tests — the decisions behind the unattended screen.
 *
 * TICKET-46: the self-heal DECISIONS (proactive old-and-idle reload, reactive
 * 401 debounce) live in a pure module with no React/DOM/timer dependency, so the
 * whole self-heal contract is provable here without a browser.
 *
 * TICKET-62: adds the Layer-1 clamp (a >20h-skewed kiosk clock must not
 * reload-loop), the marker-clear-on-success semantics, and the `setQueue`
 * if-changed comparator (`deepEqualJson` / `queueItemsEqual`) — which now makes
 * up roughly half this file. The comparator's tests are deliberately weighted
 * toward the NEGATIVE direction: a missed change freezes the TV on a stale
 * queue, which is far worse than the re-render churn it exists to avoid.
 */
import {
  shouldProactivelyReload,
  shouldReactivelyReload,
  shouldSelfHealReload,
  deepEqualJson,
  queueItemsEqual,
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

/* ───────────────────────── TICKET-62 — Layer 1 clamp ─────────────────────── */

describe("TICKET-62: Layer 1 proactive path is clamped by the shared marker", () => {
  /**
   * The kiosk-clock-skew case. `tokenAgeMs` is computed client-side as
   * `Date.now() - screenTokenMintedAt`, so a browser clock running >20h AHEAD of
   * the Vercel server reports a permanently-bogus "old" token that a reload
   * cannot cure: the re-minted token is stamped with the server's clock and
   * reads as 20h+ old again the moment the page comes back.
   *
   * `shouldProactivelyReload` alone therefore says "reload" forever — which is
   * exactly why TvScreen must not call it raw. Routed through
   * `shouldSelfHealReload`, the sessionStorage marker bounds it.
   */
  const SKEW = 26 * HOUR; // browser clock 26h ahead of the server

  it("the raw predicate would loop forever under a >20h-ahead clock", () => {
    // Every 60s check across an hour still says "reload" — no self-limiting.
    for (let i = 0; i < 60; i += 1) {
      expect(
        shouldProactivelyReload({ tokenAgeMs: SKEW, isPlaying: false })
      ).toBe(true);
    }
  });

  it("routed through shouldSelfHealReload, the first check heals once", () => {
    expect(
      shouldSelfHealReload({
        tokenAgeMs: SKEW,
        isPlaying: false,
        lastReloadAt: null,
        now: 1_000_000,
      })
    ).toBe(true);
  });

  it("and every subsequent 60s check inside the window is suppressed", () => {
    const lastReloadAt = 1_000_000;
    // The Layer 1 effect re-checks every 60s; walk the whole debounce window.
    let checks = 0;
    for (
      let now = lastReloadAt + 60_000;
      now < lastReloadAt + SELF_HEAL_RELOAD_DEBOUNCE_MS;
      now += 60_000
    ) {
      checks += 1;
      expect(
        shouldSelfHealReload({
          tokenAgeMs: SKEW + (now - lastReloadAt),
          isPlaying: false,
          lastReloadAt,
          now,
        })
      ).toBe(false);
    }
    expect(checks).toBeGreaterThan(0); // the loop actually ran
  });

  it("a >20h-BEHIND clock (negative age) never reloads at all", () => {
    // The mirror-image skew: `Date.now() - mintedAt` goes negative. Already
    // inert via the `>=` threshold — asserted so a future refactor to, say, an
    // absolute-value age cannot silently reintroduce a reload here.
    expect(
      shouldProactivelyReload({ tokenAgeMs: -26 * HOUR, isPlaying: false })
    ).toBe(false);
    expect(
      shouldSelfHealReload({
        tokenAgeMs: -26 * HOUR,
        isPlaying: false,
        lastReloadAt: null,
        now: 1_000_000,
      })
    ).toBe(false);
  });

  it("the healthy ~20h cadence is NOT suppressed by the marker", () => {
    // A legitimate proactive reload lands on a fresh token, so the next one is
    // ~20h later — far outside the 5-minute window. The clamp must not cost the
    // feature its actual job.
    const lastReloadAt = 1_000_000;
    expect(
      shouldSelfHealReload({
        tokenAgeMs: 20 * HOUR,
        isPlaying: false,
        lastReloadAt,
        now: lastReloadAt + 20 * HOUR,
      })
    ).toBe(true);
  });

  it("a skewed clock still never reloads mid-song", () => {
    expect(
      shouldSelfHealReload({
        tokenAgeMs: SKEW,
        isPlaying: true,
        lastReloadAt: null,
        now: 1_000_000,
      })
    ).toBe(false);
  });
});

/* ─────────────────── TICKET-62 — marker cleared on success ────────────────── */

describe("TICKET-62: clearing the marker after a successful advance", () => {
  /**
   * `TvScreen` removes the `boraoke-tv-selfheal-reload` sessionStorage key when
   * an advance returns 2xx — a success proves the current token is accepted, so
   * a stale marker must not keep suppressing the next genuine heal for the rest
   * of the kiosk session. The DOM write lives in the component; the DECISION
   * consequence is what matters and is provable here: a cleared marker reads
   * back as `lastReloadAt: null`.
   */
  it("a lingering marker suppresses the next 401 heal (the bug)", () => {
    const lastReloadAt = 1_000_000;
    expect(
      shouldSelfHealReload({
        tokenAgeMs: 0,
        isPlaying: false,
        got401: true,
        lastReloadAt,
        now: lastReloadAt + 60_000, // a minute later, still inside the window
      })
    ).toBe(false);
  });

  it("after the clear (marker absent → null), the same 401 heals immediately", () => {
    expect(
      shouldSelfHealReload({
        tokenAgeMs: 0,
        isPlaying: false,
        got401: true,
        lastReloadAt: null, // what a cleared key reads back as
        now: 1_060_000,
      })
    ).toBe(true);
  });

  it("clearing does not re-open the storm: the next attempt re-arms the marker", () => {
    // heal → marker set at T → suppressed until T+5min, exactly as before.
    const T = 1_060_000;
    expect(
      shouldSelfHealReload({
        tokenAgeMs: 0,
        isPlaying: false,
        got401: true,
        lastReloadAt: T,
        now: T + 1,
      })
    ).toBe(false);
  });
});

/* ──────────────── TICKET-62 — setQueue if-changed deep equality ───────────── */

const entry = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  videoId: "abc123",
  title: "Evidências",
  nickname: "Ana",
  patronUuid: "uuid-1",
  table: "3",
  mode: "sing",
  submittedAt: "2026-08-05T20:00:00.000Z",
  ...over,
});

describe("queueItemsEqual — the NEGATIVE direction (must never miss a change)", () => {
  const base = [entry(), entry({ id: "e2", videoId: "def456", nickname: "Bruno" })];

  it("an ADDED entry is a change", () => {
    expect(queueItemsEqual(base, [...base, entry({ id: "e3" })])).toBe(false);
  });

  it("a REMOVED entry is a change", () => {
    expect(queueItemsEqual(base, [base[0]])).toBe(false);
  });

  it("a REORDER of the same entries is a change", () => {
    expect(queueItemsEqual(base, [base[1], base[0]])).toBe(false);
  });

  it("a head swap (now-playing changes) is a change", () => {
    expect(queueItemsEqual(base, [entry({ id: "e9" }), base[1]])).toBe(false);
  });

  // Every field of the real QueueEntry shape, one at a time.
  const singleFieldChanges: Array<[string, Record<string, unknown>]> = [
    ["id", { id: "other" }],
    ["videoId", { videoId: "zzz999" }],
    ["title", { title: "Outra música" }],
    ["nickname", { nickname: "Carla" }],
    ["patronUuid", { patronUuid: "uuid-2" }],
    ["table", { table: "7" }],
    ["mode (status change)", { mode: "listen-dance" }],
    ["submittedAt", { submittedAt: "2026-08-05T21:00:00.000Z" }],
    ["graceRequeue flipped on", { graceRequeue: true }],
  ];
  for (const [label, over] of singleFieldChanges) {
    it(`a changed ${label} field is a change`, () => {
      expect(queueItemsEqual([entry()], [entry(over)])).toBe(false);
    });
  }

  it("a graceRequeue flipped false→true is a change (falsy values count)", () => {
    expect(
      queueItemsEqual([entry({ graceRequeue: false })], [entry({ graceRequeue: true })])
    ).toBe(false);
  });

  it("an OPTIONAL field appearing is a change", () => {
    const without = entry();
    delete (without as Record<string, unknown>).table;
    expect(queueItemsEqual([without], [entry({ table: "3" })])).toBe(false);
  });

  it("an OPTIONAL field disappearing is a change", () => {
    const without = entry();
    delete (without as Record<string, unknown>).title;
    expect(queueItemsEqual([entry()], [without])).toBe(false);
  });

  it("an explicit-undefined field is NOT equal to a missing field", () => {
    // `{ title: undefined }` vs `{}` — equal by lookup, different by shape.
    expect(deepEqualJson({ title: undefined }, {})).toBe(false);
    expect(deepEqualJson({}, { title: undefined })).toBe(false);
  });

  it("a field the entry shape does not have YET is still compared", () => {
    // Guards the freeze-on-stale-queue failure mode: the comparison is
    // structural, so a field added to QueueEntry later is covered for free —
    // a hand-listed field compare would silently stop seeing it.
    expect(
      queueItemsEqual([entry()], [entry({ futureStatus: "playing" })])
    ).toBe(false);
    expect(
      queueItemsEqual(
        [entry({ futureStatus: "playing" })],
        [entry({ futureStatus: "paused" })]
      )
    ).toBe(false);
  });

  it("empty vs non-empty (queue drained / first submission) is a change", () => {
    expect(queueItemsEqual([], [entry()])).toBe(false);
    expect(queueItemsEqual([entry()], [])).toBe(false);
  });

  it("type-shifted values are a change (string '3' vs number 3, null vs absent)", () => {
    expect(queueItemsEqual([entry({ table: "3" })], [entry({ table: 3 })])).toBe(false);
    expect(deepEqualJson({ a: null }, { a: undefined })).toBe(false);
    expect(deepEqualJson({ a: null }, {})).toBe(false);
    expect(deepEqualJson(0, "0")).toBe(false);
    expect(deepEqualJson(false, 0)).toBe(false);
    expect(deepEqualJson(null, false)).toBe(false);
  });

  it("nested-object and nested-array changes are seen", () => {
    expect(deepEqualJson({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toBe(false);
    expect(deepEqualJson({ a: [1, 2, 3] }, { a: [1, 3, 2] })).toBe(false);
    expect(deepEqualJson({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(deepEqualJson([{ x: 1 }], [{ x: 1, y: 2 }])).toBe(false);
  });

  it("an array is never equal to a same-shaped object", () => {
    expect(deepEqualJson([], {})).toBe(false);
    expect(deepEqualJson({ 0: "a", length: 1 }, ["a"])).toBe(false);
  });

  it("a non-enumerable own property cannot mask an extra field", () => {
    // Key COUNT plus one-way hasOwnProperty would call these equal: both report
    // one enumerable key, `a`'s key exists on `b`, and `b.y` is never reached.
    // JSON.parse cannot build this, but the fail-toward-changed contract is
    // unconditional, so the comparison checks containment in both directions.
    const a = { x: 1 };
    const b: Record<string, unknown> = { y: 2 };
    Object.defineProperty(b, "x", { value: 1, enumerable: false });
    expect(deepEqualJson(a, b)).toBe(false);
    expect(deepEqualJson(b, a)).toBe(false);
  });

  it("non-plain objects fall back to identity (never falsely equal)", () => {
    // A Date has no own enumerable keys; a naive key-walk would call any two
    // dates equal. These cannot appear in a JSON queue payload, but the
    // fail-toward-changed guarantee must hold regardless.
    expect(deepEqualJson(new Date(0), new Date(1))).toBe(false);
    expect(deepEqualJson(new Date(0), new Date(0))).toBe(false);
    expect(deepEqualJson(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(deepEqualJson(new Set([1]), new Set([2]))).toBe(false);
  });
});

describe("queueItemsEqual — the POSITIVE direction (identical poll → no write)", () => {
  it("the same array reference is equal", () => {
    const q = [entry()];
    expect(queueItemsEqual(q, q)).toBe(true);
  });

  it("a freshly deserialized identical payload is equal", () => {
    const q = [entry(), entry({ id: "e2" })];
    // Exactly what the poll does: JSON round-trip produces new object identities
    // with identical content. This is the case that must NOT re-render.
    const roundTripped = JSON.parse(JSON.stringify(q));
    expect(queueItemsEqual(q, roundTripped)).toBe(true);
  });

  it("two empty queues are equal (the idle kiosk, polling forever)", () => {
    expect(queueItemsEqual([], [])).toBe(true);
  });

  it("key ORDER does not matter (unlike a JSON.stringify compare)", () => {
    expect(
      deepEqualJson(
        { id: "e1", nickname: "Ana", mode: "sing" },
        { mode: "sing", id: "e1", nickname: "Ana" }
      )
    ).toBe(true);
  });

  it("optional fields absent on both sides are equal", () => {
    const a = entry();
    const b = entry();
    delete (a as Record<string, unknown>).table;
    delete (b as Record<string, unknown>).table;
    expect(queueItemsEqual([a], [b])).toBe(true);
  });

  it("nested structures with equal content are equal", () => {
    expect(
      deepEqualJson({ a: { b: [1, { c: "x" }] } }, { a: { b: [1, { c: "x" }] } })
    ).toBe(true);
  });

  it("primitives and null compare by value", () => {
    expect(deepEqualJson(null, null)).toBe(true);
    expect(deepEqualJson(undefined, undefined)).toBe(true);
    expect(deepEqualJson("x", "x")).toBe(true);
    expect(deepEqualJson(1, 1)).toBe(true);
    expect(deepEqualJson(true, true)).toBe(true);
  });

  it("a realistic 20-entry queue polled unchanged is equal", () => {
    const big = Array.from({ length: 20 }, (_, i) =>
      entry({ id: `e${i}`, videoId: `vid${i}`, nickname: `Singer ${i}` })
    );
    expect(queueItemsEqual(big, JSON.parse(JSON.stringify(big)))).toBe(true);
    // ...and a single deep field change anywhere in it is still caught.
    const changed = JSON.parse(JSON.stringify(big));
    changed[17].nickname = "Singer 17!";
    expect(queueItemsEqual(big, changed)).toBe(false);
  });
});
