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

**Round 1 — bound the greedy sibling.** `components/tv/tv.module.css`:
- `.join` gets `max-width: 26vw; min-width: 0;` — it can no longer grow past a bounded share of
  the row regardless of room slug length.
- New `.joinText` class on the QR's sibling text column (`min-width: 0; overflow: hidden;`) so its
  own children's ellipsis can actually engage instead of forcing `.join` wider.
- `.join .cta` / `.join .url` get `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`
  — the join card's own text degrades gracefully instead of running off-screen on an extreme slug.
- `.nextCard` gets a `min-width: 8vw` floor — belt-and-suspenders so a squeezed row still leaves a
  legible sliver rather than collapsing toward 0, on top of the primary `.join` cap.

`components/tv/TvScreen.tsx`: one line — the join card's previously-unnamed wrapper `<div>` gets
`className={styles.joinText}`.

**Round 2 — the rail's own internal budget (TL rejected round 1's "follow-up" framing).** Round 1
alone only moved the truncation threshold from ~2 characters to ~6: ordinary Brazilian first names
(Estêvão, Fernanda, Gabriel) still clipped, because `.mesa` (the table badge) sat beside the whole
`.info` column as a permanent ~98px cost. Reflowed the card: `.mesa` now shares a row (new
`.metaRow`) with `.what` (the song title, already secondary/muted text) instead of the name's own
line. `.who` is alone on its own line and gets close to the full column width — measured roughly
**double**: ~110px → ~231px at 1920×1080, ~86px → ~173px at 1440×900. Verified with real Brazilian
names up to 11 characters (Rodriguinho) rendering in full at both target widths.

**Round 3 — two non-blocking findings from the round-2 review, both fixed.**
- `.nextCard .mesa` gained `max-width: 9vw; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;` — the server's actual maximum table label (10 chars) in the narrowest
  3-card layout could otherwise spill ~14px past the card edge.
- The regression test's clip-tolerance changed from a flat `+1px` to a documented 12%-relative
  bound, absorbing realistic cross-platform font-substitution variance (the 1440×900 width had only
  ~5% real margin on an 11-char name) without masking a genuine regression (the original bug
  collapsed the box by >90%).

No JSX/CSS change in any round touched the watchdog, auto-advance, or self-heal logic.

## Regression test

`e2e/tv.spec.ts` gained three TICKET-70 tests (a deliberately long, realistic room slug throughout
— the short `default` room used by every other test in the file cannot reproduce this bug):

1. **Realistic Brazilian names at 1920×1080** — Bruno, Estêvão, Fernanda all asserted not clipped.
2. **An 11-char name at the narrower 1440×900** — Leonardo, Rodriguinho, Mariana, the harder-margin
   viewport per the round-2 review.
3. **A pathologically long (27-char) nickname degrading gracefully** — seeded alongside two normal
   names sharing the same 3-slot rail (not an artificially uncontested single card). Asserts the
   short names stay unclipped, the long one DOES clip (proving the test discriminates, not just
   passes), and both the long-name card and the join card stay inside the viewport.

The core assertion — `scrollWidth <= clientWidth × 1.12` on the actual rendered `.who` box — is the
one that matters: a `getByText(name, { exact: true })` check alone is **not** sufficient, because
`text-overflow: ellipsis` is purely visual and never changes `textContent`. That gap was caught in
the first independent opus review round and fixed before proceeding.

Verified in both directions, twice — once for the round-1 fix, once for round 2: stashing each
fix's CSS/TSX back out makes the corresponding test(s) fail with real measured numbers quoted in
the dev report; restoring the fix makes them pass again.

## Verification (final numbers, after all three rounds, post-merge with `origin/main`)

- `npx tsc --noEmit` — clean on all 3 touched files at every stage (repo has a pre-existing,
  unrelated baseline gap: `__tests__/*.test.ts` lack jest type globals, and one pre-existing type
  error in `e2e/advance-auth.spec.ts` — neither touched by this diff).
- `npm test` (jest) — 43 suites / 683 tests, all green.
- `npm run build` — clean production build, 31 pages.
- `PORT=3182 npx playwright test e2e/tv.spec.ts` — 7/7 green.
- `PORT=3182 npx playwright test` (full suite) — **68 passed, 0 skipped, 0 failed.** (The repo
  merged TICKET-66's accent-token PR mid-ticket, which made `e2e/contrast.spec.ts` fully live — all
  16 contrast tests included and green.)

## Gates

- App Tester: before/after screenshots at 1920x1080 and 1440x900, `work/evidence/TICKET-70/`
  (round 1), plus additional after-reflow screenshots (round 2) showing Estêvão/Fernanda/Gabriel
  and Leonardo/Rodriguinho/Mariana rendering in full.
- Reviewer (opus, clean context), round 1: independently re-derived the root cause, reproduced the
  bug, tried to break the fix, caught the vacuous-test gap. Verdict: APPROVE-WITH-FOLLOWUPS.
- Reviewer (opus, clean context, fresh instance), round 2: independently re-verified the rail
  reflow by measurement, tried to break it, found the two Round-3 findings above. Verdict:
  APPROVE-WITH-FOLLOWUPS.
- Both findings fixed and re-verified with real output + targeted manual repro of each edge case.
  Final verdict in `work/reports/review/TICKET-70-review.md`: **APPROVE**.

## Not in scope

- The auto-hiding chrome buttons (`Tela cheia`, `Pular`) visually overlap the join card's
  `poweredBy` line at the bottom-right corner on some widths — pre-existing, `position: fixed`
  regardless of join-card width, unrelated to this ticket's scope.
- A room slug near the 64-char registry cap combined with 3 simultaneous long (24+ char) nicknames
  was stress-tested by the round-1 reviewer and held, but is not pinned in the regression suite —
  judged disproportionate to this ticket's scope as a dedicated test.
