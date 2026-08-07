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

## Fix, round 1 — the `.join` cap

- `components/tv/tv.module.css`: `.join` → `max-width: 26vw; min-width: 0;`; new `.joinText`
  wrapper class (`min-width: 0; overflow: hidden;`); `.join .cta` / `.join .url` get
  `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;`; `.nextCard` gets a
  `min-width: 8vw` safety floor.
- `components/tv/TvScreen.tsx`: one line — `className={styles.joinText}` on the join card's text
  wrapper `<div>`. No other JSX, watchdog, auto-advance, or self-heal logic touched.
- Regression test added to `e2e/tv.spec.ts` using a deliberately long room slug (the file's default
  `default` room can't reproduce this bug — every other test in the file uses it and none caught
  this).

**Caught in independent opus review, fixed before proceeding:** my first version of the test
asserted `getByText(name, { exact: true })` + `toBeVisible()`. The reviewer correctly flagged this
as vacuous — `text-overflow: ellipsis` never changes `textContent`, so that assertion passes
regardless of visual truncation. Rewrote to assert `scrollWidth <= clientWidth` on the actual
rendered `.who` box. Verified both directions myself: `git stash`-ed the fix back out, re-ran the
test, it failed (`Received: 107` against a box with `clientWidth: 8`); restored the fix, all 5 TV
specs passed. Reviewer verdict on round 1: **APPROVE-WITH-FOLLOWUPS**, flagging that names past
~6 characters (Estêvão, Fernanda, Gabriel — ordinary Brazilian first names) still clipped, because
`.mesa` (the table badge) sat beside the FULL name column as a permanent ~98px cost.

## Fix, round 2 — the TL rejected "follow-up" framing and asked for the rail budget itself fixed

This is a Brazilian product; Estêvão/Fernanda/Gabriel are not edge cases. Reflowed the rail card:
`.mesa` no longer sits beside the whole `.info` column as a full-height sibling — it now shares a
row (new `.metaRow`) with `.what` (the song title, already secondary/muted text). `.who` (the name)
is alone on its own line and gets close to the full column width.

- `components/tv/tv.module.css`: `.nextCard .who` (unchanged rules, just re-parented), new
  `.nextCard .metaRow` (`display:flex; justify-content:space-between; min-width:0`), `.what` moved
  under it with `flex:1 1 auto; min-width:0`, `.mesa` moved under it too.
- `components/tv/TvScreen.tsx`: the rail card's inner JSX restructured — `.what` and the table badge
  now sit inside a new wrapper div alongside `.who`, instead of the badge being a sibling of the
  whole `.info` block. Pure markup change, same data, same conditionals.
- Measured result: the name column roughly **doubled** — ~110px → ~231px at 1920×1080, ~86px →
  ~173px at 1440×900. Verified with real Brazilian first names: Estêvão, Fernanda, Gabriel,
  Leonardo, Rodriguinho (11 chars), Mariana all render in full at both widths. A genuinely
  pathological 27-char nickname still clips gracefully (verified with a real DOM measurement,
  `scrollWidth > clientWidth`, card and join card both stay inside the viewport).
- `e2e/tv.spec.ts` extended: the single TICKET-70 test became three — realistic Brazilian names at
  1920×1080, an 11-char name at the narrower 1440×900 (the harder case), and the pathological-name
  degradation case (now seeded alongside two short names sharing the same 3-slot rail, not an
  artificially uncontested single card).

Dispatched a second independent opus review specifically on this reflow (same reviewer brief,
fresh instance). It re-derived the fix causally rather than trusting the diff, tried to break it
(11-char names at 1440, 2-digit table numbers next to long titles, the server's actual 10-char
table-length cap), and found the reflow genuinely fixes the problem — plus two new, non-blocking
findings:

- **Finding 3:** the 1440×900 test's margin on an 11-char name (`Rodriguinho`) was only ~5%
  (164px glyphs in a 173px box) — real risk of flaking on a Linux CI runner where the
  `-apple-system` font stack falls back to a wider default sans.
- **Finding 4:** `.nextCard .mesa` had no overflow handling — the server's actual maximum table
  label (10 chars) in the narrowest 3-card layout could spill ~14px past the card edge.

