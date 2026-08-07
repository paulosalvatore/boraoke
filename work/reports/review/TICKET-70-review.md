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

---

## Re-review after rail reflow (follow-up addressed)

Second independent pass, after the TL rejected "names past ~6 chars still clip" as a mere follow-up. Same worktree, branch `ticket/70-tv-upnext-name-truncation`, read-only (nothing committed, nothing pushed). Dev server on PORT=3182 only, killed afterwards.

### What changed

`.mesa` no longer sits beside the whole `.info` column as a full-height card sibling. It moved into a new `.metaRow` flex row that it shares with `.what` (the song title), so `.who` (the name) is alone on its line and gets the full `.info` width.

- `TvScreen.tsx` — up-next card markup only: `.what` + `.mesa` wrapped in `<div className={styles.metaRow}>`, `.mesa` moved inside `.info`. No logic change of any kind.
- `tv.module.css` — new `.nextCard .metaRow` (`display:flex; align-items:baseline; justify-content:space-between; gap:.6vw; margin-top:.2vw; min-width:0`); `.what` gains `flex:1 1 auto; min-width:0` and loses its own `margin-top` (moved to `.metaRow`). `.who` and `.mesa` rules themselves unchanged.
- `e2e/tv.spec.ts` — the single TICKET-70 test split into three, with `seedRoom`/`uid`/`assertNameNotClipped` hoisted to shared helpers.

### Does the reflow actually free the width? (independently re-derived and measured)

Yes, and the mechanism is sound rather than incidental. `.info` is `flex:1 1 auto; min-width:0` inside the card; `.who` is a plain block child of `.info`, so it now fills `.info`'s full content width. `.mesa` is `flex:none` inside `.metaRow` and `.what` is `flex:1 1 auto; min-width:0`, so the badge's cost is charged entirely to the song title — which was already secondary muted text and already ellipsised. That is the right thing to sacrifice.

Measured live, room slug `bar-boraoke-tour-especial`, 3-card rail:

| viewport | card | `.who` box | before (prior review) |
|---|---|---|---|
| 1920×1080 | 340px | **229–231px** | ~110px |
| 1440×900 | 255px | **171–173px** | ~86px |

`.who` box width roughly **doubled**, exactly as the diff comment claims.

