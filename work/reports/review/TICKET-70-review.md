# TICKET-70 — Independent Review: `/tv` up-next name truncation

Reviewer: independent (no prior diagnosis seen). Worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-70`, branch `ticket/70-tv-upnext-name-truncation`. Read-only: nothing committed, nothing pushed.

Note: the change is **uncommitted working-tree state** on the branch (`git status` shows `M components/tv/TvScreen.tsx`, `M components/tv/tv.module.css`, `M e2e/tv.spec.ts`). The branch's committed diff vs `main` contains only evidence PNGs + an event-log line. The code still needs committing.

## Root cause (independently derived)

`.rail` is a flex row with five children: `.railLabel`, three `.nextCard`s, and `.join`.

- `.nextCard` is `flex: 1` — i.e. `flex-grow:1; flex-shrink:1; flex-basis:0%`. It claims **no** intrinsic width and lives entirely off leftover free space.
- `.join` was `flex: none` (`0 0 auto`) with **no width cap**. It therefore sized to its content and **refused to shrink**. Its content includes `.url` → `joinLabel` = `` `${joinHost}/${roomId}` `` (`TvScreen.tsx:145`), which grows with the room slug.

So the join card takes whatever it wants first, and the three up-next cards divide the remainder. With a realistic multi-word venue slug the join card grows past the row's budget, the remainder approaches zero, and because `.nextCard .info` carries `min-width: 0` (which it needs for its own ellipsis), the name column collapses to a few pixels. `text-overflow: ellipsis` on `.who` then renders "Br…" — the reported symptom — while most of the screen sits empty. `.tv` has `overflow: hidden`, so there is no scrollbar and nothing looks "broken"; the row just silently starves.

**This matches the diff's stated rationale.** I confirmed it causally rather than by inspection — see the counterfactual below.

### Causality proof (in-page counterfactual, 1920×1080, slug `bar-boraoke-tour-especial`)

Reverting *only* the TICKET-70 declarations live in the page:

| | join card width | "Carla" column | "João" column |
|---|---|---|---|
| with fix | 499.2px (= 26vw) | 110.0px, not clipped | 111.1px, not clipped |
| reverted | 758.4px | **23.6px, clipped** | **24.7px, clipped** |

With a 41-char slug the reverted name column reaches **0px**. This is exactly the `work/evidence/app-tour/tv-now-playing-1920x1080.png` "before" image ("Br…", "C…", "Di…", `.railLabel` pushed off the left edge). Root cause confirmed.

## Diff summary

- `tv.module.css` `.join`: `+ max-width: 26vw; + min-width: 0;` — the actual fix; bounds the greedy sibling.
- `tv.module.css` `.joinText` (new): `min-width: 0; overflow: hidden;` — lets the text column's children ellipsis instead of pushing `.join` wider.
- `tv.module.css` `.join .cta` / `.join .url`: `+ white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`.
- `tv.module.css` `.nextCard`: `min-width: 0` → `min-width: 8vw` — a legibility floor. Budget check: `3×8vw + 26vw + label + 4×1.5vw gaps ≈ 65vw` of `94vw` available, so the floor can never itself force overflow.
- `TvScreen.tsx`: one line — a bare `<div>` gains `className={styles.joinText}`. **No logic change.**
- `e2e/tv.spec.ts`: one new test (+68 lines).

Design call I agree with: when space is scarce the join card's *text* degrades, not the singer names — the QR carries the actual payload.

## Test results (re-run by me)

`npx tsc --noEmit` — errors exist, but the complete set of files with errors is `__tests__/*.test.ts` (43 files, all missing jest globals) plus `e2e/advance-auth.spec.ts:12` (the known `method` property error). **Zero errors in `components/tv/TvScreen.tsx`, `components/tv/tv.module.css`, or `e2e/tv.spec.ts`.** Matches the documented baseline; nothing new introduced.

`npm test` (jest):
```
Test Suites: 43 passed, 43 total
Tests:       683 passed, 683 total
```

`PORT=3182 npx playwright test e2e/tv.spec.ts`:
```
  ✓  1 idle state renders the recruitment poster without errors (AC3, AC6) (3.9s)
  ✓  2 playing state: hero scale, max-3 rail, nothing under 28px (AC1) (2.5s)
  ✓  3 up-next names stay fully readable on a long room slug, and a pathological nickname degrades gracefully (TICKET-70) (2.1s)
  ✓  4 fullscreen affordance enters fullscreen and hides after (AC2) (2.0s)
  ✓  5 chrome auto-hides and the cursor goes with it (5.7s)
  5 passed (34.5s)
```

`PORT=3182 npx playwright test` (full suite): **62 passed, 2 skipped (2.6m)** — the 2 skips are the documented `contrast.spec.ts` ones. No regressions.

Harness caveat worth recording: my first full-suite run showed 2 failures in `e2e/advance-auth.spec.ts`. That was **my** fault — `playwright.config.ts` uses `reuseExistingServer`, so it reused my plain `next dev` on 3182, which lacks the `ADVANCE_AUTH=enforce` env the config injects. After killing my server and letting Playwright start its own, the suite is fully green. `advance-auth.spec.ts` is untouched by this branch.

## Font-size AC (nothing under 28px)

AC1 passes. My own independent sweep of every leaf text node on `/tv` at 1920×1080 in the worst case returned `minFontPx: 28.8` (`.venue`). Up-next names render at 38.4px, secondary text at 28.8px. The fix changes no font size — floor intact.

## Break-it attempts

All at 1920×1080 unless noted; measured via `getBoundingClientRect` + `scrollWidth`/`clientWidth`.

1. **64-char room slug** (`bar-do-boraoke-tour-especial-de-verao-com-nome-absurdamente-long`) **+ three 24–25-char nicknames simultaneously in all 3 rail slots.** Join card held at exactly **499.2px = 26vw**, right edge 1862.4 < 1920. `offscreenEls: []` (I scanned every `.tv*` element for `right > vw` or `left < 0`). `docOverflowX: 0`, `docOverflowY: 0`. Names ellipsised cleanly. Layout held. Screenshot inspected visually — clean.
2. **65-char slug** — rejected server-side with 400. Cap is enforced upstream; nothing to break.
3. **27-char nickname** (`ZeMuitoLongoDoBairroInteiro`, under the 30-char cap) — ellipsis, card stays in viewport, no overflow, no crash. Graceful.
4. **Accents** — `João`, `Estêvão`, `Evidências`, `karaokê` all render correctly, no mojibake, no diacritic clipping.
5. **1440×900** — everything is `vw`-based so the layout is scale-invariant: join = 374.4px = 26vw, `offscreen: []`, `docOverflowX: 0`. Holds identically.

I could not break the layout. The CSS fix is sound.

## Finding 1 (RESOLVED — was blocking) — the original e2e test did not guard the regression

> **Update after re-review.** The test was rewritten and I independently re-verified it. Finding 1 is closed. The original analysis is kept below for the record; the resolution is in "Finding 1 — resolution" further down.

### Original finding

I tested whether the new test would **fail on unfixed main**, by injecting CSS that reverts exactly the TICKET-70 declarations and then running the test's own assertions verbatim, using **the test's own room slug** `tv-upnext-longslug-e2e-check`:

```
=== WITHOUT the fix (CSS reverted in-page = main) ===
assertions: {
  'getByText Bruno exact visible': 'PASS',
  'getByText João exact visible': 'PASS',
  'long-name card visible': 'PASS',
  'card inside viewport': 'PASS',
  'join card inside viewport': 'PASS'
}
measured: {"joinW":817.7,"names":[{"name":"Bruno","colW":5.1,"visuallyClipped":true},
                                  {"name":"João","colW":4.9,"visuallyClipped":true}]}
```

**Every assertion passes while the name column is 5.1px wide — the production bug, fully present.** The test is vacuous.

Two independent reasons:

- `text-overflow: ellipsis` is **purely visual**. It never alters `textContent`, so `getByText("Bruno", { exact: true })` matches identically whether the user sees "Bruno" or "B…". The test's own comment claims the opposite ("an exact match on the truncated `Br…` strings the bug produced would fail these assertions") — that is incorrect; the DOM never contains `"Br…"`.
- `toBeVisible()` is satisfied by any non-empty bounding box, so a 5px-wide element is "visible".
- The bounding-box assertions are also inert: `.tv` is `overflow: hidden`, so `docOverflowX` is 0 and the join card's right edge is 1862.4px in **both** states. They can never fire.

The test only fails when the column reaches *exactly* 0px, which needs a slug longer than the one shipped (my 41-char slug did reach 0 and did fail the assertions — so the guard works by accident at some lengths and not at the shipped one).

Suggested fix — assert the *rendered* geometry, not text presence:

```ts
const whoClipped = await page.locator('[class*="nextCard"]').first()
  .locator('[class*="who"]')
  .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
expect(whoClipped).toBe(false);          // a short nickname must render in full
// and/or a minimum column width:
const colW = await ...evaluate(el => el.getBoundingClientRect().width);
expect(colW).toBeGreaterThan(80);
```

This is a small, contained change and it makes the test fail on main, which is the whole point of shipping it.

### Finding 1 — resolution (re-reviewed, verified)

The test was rewritten (`e2e/tv.spec.ts` lines ~121–225) to assert rendered geometry via `scrollWidth` vs `clientWidth` on the `.who` box itself, plus an inverted assertion that the 27-char nickname *must* clip. I did not take the reported result on faith — I re-ran my own non-mutating counterfactual (inject CSS reverting exactly the TICKET-70 declarations; execute the rewritten test's assertion logic verbatim against the test's own slug):

```
=== WITH the fix (as shipped) ===
assertions: { 'assertNameNotClipped(Bruno)': 'PASS',
              'assertNameNotClipped(João)':  'PASS',
              'pathological name MUST clip': 'PASS' }
metrics: {"Bruno":{"scrollWidth":111,"clientWidth":111},
          "João":{"scrollWidth":111,"clientWidth":111},
          "longName":{"scrollWidth":529,"clientWidth":109}}

=== WITHOUT the fix (reverted = main) ===
assertions: { 'assertNameNotClipped(Bruno)': 'FAIL: expected <= 6, got 107',
              'assertNameNotClipped(João)':  'FAIL: expected <= 6, got 88',
              'pathological name MUST clip': 'PASS' }
metrics: {"Bruno":{"scrollWidth":107,"clientWidth":5},
          "João":{"scrollWidth":88,"clientWidth":5},
          "longName":{"scrollWidth":529,"clientWidth":3}}
```

**The test now fails on the buggy code and passes on the fixed code.** It is a genuine regression guard.

Additional checks I ran on the rewrite:

- **Selector uniqueness** — `[class*="who"]` matches exactly 3 elements on the page, and the `hasText` filter matches exactly 1 each for `Bruno`, `João`, and the long name. No ambiguity, no accidental match against `.what` (which does not contain the substring `who`).
- **`expect(text).toBe(name)`** correctly pins exactness, so the geometry check can't be satisfied by some other element.
- **The assertion is binary, not margin-sensitive** — `scrollWidth` is clamped to at least `clientWidth`, so "fits" always yields exact equality and "clips" always yields a strict excess. The `+1` tolerance is harmless; there is no knife-edge in the comparison itself.
- **The inverted assertion on the pathological name is the right call** — it proves the test would notice if the whole rail silently stopped clipping (e.g. the cards growing unbounded), so the test can't pass vacuously in either direction.

The retained bounding-box/viewport assertions are still inert on their own (`.tv` is `overflow: hidden`), but they are now redundant belt-and-braces rather than the sole guard, which is fine.

### Residual watch item (non-blocking) — `Bruno` has ~4px of font headroom

With the fix, `.who` renders at 111px while `"Bruno"`'s natural width is 107px (read off the reverted run, where `scrollWidth` reports true content width). That is ~4px / ~3.7% of headroom on this macOS font stack. `tv.module.css` leads with `-apple-system, BlinkMacSystemFont`, which on a Linux runner falls through to a wider default sans (DejaVu/Liberation), so `"Bruno"` bold at 38.4px could plausibly exceed 111px there and fail the test on a Linux CI/Docker run. `João` (88px natural, 23px headroom) is not at risk.

Not a blocker: `Bruno` is exactly the right canary (it is the literal production symptom), and this fails **loudly and visibly** rather than silently, which is the correct failure direction for a regression guard. Worth knowing before the first Linux run, and it is really the same underlying constraint as Finding 2 — the name column is simply very tight.

## Finding 2 (non-blocking, follow-up) — names longer than ~6 chars still truncate

Even with the fix, at 1920×1080 the name column settles at **~110px** while the card is 340px. Budget: 340 − 57.6 padding − 26.4 (`.n`) − 98.1 (`.mesa` "Mesa 11") − 46 gaps ≈ 110px. At the 2vw/38.4px name font that is roughly **5–6 characters**.

- `Bruno`, `Carla`, `João` → fit (the reported bug is genuinely fixed).
- `Estêvão` (7 chars) → still clipped to "Estê…".

Common Brazilian nicknames (Fernanda, Guilherme, Estêvão) will still ellipsise on the venue screen. That is a real residual UX gap, though a large improvement over "Br…" and it degrades gracefully. The remaining levers are the rail's internal budget (`.mesa` takes 98px, nearly as much as the name), not the join cap — so it is a separate design decision, not a defect in this diff. Recommend a follow-up ticket.

## Scope check

`git status --short` shows exactly three modified files:

```
 M components/tv/TvScreen.tsx
 M components/tv/tv.module.css
 M e2e/tv.spec.ts
```

No sibling-owned files touched — `app/globals.css`, `app/page.tsx`, `components/FeedbackWidget.tsx`, `e2e/helpers.ts`, `e2e/contrast.spec.ts` are all clean. `TvScreen.tsx` is a **2-line diff (one line changed)**: a `className` added to an existing `<div>`. The watchdog / auto-advance / self-heal logic is **not** touched — confirmed by the diff and by `__tests__/tv-watchdog.test.ts`, `__tests__/tv-self-heal.test.ts`, `__tests__/tv-config.test.ts` and `e2e/tv-watchdog.spec.ts` all passing. Scope discipline is clean.

Housekeeping: the dev server on 3182 was killed; two temp scratch files I created in the worktree were deleted; a stray Playwright screenshot that landed in the framework repo root was removed. `git status` is back to the three intended files.

## Final test results (after the test rewrite, all re-run by me)

- `npx tsc --noEmit` — no errors in `components/` or `e2e/tv.spec.ts`; only the documented `__tests__/*` + `e2e/advance-auth.spec.ts` baseline.
- `npm test` — **43 suites / 683 tests passed.**
- `PORT=3182 npx playwright test e2e/tv.spec.ts` — **5 passed (15.1s)**, including AC1 (28px floor) and the rewritten TICKET-70 test.
- `PORT=3182 npx playwright test` (full) — **62 passed, 2 skipped (2.8m)**; the 2 skips are the documented `contrast.spec.ts` ones. No regressions.
- Scope unchanged: still exactly `components/tv/TvScreen.tsx`, `components/tv/tv.module.css`, `e2e/tv.spec.ts`. `TvScreen.tsx` remains a one-line `className` addition; watchdog/auto-advance/self-heal untouched.

## Verdict

**Verdict: APPROVE-WITH-FOLLOWUPS**

The CSS fix is correct, minimal, well-reasoned and in-scope. I re-derived the root cause independently and proved it causally; I could not break the layout under a 64-char room slug, three simultaneous 24-char nicknames, accents, or a second viewport. The 28px font floor is intact.

Finding 1 (the vacuous regression test) is **resolved and independently re-verified**: the rewritten test provably fails on the buggy code (`clientWidth` 5px vs `scrollWidth` 107px) and passes on the fixed code, its selectors are unambiguous, and its inverted assertion on the pathological nickname keeps it from passing vacuously in the other direction. All gates green.

Follow-ups to file as separate tickets, not to fix here:

1. **Names longer than ~6 characters still truncate** on the venue screen (`Estêvão` → "Estê…"). The name column settles at ~110px because `.mesa` consumes 98px of a 340px card. Common Brazilian nicknames will still ellipsise. This is a rail-budget design decision, not a defect in this diff.
2. **`Bruno` has only ~4px of font headroom** in the new assertion, so the test may fail on a Linux runner with a wider fallback font. Same underlying tightness as (1); fails loudly if it ever trips.

One housekeeping item before merge: the change is still uncommitted working-tree state — it needs committing to the branch.