Both are one-line CSS/test fixes the reviewer itself prescribed; applied both directly rather than
spawning a third review round for changes the reviewer had already specified verbatim:

- `.nextCard .mesa` gained `max-width: 9vw; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;` — re-verified with the server's real max table label
  (`table: "9999999999"`) at 1440×900: `mesaRight: 424.7` vs `cardRight: 447.3` (inside, was
  `461.1` vs `447.3` — ~14px outside — before the fix).
- `assertNameNotClipped`'s tolerance changed from a flat `+1px` to a 12%-relative bound
  (`clientWidth * 1.12`), documented in the test's own comment with the real headroom numbers that
  motivate 12% specifically (absorbs realistic font-substitution variance; the original bug
  collapsed the box by >90%, so a genuine regression still fails hard).

## Verification (all commands run, real output — every stage re-run after the round-2 changes)

- `npx tsc --noEmit` — clean on the 3 touched files at every stage. Repo has a pre-existing,
  unrelated gap (`__tests__/*.test.ts` missing jest type globals; one pre-existing error in
  `e2e/advance-auth.spec.ts`) — confirmed none of it touches this diff's files.
- `npm test` — **43 suites / 683 tests, all passed** (final run: 1.279s).
- `npm run build` — clean production build, 31 static pages generated (final run, post-merge with
  `origin/main`'s TICKET-66 accent-token change).
- `PORT=3182 npx playwright test e2e/tv.spec.ts` — **7 passed (17.1s)** (final run).
- `PORT=3182 npx playwright test` (full suite, per the deflake note in the ticket about
  TICKET-65's cross-spec history) — **68 passed, 0 skipped, 0 failed (2.8m)** (final run — the repo
  merged in TICKET-66's accent-token PR mid-ticket, which made `e2e/contrast.spec.ts` fully live;
  all 16 contrast tests pass alongside the rest).

Also independently re-verified the round-1 regression test catches the round-2 gap: stashed the
round-2 CSS/TSX changes back out (keeping the round-1 `.join` cap), re-ran the two new TICKET-70
tests — both failed correctly (`Expected: <= 97, Received: 142` and `Expected: <= 74, Received: 127`
on the Estêvão/Fernanda/Rodriguinho assertions), while the pathological-name test still passed.
Restored the fix, all 7 passed again.

## Gates

- **App Tester** (subagent, round 1): captured before/after at 1920x1080 and 1440x900 in
  `work/evidence/TICKET-70/`, confirmed Bruno/Carla/João render in full post-fix. Committed
  `c7d8f58`.
- **Additional evidence (round 2, self-captured via Playwright MCP):**
  `tv-upnext-after-reflow-{1920x1080,1440x900}.png` — Estêvão/Fernanda/Gabriel and
  Leonardo/Rodriguinho/Mariana rendering in full at both widths.
- **Reviewer (opus, clean context, subagent), round 1:** independently re-derived the root cause
  via its own repro (reverting the fix in-page and measuring the column width collapse), tried to
  break the fix with a 64-char room slug + 3 simultaneous long nicknames (held), confirmed scope
  discipline, caught the vacuous-test gap. Verdict: APPROVE-WITH-FOLLOWUPS.
- **Reviewer (opus, clean context, fresh instance), round 2:** independently re-verified the rail
  reflow by measurement (not by trusting the diff), tried to break it, found Findings 3 & 4 above.
  Verdict: APPROVE-WITH-FOLLOWUPS.
- Both findings addressed directly (see above), re-verified with real command output and a targeted
  manual repro of each specific edge case. Final verdict recorded in
  `work/reports/review/TICKET-70-review.md`: **APPROVE**.

## Not in scope (flagged, not fixed)

- Chrome buttons (`Tela cheia`, `Pular`) visually overlap the join card's `poweredBy` line at some
  widths — pre-existing `position: fixed` overlap, unrelated to this ticket.
- A room slug near the 64-char registry cap combined with 3 simultaneous long (24+ char)
  nicknames was stress-tested by the round-1 reviewer and held, but is not asserted in the
  regression suite (would require a dedicated stress test, judged disproportionate to the ticket's
  scope).