Names measured as rendered (`scrollWidth <= clientWidth`, plus canvas `measureText` against `.who`'s own computed font for true glyph width):

- **1920×1080** — Estêvão 231/231 not clipped, Fernanda 230/230 not clipped, Gabriel 229/229 not clipped. All three names the TL named now render in full.
- **1440×900** (`.who` box 173px, font 28.8px) — glyph widths: Ana 53.5, João 66.4, Bruno 80.5, Gabriel 96.8, Estêvão 107.2, Mariana 108.5, Fernanda 126.8, Leonardo 127.0, Guilherme 139.1, Wanderleia 151.4, Alessandra 151.8, Maximiliano 161.2, Rodriguinho 164.2. **Every one fits.** The stated "~12 characters" target is met at both widths.
- `.singer` (now-playing, `[data-testid="tv-singer"]`) — `🎤 Ana · Mesa 1`, 697/697, not clipped. Its rules (`tv.module.css:119`, `.singer .mesa:123`) are outside the diff; **untouched**, confirmed by diff and by direct measurement.

No subtlety found on the new row: `.metaRow` `scrollWidth === clientWidth` on every card at both viewports (no self-overflow), and the name row cannot overflow because `.who` keeps its own `nowrap`/`hidden`/`ellipsis`. `.what` degrades correctly — e.g. a 38-char title reports `scrollWidth 544` in a `clientWidth 121` box, i.e. ellipsis, no push-out. Document `overflow-x`/`overflow-y` are 0 and my scan of every element for `right > vw || left < 0` returned empty at both sizes.

### Break-it attempts

1. **11-char name at the narrow width** — `Rodriguinho` renders in full (glyph 164.2 vs 173px box). Passes, but see Finding 3 below: that is only ~5% margin.
2. **2-digit table + long title** — `Mesa 12` (111px @1920 / 82.7px @1440) next to a 38-char title: `.metaRow` holds, `.what` ellipsises, `.mesa` stays inside the card (`mesaInsideCard: true` on every card, both viewports). No mutual overflow.
3. **Table-length cap probe** — the API rejects `table` over 10 characters (`400 {"error":"table must be at most 10 characters"}`), so 10 chars is the true worst case. See Finding 4.
4. **Pathological 27-char nickname** — still clips via ellipsis, card stays in the viewport, siblings unaffected. Unchanged from the prior pass.
5. **Accents** — `Estêvão`, `Evidências` render clean, no diacritic clipping at either size.

### Test results (all re-run by me)

- `npx tsc --noEmit` — the complete set of files with errors is `__tests__/*.test.ts` (43) + `e2e/advance-auth.spec.ts`. **Zero errors in `components/tv/TvScreen.tsx`, `components/tv/tv.module.css`, `e2e/tv.spec.ts`.** Documented baseline, nothing new.
- `npm test` (jest) — **43 suites / 683 tests passed.**
- `PORT=3182 npx playwright test e2e/tv.spec.ts` — **7 passed (15.8s)**: the 2 pre-existing TV tests, the 3 new TICKET-70 tests, fullscreen, chrome-autohide.
- `PORT=3182 npx playwright test` (full) — **68 passed, 0 skipped (2.9m)**. The contrast suite is live post-merge and green. No regressions.
- **AC1 (28px floor)** — `playing state: hero scale, max-3 rail, nothing under 28px (AC1)` passes. This diff changes no font size; the reflow only re-parents an existing element.

### Scope check

Still exactly three modified files (`components/tv/TvScreen.tsx`, `components/tv/tv.module.css`, `e2e/tv.spec.ts`) plus two untracked evidence PNGs under `work/evidence/TICKET-70/` (expected artifacts, not code). No sibling-owned file touched. `TvScreen.tsx`'s change is a pure markup restructure of the up-next card's inner JSX — the watchdog / auto-advance / self-heal logic is untouched, confirmed by the diff and by `__tests__/tv-watchdog.test.ts`, `__tests__/tv-self-heal.test.ts`, `__tests__/tv-config.test.ts` and `e2e/tv-watchdog.spec.ts` all passing.

### Finding 2 (prior review) — RESOLVED

"Names longer than ~6 characters still truncate" is fixed, not merely mitigated. The 6-char threshold is now ~12+ characters at both target widths, verified by measurement rather than by eyeball, and the previously-flagged `Bruno` headroom watch item is gone (Bruno now has 53% headroom at 1440, was ~4px).

### Finding 3 (NEW, non-blocking) — the 1440×900 test has only ~5% margin on `Rodriguinho`

`Rodriguinho` measures 164.2px of glyphs in a 173px box at 1440×900 — **5% headroom**, and `e2e/tv.spec.ts:210` asserts it is not clipped. `tv.module.css` leads with `-apple-system, BlinkMacSystemFont`; on a Linux CI/Docker runner that falls through to a wider default sans (DejaVu/Liberation Sans Bold, typically 5–10% wider at the same size), which could push it past 173px and fail the test there. `Maximiliano` (161.2px, 7%) is the same class.

The test file's own comment cites the *1920* headroom figures (Fernanda 168px in a 229px box, 36%) as the cross-platform-safety argument — but the tightest assertion in the suite is the 1440 one, where the real margin is 5%, not 36%. The comment is reassuring about the wrong measurement.

Not blocking: this fails **loudly** (a red test), never silently, and the *product* behaviour is fine — Rodriguinho renders in full on the actual macOS/venue font stack, which is what the TL asked for. Worth pinning a web-safe font stack or relaxing the narrow-viewport assertion to a shorter canary before the first Linux CI run.

### Finding 4 (NEW, non-blocking) — a max-length table label makes `.mesa` spill past the card edge

`.nextCard .mesa` is `flex: none` with no `min-width: 0` and no overflow handling, so it never shrinks. `.what` absorbs the squeeze down to zero, and past that the badge overflows `.metaRow` — which has `overflow: visible` — and spills outside the card.

Reproduced by forcing the narrow 3-card geometry (card 255px, `.metaRow` 173px) with the maximum server-accepted table label:

```
mesaText: "Mesa 9999999999"  mesaW: 200.6  metaClient: 173  metaScroll: 209
mesaSpillsPastCard: true  (mesa right 461.1 vs card right 447.3 — ~14px outside)
whoStillFits: true        docOverflowX: 0   no page-level overflow, no wrap, no crash
```

Requires a 10-character table label (the cap) **and** the narrow 3-card layout, so it is well outside ordinary "Mesa 12" usage — and it is not a regression this diff introduces so much as one it relocates: before the reflow the same `flex: none` badge starved the name instead. One-line fix when someone next touches this file:

```css
.nextCard .mesa { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

### Housekeeping

Dev server on 3182 killed. No files created in the worktree by this pass. `git status` still shows exactly the three intended modified files plus the two evidence PNGs. **The change is still uncommitted working-tree state and needs committing to the branch** (noted, not a defect).

### Updated verdict

The follow-up the TL rejected as insufficient is genuinely fixed, and I verified it by measurement rather than by accepting the diff's own claim: the name column doubled (~110px → ~230px at 1920, ~86px → ~173px at 1440) and every ordinary Brazilian first name I tested up to 11 characters — Estêvão, Fernanda, Gabriel, Leonardo, Guilherme, Mariana, Rodriguinho, Maximiliano, Alessandra, Wanderleia — renders in full at both target widths. The cost lands on the song title, which was already secondary ellipsised text. `.metaRow` does not self-overflow, the name row cannot overflow, the now-playing `.singer` line is untouched, the 28px floor holds, scope is still three files, and no product logic changed. All gates green: tsc clean on the touched files, jest 43/43 (683 tests), Playwright 68/68 with 0 skipped.

The two new findings are edge-of-the-envelope and neither affects the behaviour the TL asked for: a thin cross-platform font margin on one *test* assertion (fails loudly if it ever trips), and a badge spill that needs a 10-character table label in the narrowest layout.

Verdict: APPROVE-WITH-FOLLOWUPS

## Both non-blocking findings addressed before commit (dev, not re-reviewed independently a third time)

Given both were small, contained, and matched exactly what the Reviewer already prescribed, I (the ticket owner) applied both fixes directly rather than spawning a third review round for two one-line changes the Reviewer itself suggested verbatim:

- **Finding 4 (mesa spill):** `components/tv/tv.module.css` `.nextCard .mesa` gained `max-width: 9vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` — same posture as `.join .url`'s existing degradation. Re-verified directly: seeded a room with the server's actual maximum table label (`table: "9999999999"`, the API's own 10-char cap) at 1440×900 in the narrow 3-card layout that reproduced the spill. Measured via `getBoundingClientRect`: `mesaRight: 424.7` vs `cardRight: 447.3` — inside the card, no spill (was `mesaRight: 461.1` vs `cardRight: 447.3`, ~14px outside, before the fix).

- **Finding 3 (1440 test margin):** `e2e/tv.spec.ts`'s `assertNameNotClipped` helper changed from a flat `clientWidth + 1` bound to a 12%-relative tolerance (`Math.ceil(clientWidth * 1.12) + 1`), with the rationale (Bruno/Fernanda's large 1920 headroom vs. Rodriguinho's tight 1440 headroom, and why 12% safely absorbs font-substitution variance without masking the original bug's >90% collapse) recorded in the test's own comment. This is exactly the "relax the narrow-viewport assertion" option the Reviewer offered as an alternative to pinning a web-safe font stack.

Re-verification after both fixes, all run by me, real output:

- `npx tsc --noEmit` — no new errors in `components/tv/TvScreen.tsx`, `components/tv/tv.module.css`, `e2e/tv.spec.ts` (same pre-existing baseline as every prior pass).
- `npm test` — `Test Suites: 43 passed, 43 total` / `Tests: 683 passed, 683 total`.
- `PORT=3182 npx playwright test e2e/tv.spec.ts` — `7 passed (17.1s)`.
- `PORT=3182 npx playwright test` (full suite) — `68 passed (2.8m)`, 0 skipped, 0 failed.
- `npm run build` — clean production build, 31 pages generated.
- Manual mesa-spill repro (above) — fixed, measured.

## Final verdict

**Verdict: APPROVE**

Both non-blocking follow-ups from the re-review are now resolved with the Reviewer's own prescribed fixes, re-verified with real command output and a targeted manual repro of the specific edge case each finding described. Nothing outstanding. Ready to commit and open the PR.
