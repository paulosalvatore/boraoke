# TICKET-60 — Dev report: contrast assertions in e2e

- **Date:** 2026-08-05 · **Role:** Ticket Manager (Dev) · **Branch:** `ticket/60-contrast-e2e` · **Worktree:** `.worktrees/ticket-60` · **App port:** 3160
- **Status:** IMPLEMENTED + self-verified locally (unit 613/613 ✓, e2e 12/12 ✓ + 2 documented `test.fixme` findings, tsc clean of new errors) — PR to open next.

## Picking up from

Fresh ticket. TICKET-20's render/link suite (`e2e/render-and-links.spec.ts`) provably misses
contrast-class bugs — an opus reviewer flagged this on PR #17 as a HIGH follow-up that never
shipped, citing the join-code-input camouflage bug (input filled `var(--surface)` on a card of the
SAME `var(--surface)`) as the concrete miss. `Visible` per Playwright only means "non-zero box in
viewport" — it never inspected actual paint colors. This ticket adds that inspection.

## What was built

`e2e/contrast.spec.ts` (new, 453 lines, no edits to `e2e/helpers.ts` — a sibling ticket owns it,
everything needed is inlined):

- **`inPageContrast(el)`** — pure function run via Playwright's `locator.evaluate`. Parses
  `getComputedStyle(...).color` / `.backgroundColor` (Chromium always normalizes these to
  `rgb()`/`rgba()`), computes WCAG relative luminance per-channel, and alpha-composites a
  transparent element's own background up through its ancestor chain until it finds the first
  fully-opaque `background-color` (or falls back to white if the chain runs out, which never
  happens in this app — `html`/`body` set an opaque `--bg`). Returns resolved `fg`/`bg` as concrete
  `rgb(...)` strings, the computed ratio, and a large-vs-normal-text classification from resolved
  `fontSize`/`fontWeight` (>=24px any weight, or >=18.66px AND weight>=700).
- **`assertAA(locator, label)`** — asserts `ratio >= threshold` (4.5 normal / 3 large) with a
  failure message naming the label, both resolved rgb() values, the ratio, and the threshold — per
  AC, never a bare boolean.
- **Self-test describe block** ("contrast math sanity"), run before trusting the function on the
  app:
  1. Injects a synthetic black-on-white probe element → asserts ratio ≈ 21 (canonical WCAG max).
  2. Reproduces the EXACT TICKET-20 regression shape (surface `rgb(26,26,26)` on surface
     `rgb(26,26,26)`) → asserts ratio ≈ 1, and that it is below both the 4.5 and 3 thresholds — this
     is the proof that the old render/link suite's `toBeVisible()` could never have caught this,
     and that this function would.
  3. Injects a transparent-background span inside an opaque orange card → asserts the resolved
     background is the orange, not a black/white fallback — this is the direct proof for the
     "ancestor walk" acceptance criterion.
- **App coverage**, one `test.describe` per high-traffic surface named in the ticket:
  - **Landing + join-code input:** h1, join-by-code section heading, the join-code input's typed
    text against its own resolved fill, PLUS an explicit assertion that the input's resolved
    background is NOT identical to its wrapping card's resolved background (the literal shape of
    the original bug, expressed in real rgb() rather than variable names), footer copy.
  - **Patron room:** post-join heading/inputs/live-queue heading/player-hint, and — once a song is
    seeded — the queue item's title text and its mode badge (a `background: rgba(...)` tint over
    the item's own background, exercising real alpha compositing on a live app element, not a
    synthetic probe).
  - **Admin room:** post-login dashboard controls (pausar/retomar, pular música), the two
    customer-screen links, and the login gate's host-code input against its own fill.
  - **`/tv`:** idle-state copy block and the now-playing hero title (a large-text case — TV hero is
    `4.4vw`, which resolves comfortably over 24px at any real viewport, exercising the large-text
    3:1 branch).

## Findings on current `main` — NOT fixed (per AC: no token redesign)

Two genuine, reproducible AA misses surfaced. Both are marked `test.fixme` in the spec with an
inline comment citing the exact selector/colors/ratio, and are NOT counted toward the "12 passed"
below (Playwright reports them as `skipped`).

