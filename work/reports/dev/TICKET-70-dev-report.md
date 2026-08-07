# TICKET-70 — Dev report: stop the `/tv` up-next rail truncating names to ~2 characters

- **Date:** 2026-08-07 · **Role:** Ticket Manager (Dev + gate orchestration) · **Branch:**
  `ticket/70-tv-upnext-name-truncation` · **Worktree:** `.worktrees/ticket-70` · **App port:** 3182

## Diagnosis (evidence before code)

Read both committed bug screenshots (`work/evidence/app-tour/tv-now-playing-{1920x1080,1440x900}.png`)
before touching anything. Pixel-scanned the 1920 screenshot: the "Br…" text glyphs occupy only
~30px, then there is a ~60px gap of empty card background before the "Mesa 2" badge — real CSS
`text-overflow: ellipsis` fills to the box edge, so a gap that size meant the box itself was
narrow, not that the text merely looked short.

Reproduced locally against `main`'s current code (not a stale-prod-build theory): seeded the
`default` room first — no truncation, "Bruno" rendered fully in a ~113px box. Seeded a realistic
multi-word room slug (`bar-boraoke-tour-especial`, matching the QR text visible in the evidence
screenshot itself) — truncation reproduced exactly, "Br…"/"C…"/"D…", plus the join card's own URL
text ran off the right edge of the screen. Root cause confirmed: `.join` (`components/tv/tv.module.css`)
was `flex: none` with no width cap, sized by its own content (the join URL, which scales with room
slug length); on a long slug it grew wide enough to squeeze the three `flex: 1` `.nextCard`s down
to a sliver, since `.nextCard .info`'s existing `min-width: 0` (needed for its own ellipsis) let it
shrink arbitrarily far with nothing to stop it. Not a JS-side truncation (searched the render path
— no `slice`/`substring` on `nickname`) and not a stale-deploy artifact.

## Fix

- `components/tv/tv.module.css`: `.join` → `max-width: 26vw; min-width: 0;`; new `.joinText`
  wrapper class (`min-width: 0; overflow: hidden;`); `.join .cta` / `.join .url` get
  `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`; `.nextCard` gets a
  `min-width: 8vw` safety floor.
- `components/tv/TvScreen.tsx`: one line — `className={styles.joinText}` on the join card's text
  wrapper `<div>`. No other JSX, watchdog, auto-advance, or self-heal logic touched.

## Regression test

Added a test to `e2e/tv.spec.ts` using a deliberately long room slug (the file's default `default`
room can't reproduce this bug — every other test in the file uses it and none caught this). Seeds
Bruno, João, and a 27-char pathological nickname.

**Caught in independent opus review, fixed before merge:** my first version asserted
`getByText(name, { exact: true })` + `toBeVisible()`. The reviewer correctly flagged this as
vacuous — `text-overflow: ellipsis` never changes `textContent`, so that assertion passes
regardless of visual truncation. Rewrote to assert `scrollWidth <= clientWidth` on the actual
rendered `.who` box (proof the box is wide enough to show its own text with zero clipping), plus
the inverse assertion on the pathological name (proof the test is discriminating, not just always
green). Verified both directions myself: `git stash`-ed the fix back out, re-ran the test, it
failed (`Received: 107` against a box that only had `8`); restored the fix, all 5 TV specs pass.

## Verification (all commands run, real output)

- `npx tsc --noEmit` — clean on the 3 touched files. Repo has a pre-existing, unrelated gap
  (`__tests__/*.test.ts` missing jest type globals; one pre-existing error in
  `e2e/advance-auth.spec.ts`) — confirmed none of it touches this diff's files.
- `npm test` — **43 suites / 683 tests, all passed** (2.7s).
- `npm run build` — clean production build, 31 static pages generated.
- `PORT=3182 npx playwright test e2e/tv.spec.ts` — **5/5 passed**.
- `PORT=3182 npx playwright test` (full suite, per the deflake note in the ticket about
  TICKET-65's cross-spec history) — **62 passed, 2 skipped** (pre-existing, documented
  "FAILS on current main" contrast gaps in `e2e/contrast.spec.ts`, unrelated to this ticket), 0
  failures.

## Gates

- **App Tester** (subagent): captured before/after at 1920x1080 and 1440x900 in
  `work/evidence/TICKET-70/`, confirmed Bruno/Carla/João render in full post-fix. Committed
  `c7d8f58`.
- **Reviewer** (opus, clean context, subagent): independently re-derived the root cause via its
  own repro (reverting the fix in-page and measuring the column width collapse), tried to break
  the fix with a 64-char room slug + 3 simultaneous long nicknames (held), confirmed scope
  discipline (3 files only, watchdog untouched), and caught the vacuous-test gap above.
  Re-verification requested after the test fix; see `work/reports/review/TICKET-70-review.md` for
  the final verdict.

## Not in scope (flagged, not fixed)

- 7+ char single-word accented names (`Estêvão`) still clip at 1440x900 — pre-existing rail
  information density at that width, not a regression from this fix.
- Chrome buttons (`Tela cheia`, `Pular`) visually overlap the join card's `poweredBy` line at some
  widths — pre-existing `position: fixed` overlap, unrelated to this ticket.
