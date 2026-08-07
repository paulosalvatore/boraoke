# TICKET-70 — Stop the `/tv` up-next rail truncating singer names to ~2 characters

**Status:** DELIVERED — PR open, awaiting gate/merge
**Filed:** 2026-08-07, live app tour on boraoke.com
**Priority:** HIGH — the venue's biggest screen, cosmetic-looking but reads as broken software
**Type:** CSS layout defect + regression coverage. `components/tv/tv.module.css`, `components/tv/TvScreen.tsx`, `e2e/tv.spec.ts`.

## The defect

On the live `/tv` venue screen, the "A SEGUIR" (up-next) rail truncated singer nicknames to
roughly two characters — "Br…", "C…", "Di…" instead of "Bruno", "Carla", "Diego". Evidence:
`work/evidence/app-tour/tv-now-playing-{1920x1080,1440x900}.png`.

## Root cause (confirmed by reproduction, not guessed)

`.rail` (`components/tv/tv.module.css`) is a flex row: the `railLabel` ("A SEGUIR"), three
`.nextCard` items (`flex: 1`, i.e. `flex-basis: 0%` — they only ever get a share of *leftover*
space), and the `.join` "powered by / QR" card. `.join` was `flex: none` with **no width cap** —
sized purely by its own content, which includes the room's join URL (`host + /roomId`). That URL's
length scales directly with the room slug.

On the short `default` test room the join card stayed small and every existing test passed. In
production the room slug was a realistic multi-word one (`bar-boraoke-tour-especial` in this
ticket's repro; the tour's own room read `bar-boraoke-tour` in the QR text). That grew `.join` wide
enough to push total row content past the viewport. Because the three `.nextCard`s compete for
space against a sibling that never yields, and `.nextCard .info` already carries `min-width: 0`
(needed for its own `text-overflow: ellipsis` to engage at all), the flex algorithm collapsed
`.info` down to a handful of pixels — turning "ellipsis" into "clip to ~1 character" even though
most of the screen sat empty. Measured directly: the name column went from ~113px (fits "Bruno")
to ~9-24px depending on slug length, and in the most extreme repro (64-char slug) the join card's
own URL text ran off the right edge of the screen entirely — a second, related visual defect from
the same missing bound.

This was **not** a JS-side truncation (no `slice`/`substring` on `nickname` anywhere in the render
path) and not a stale-production-build artifact — it reproduces on `main` today with any
realistic multi-word room slug, confirmed via direct DOM measurement and screenshot before any fix
was applied.

## The fix

`components/tv/tv.module.css`:
- `.join` gets `max-width: 26vw; min-width: 0;` — it can no longer grow past a bounded share of
  the row regardless of room slug length.
- New `.joinText` class on the QR's sibling text column (`min-width: 0; overflow: hidden;`) so its
  own children's ellipsis can actually engage instead of forcing `.join` wider.
- `.join .cta` / `.join .url` get `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`
  — the join card's own text degrades gracefully instead of running off-screen on an extreme slug.
- `.nextCard` gets a `min-width: 8vw` floor — belt-and-suspenders so a squeezed row still leaves a
  legible sliver rather than collapsing toward 0, on top of the primary `.join` cap.

`components/tv/TvScreen.tsx`: one line — the join card's previously-unnamed wrapper `<div>` gets
`className={styles.joinText}`. No other JSX, no watchdog/auto-advance/self-heal logic touched.

## Regression test

`e2e/tv.spec.ts` gained one new test using a deliberately long, realistic room slug (the short
`default` room used by every other test in the file cannot reproduce this bug). It seeds Bruno,
João, and a pathologically long (27-char) nickname, then:

- Asserts `scrollWidth <= clientWidth` on the actual rendered `.who` box for Bruno/João — i.e. the
  box is wide enough to show its own text with **zero** CSS clipping. This is the assertion that
  actually matters: a `getByText(name, { exact: true })` check alone is **not** sufficient, because
  `text-overflow: ellipsis` is purely visual and never changes `textContent` — that gap was caught
  in independent opus review and fixed before merge (see review report).
- Asserts the *opposite* (`scrollWidth > clientWidth`) for the pathological nickname, proving the
  test is meaningful — it correctly expects that one to clip.
- Asserts the long-name card and the join/QR card both stay fully inside the viewport (no
  horizontal overflow) — clipping text is fine, overflowing the layout is not.

Verified both directions: stashing the CSS/TSX fix back out makes this test fail (`Received: 107`
against a `<= 8` box); restoring the fix makes it pass again, all 5 TV specs green.

## Verification

- `npx tsc --noEmit` — clean on all 3 touched files (repo has a pre-existing, unrelated baseline
  gap: `__tests__/*.test.ts` lack jest type globals, and one pre-existing type error in
  `e2e/advance-auth.spec.ts` — neither touched by this diff).
- `npm test` (jest) — 43 suites / 683 tests, all green.
- `npm run build` — clean production build.
- `PORT=3182 npx playwright test e2e/tv.spec.ts` — 5/5 green.
- `PORT=3182 npx playwright test` (full suite) — 62 passed, 2 pre-existing documented skips in
  `e2e/contrast.spec.ts` ("FAILS on current main" — unrelated to this ticket), 0 failures.

## Gates

- App Tester: before/after screenshots at 1920x1080 and 1440x900, `work/evidence/TICKET-70/`.
- Reviewer (opus, clean context): independently re-derived the root cause, reproduced the bug,
  tried to break the fix (64-char room slug, simultaneous long nicknames, accents), caught the
  vacuous-test gap above. See `work/reports/review/TICKET-70-review.md` for the full verdict.

## Not in scope

- `Estêvão`-length (7-char accented) single-word nicknames still clip at the narrower 1440x900
  width — that's the rail's pre-existing information density at that viewport (same box width the
  design already used for short names), not a regression from this fix. Flagged as a possible
  follow-up, not fixed here.
- The auto-hiding chrome buttons (`Tela cheia`, `Pular`) visually overlap the join card's
  `poweredBy` line at the bottom-right corner on some widths — pre-existing, `position: fixed`
  regardless of join-card width, unrelated to this ticket's scope.