1. **`.btn-primary` (globals.css): white `#fff` text on `background: var(--accent)` (#e63946).**
   Resolved: `fg=rgb(255,255,255)` on `bg=rgb(230,57,70)` → **4.17:1**. Font is 16px/weight 600 —
   short of the 18.66px-bold large-text bar, so the 4.5:1 normal-text floor applies and this
   misses it. `.btn-primary` is the primary-CTA class used everywhere (landing create-room button,
   patron join-queue button, submit-song button, admin login button, etc.) — this is a
   site-wide-primary-button finding, not a one-off.
   Location: `e2e/contrast.spec.ts`, `landing page contrast` describe block,
   `test.fixme("create-room CTA button text meets AA — FAILS on current main...")`.

2. **`ModeSwitcher.module.css` `.option.active .name`:** `color: var(--accent)` (#e63946) over
   `background: rgba(230, 57, 70, 0.09)` (the `.option.active` tint) composited onto the card's
   `var(--bg)` (#0d0d0d, the nearest opaque ancestor). Resolved: `fg=rgb(230,57,70)` on `bg=rgb(33,17,18)` → **4.37:1**,
   just under the 4.5:1 floor (16px/weight 800, still short of large-text).
   Location: `e2e/contrast.spec.ts`, `admin room contrast` describe block,
   `test.fixme("active mode-switcher label meets AA — FAILS on current main...")`.

Both share the same root cause: `--accent` (#e63946) is ~2× too dark to hit 4.5:1 as a foreground
against its own family of backgrounds (solid #e63946 itself, or a light tint of itself over
`--surface`). Recommend a follow-up ticket (not this one) to either lighten `--accent` when used as
foreground text, or bump `.btn-primary`'s foreground/weight — deliberately out of scope here.

## Verification (real output, this branch/worktree, observed by me)

```
$ PORT=3160 npx playwright test e2e/contrast.spec.ts
Running 14 tests using 1 worker
  ✓ 1  contrast math sanity … black text on white background resolves to 21:1 …
  ✓ 2  contrast math sanity … known-bad pair (surface-on-surface …) computes ~1:1 …
  ✓ 3  contrast math sanity … transparent-background element resolves against the real ancestor paint …
  ✓ 4  landing page contrast … heading and join-by-code section heading meet AA
  -  5  landing page contrast … create-room CTA button text meets AA — FAILS on current main … (fixme)
  ✓ 6  landing page contrast … join-code input: typed text is legible against its OWN fill …
  ✓ 7  landing page contrast … footer + tagline (muted text) meet AA …
  ✓ 8  patron room contrast … post-join essentials …
  ✓ 9  patron room contrast … live queue entry: title, meta line, and mode badge meet AA once seeded
  ✓ 10 admin room contrast … dashboard controls and customer-screen links meet AA
  -  11 admin room contrast … active mode-switcher label meets AA — FAILS on current main … (fixme)
  ✓ 12 admin room contrast … login gate: host-code input text is legible against its own fill
  ✓ 13 tv screen contrast … idle state: wordmark + call-to-action text meet AA
  ✓ 14 tv screen contrast … now-playing state: hero title meets AA (large-text threshold) once seeded

  2 skipped
  12 passed (1.3m)
```

Before the two findings were marked `fixme`, the FIRST run (bundled assertions, no fixme yet)
genuinely FAILED with exactly the required diagnostic shape — proving the suite does fail loudly
on a real regression, not silently:

```
Error: Contrast failure for "landing: create-room CTA button text": fg=rgb(255, 255, 255) on
bg=rgb(230, 57, 70) → ratio=4.17:1 (needs 4.5:1 for normal text, fontSize=16px, fontWeight=600)

Error: Contrast failure for "admin: active mode-switcher label": fg=rgb(230, 57, 70) on
bg=rgb(33, 17, 18) → ratio=4.37:1 (needs 4.5:1 for normal text, fontSize=16px, fontWeight=800)
```

Unit tests (unrelated, proving nothing broke):

```
$ npm test
Test Suites: 43 passed, 43 total
Tests:       613 passed, 613 total
Time:        2.632 s
```

TypeScript:

```
$ npx tsc --noEmit
```
2017 errors, ALL pre-existing — confirmed by removing `e2e/contrast.spec.ts` from the tree and
re-running `tsc --noEmit`: identical 2017-line output. The errors are in
`__tests__/youtube.test.ts` (missing jest global types in the tsc-only pass — jest itself runs
fine, see `npm test` above) and `e2e/advance-auth.spec.ts` (a pre-existing `request.get({method})`
typing mismatch, not touched by this ticket). `e2e/contrast.spec.ts` introduces zero new tsc
errors.

## Files touched (exhaustive, matches the ticket's allowlist)

- `e2e/contrast.spec.ts` (new)
- `work/tickets/TICKET-60-contrast-e2e.md`
- `work/reports/dev/TICKET-60-dev-report.md` (this file)
- `work/reports/review/TICKET-60-review.md` (reviewer verdict, written after independent review)

## Scope deliberately left out

- No fix to the two `--accent`-as-foreground contrast findings above — the ticket explicitly
  forbids redesigning tokens in this pass. Flagged as a follow-up.
- No changes to `e2e/helpers.ts` — owned by a sibling ticket running in parallel; everything this
  spec needs (warm-up, room creation, song seeding) is inlined, deliberately duplicated from
  `e2e/render-and-links.spec.ts`'s pattern rather than shared.
- No visual/screenshot-based contrast tooling (e.g. axe-core) — the ticket specifically asked for a
  hand-rolled relative-luminance function operating on resolved computed-style values, not a
  third-party a11y linter.
