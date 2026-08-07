# TICKET-60 — Contrast assertions in e2e (closes the TICKET-20 gap PR #17 flagged)

Status: implemented — unit + e2e green locally (2 findings marked `test.fixme`); PR open.
Branch: `ticket/60-contrast-e2e`
Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-60`
App port: 3160

## Background

The TICKET-20 render/link e2e suite (`e2e/render-and-links.spec.ts`) asserts elements are
*present* (`toBeVisible()`), which Playwright evaluates purely on layout box size/position — it
says nothing about whether the rendered colors are actually legible. That gap is exactly what let
the original join-code-input bug ship: the input's fill (`background: var(--surface)`) sat on a
card with the SAME `var(--surface)` background, so the field was invisible even though every
`toBeVisible()` in the old suite passed. An opus reviewer flagged this as a HIGH follow-up on PR
#17 that never shipped. This ticket is that follow-up.

## Acceptance criteria (from the ticket brief)

- Assert on `getComputedStyle` foreground/background pairs resolved to real rgb values — not
  class names or CSS-variable names.
- WCAG AA thresholds: 4.5:1 normal text, 3:1 large text (>=24px, or >=18.66px bold).
- Real relative-luminance contrast-ratio function implemented in the spec (no library).
- Ancestor-walk for transparent backgrounds to the first opaque paint.
- Failures report exact selector/label + both resolved rgb() values + the computed ratio.
- No redesigning tokens; genuine failures on current `main` get `test.fixme` + inline comment +
  dev-report entry, never a loosened threshold.

## What shipped

`e2e/contrast.spec.ts` (new, 453 lines):

- `inPageContrast()` — pure in-browser function (via `locator.evaluate`): parses `rgb()`/`rgba()`,
  computes WCAG relative luminance, alpha-composites transparent layers over an ancestor walk to
  the first opaque `background-color`, computes the contrast ratio, and classifies large vs
  normal text by resolved `fontSize`/`fontWeight`.
- `assertAA(locator, label)` — asserts `ratio >= threshold` with a message naming the label + both
  resolved rgb() values + the ratio + the threshold used.
- A "contrast math sanity" describe block: black-on-white → 21:1 (canonical WCAG max),
  a reproduction of the exact TICKET-20 bug (surface-on-surface) → ~1:1 (would fail both
  thresholds), and a transparent-background probe proving the ancestor walk resolves to the real
  paint, not a black/white default.
- Coverage across the four high-traffic surfaces named in the ticket: landing page + join-code
  input, patron room (post-join + seeded queue item incl. mode badge), admin room (post-login
  dashboard + login gate), and `/tv` (idle + now-playing/hero).

## Findings on current `main` (NOT fixed — tokens left as-is per AC)

1. **`.btn-primary` (white `#fff` on `--accent` `#e63946`), 16px/weight 600 → 4.17:1.** Below the
   4.5:1 AA floor for normal text (16px bold doesn't reach the 18.66px large-text bar). This token
   pair is used on every primary CTA app-wide (landing create-room, patron join-queue, submit-song,
   etc.). Marked `test.fixme` at `e2e/contrast.spec.ts` (landing page contrast describe block).
2. **Active mode-switcher label** (`ModeSwitcher.module.css` `.option.active .name`): `color:
   var(--accent)` (#e63946) over `rgba(230, 57, 70, 0.09)` composited onto the card's
   `var(--bg)` (#0d0d0d, the nearest opaque ancestor) → resolved fg `rgb(230,57,70)` on bg `rgb(33,17,18)` → 4.37:1. Just
   under the 4.5:1 floor (16px/weight 800, still short of large-text). Marked `test.fixme` at
   `e2e/contrast.spec.ts` (admin room contrast describe block).

Both are genuine, reproducible AA misses on the CURRENT `--accent` token used as foreground text.
Recommend a follow-up ticket to either darken the accent-on-accent-tint pairing or bump `.btn-primary`
foreground/weight — deliberately out of scope here (AC: no token redesign in this ticket).

## Verification run (real output, this branch, this worktree)

```
PORT=3160 npx playwright test e2e/contrast.spec.ts
...
12 passed, 2 skipped (fixme) — 1.3m
```

```
npm test
Test Suites: 43 passed, 43 total
Tests:       613 passed, 613 total
```

```
npx tsc --noEmit
```
2017 pre-existing errors, ALL in files this ticket never touched (`__tests__/youtube.test.ts`
missing jest globals config, `e2e/advance-auth.spec.ts` a `request.get({method})` typing issue).
Verified identical count with `e2e/contrast.spec.ts` moved out of the tree — this ticket introduces
zero new tsc errors.

## Files touched (exhaustive, per allowlist)

- `e2e/contrast.spec.ts` (new)
- `work/tickets/TICKET-60-contrast-e2e.md` (this file)
- `work/reports/dev/TICKET-60-dev-report.md`
- `work/reports/review/TICKET-60-review.md`
