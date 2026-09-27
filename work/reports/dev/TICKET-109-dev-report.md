# TICKET-109 — Dev report: chrome buttons overlap the join card at TV geometry

- **Date:** 2026-09-27 · **Role:** Dev · **Branch:** `ticket/109-chrome-overlap` ·
  **Worktree:** `.worktrees/t109-chrome-overlap` · **App port:** 3095

## Status: implemented, self-verified, gates green — ready for testing/reviewer gate

## Diagnosis

Read the committed evidence first, per the ticket: `work/evidence/TICKET-103/t103-1-normal-1080p.png`
clearly shows the "Pular"/"Tela cheia" chrome buttons sitting directly on top of the join card's
QR/text at 1920x1080.

Root cause, from `components/tv/tv.module.css` and `components/tv/TvScreen.tsx`:

- `.chrome` (the auto-hiding skip/fullscreen bar, `TvScreen.tsx` ~line 1163) is
  `position: fixed; right: 3vw; bottom: 2.5vw` — an overlay independent of `.tv`'s
  own flex column flow.
- `.rail` (up-next cards + the join/QR card, `data-testid="tv-rail"`) is the LAST
  item in that flow, and `.tv`'s base padding was symmetric: `padding: 2.5vw 3vw`.
  That means the rail's bottom edge sits flush with the exact same 2.5vw inner
  edge `.chrome` floats in — the two z-index-stacked layers (`.chrome` z-index 10)
  collide squarely on the join card, in the state (normal, non-focus) the TV
  spends most of its time in.
- Confirmed pre-existing, not a TICKET-103 regression — the collision is purely
  between `.chrome` and `.rail`/`.join`, neither of which TICKET-103 touched.

## Fix

`components/tv/tv.module.css`: widened `.tv`'s bottom padding only, `2.5vw 3vw` →
`2.5vw 3vw 7vw 3vw` (top/right/bottom/left longhand values inside the existing
`padding` shorthand — not the banned `inset` shorthand, which is a different,
unrelated property). This reserves a clear strip above the rail the height of
`.chrome`'s own rendered footprint (~3.3vw) plus a margin, so the rail's bottom
edge clears `.chrome`'s top edge instead of sitting behind it. Documented inline
with a comment explaining the asymmetry and why it's normal-state only.

Why this doesn't touch the focus state: `.focus`'s own `padding: 1vw 1.5vw` rule
(TICKET-103, later in the same file, applied to the same element since `.tv` and
`.focus` are both plain classes on `TvScreen`'s root div — not a descendant
selector) overrides **all four sides** of `.tv`'s padding shorthand outright by
CSS cascade (later rule, equal specificity, wins). So this change is inert
whenever `.focus` is present, which is exactly what's wanted — focus already
repositions `.rail` into its own absolute overlay via `.focus .rail`, untouched
by this edit.

Why not move `.chrome` itself: moving it up (larger `bottom` offset) to clear the
rail would land it squarely over `.meta`'s text column instead (hero title/singer
line/mic-call banner, which share the same right-edge anchor) — trading one
collision for a new one. Reserving space in `.tv`'s own flow lets `.main` (video +
meta, `flex: 1`) absorb the reduction proportionally with zero new overlap risk.

## Why vw-only holds across resolutions

All three ticket-mandated resolutions (1280x720, 1920x1080, 3840x2160) share the
same 16:9 aspect ratio, so every `vw`-relative value in this file scales
identically across all of them — a fix proven at one holds at all three. Verified
this empirically rather than assuming it (see Evidence below).

## Reproduction technique (Friction — feeds a skill-improvement note)

The in-memory queue store drains almost immediately once a song reaches
`nowPlaying` in this sandboxed environment — the YouTube player errors out fast
(headless, no real playback) and the watchdog's `isFatalPlayerError` path
auto-`advance`s through the entire seeded queue within 1-3 seconds, even with
**zero** browser/Playwright MCP involvement (confirmed with a pure-curl seed +
poll loop). This is on top of the documented "route recompile wipes the
in-memory store" hazard the `run-app` skill already warns about. Seeding 20-30
songs at once and capturing immediately (single navigate + screenshot, no
intermediate delay) was the reliable workaround. The real Playwright e2e harness
(`e2e/tv.spec.ts`) does **not** exhibit this — its existing tests seed 3-4 songs
and assert against them with 10s timeouts with zero flakiness, so whatever
reaches youtube.com in this interactive sandbox session evidently isn't reachable
from the Playwright test runner's own browser context. Noting this as friction in
case it bites the next tester doing ad-hoc (non-e2e-harness) manual verification
here.

## Evidence

All at `work/evidence/TICKET-109/`:

- `before-normal-{720p,1080p,4k}.png` — reproduces the reported overlap at all
  three ticket resolutions (not just 1080p).
- `after-normal-{720p,1080p,4k}.png` — same three resolutions post-fix; chrome
  buttons now sit below the join card with a clear visible gap at every size.
- `before-focus-1080p.png` / `after-focus-1080p.png` — focus state (idle-triggered,
  `.focus.peek` active, real `nowPlaying`), confirming it renders unchanged. Note:
  while genuinely idle (which is the ONLY time `.focus` is active, since
  `focusModeActive = !chromeVisible && hasNowPlaying`), `.chrome` also carries
  `.chromeHidden` (`opacity: 0; pointer-events: none`) — so even though their
  LAYOUT boxes still geometrically overlap in that state (unchanged by this
  diff — confirmed via `git diff` touching only the base `.tv` padding, nothing
  under the `.focus` section), there is no VISIBLE or interactive collision,
  because the invisible element can never be seen or clicked. This is
  pre-existing (identical before and after this change) and out of this
  ticket's scope; not fixed here.

## Tests

**New regression test** — `e2e/tv.spec.ts`, `"chrome buttons never overlap the
join/QR card in the normal state at TV geometry (TICKET-109)"` (after the existing
"chrome auto-hides..." test, before the TICKET-103 focus-state block). Seeds a
normal show via the existing `seedShow` helper, asserts `tv-chrome` is visible,
then asserts its bounding box does not intersect `tv-powered-by`'s bounding box.
Runs at the file's existing 1920x1080 `test.use` viewport.

**Prove-your-test-can-fail (mandatory declaration):**

(a) **Mutation that kills the assertion:** reverting the fix (`.tv`'s padding back
to the pre-fix `2.5vw 3vw`) is itself the mutation — it's the literal bug this
ticket fixes, so it's the most direct and honest mutant to test against.

(b) **Verbatim failure against the pre-fix implementation** — `git stash push --
components/tv/tv.module.css` (isolating the CSS revert from the new test, which
stayed), then ran only the new test:

```
Running 1 test using 1 worker

  ✘  1 [chromium] › e2e/tv.spec.ts:824:7 › /tv › chrome buttons never overlap the join/QR card in the normal state at TV geometry (TICKET-109) (1.5s)


  1) [chromium] › e2e/tv.spec.ts:824:7 › /tv › chrome buttons never overlap the join/QR card in the normal state at TV geometry (TICKET-109)

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      850 |         chromeBox.y < joinBox.y + joinBox.height &&
      851 |         chromeBox.y + chromeBox.height > joinBox.y;
    > 852 |       expect(intersects).toBe(false);
          |                          ^
      853 |     }
      854 |
      855 |     await drainQueue(page.request);
        at /Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t109-chrome-overlap/e2e/tv.spec.ts:852:26

  1 failed
```

Then `git stash pop` to restore the fix, re-ran: **1 passed**. Not a vacuous test —
it genuinely distinguishes fixed from broken.

(c) **Hollowing-out:** `no primitive beneath existing assertions changed` — this
diff only widens one padding value; no primitive (parsing/measurement/comparison
function) that any existing assertion depends on was touched.

(d) **Triggered mutation pass:** `triggered mutation pass: not triggered — no new
parsing/normalisation function on a money/quantity/identity path` — this change is
CSS + a geometry assertion using `boundingBox()`, no new pure function.

**Full suite runs (all against the fixed code, fresh dev server on port 3095):**

- `e2e/tv.spec.ts` alone: **17/17 passed** (1.6m), including both TICKET-103
  focus-state tests (`focus state: the video grows...` and `focus state: the
  up-next queue reveals...`) — confirms no regression to focus behavior.
- `npm test` (Jest, node-env, no jsdom — per repo convention, layout isn't unit
  tested here): **53 suites, 931 passed, 5 skipped (pre-existing), 0 failed.**
- `npm run build` (which chains `next build` → `check-bundle-es-target.mjs` →
  `check-css-target.mjs`):
  - `bundle-es-target: OK — all 64 chunk(s) parse at ES2019.`
  - `css-target: OK — the TV surface uses nothing newer than Chrome 68 (13
    stylesheet(s) scanned).` (The 15 "advisory" findings listed alongside it are
    pre-existing, in phone/desktop stylesheets this ticket never touched —
    `app/page.module.css`, the admin/analytics modules, `FeedbackWidget`, etc. —
    not build-blocking and unrelated to `tv.module.css`.)

One transient failure was observed on an EARLIER full-file run of `e2e/tv.spec.ts`
(`playing state: hero scale...` got `"Como Nossos Pais"` instead of the expected
`"Garota de Ipanema"`) — traced to leftover queue state from my own manual
curl-seeding of the SAME dev server earlier in the session (I'd been seeding
20-30 songs at a time into the `default` room to fight the auto-drain described
above). Re-ran that single test in isolation immediately after: passed. Re-ran
the full file again against a freshly restarted dev server: **17/17 passed**,
no flake. Not a product or test defect — noting it here per the "prose is not
proof" contract rather than omitting it.

**Full repo-wide `npx playwright test` (all spec files, not just `tv.spec.ts`)**
first came back **106 passed / 4 failed** — 2 in `e2e/advance-auth.spec.ts`, 2 in
`e2e/tv-watchdog.spec.ts`, none in `tv.spec.ts` and none touching anything this
diff changed. Root-caused rather than waved away (per "verify before relaying"):

- **`advance-auth.spec.ts` (2 failures):** Playwright's own `webServer` sets
  `ADVANCE_AUTH=enforce`, but `reuseExistingServer: !process.env.CI` (true
  locally) meant it reused my already-running manual dev server on port 3095,
  which I'd started plainly (`npx next dev -p 3095`, no env override) — so
  enforcement was off and the 401-rejection assertions failed. Killed my manual
  server and re-ran: **4/4 passed** (Playwright spawned its own server with the
  correct env this time).
- **`tv-watchdog.spec.ts` (2 failures, one being the slow 75s-budget "recreate
  rung" test):** re-ran in isolation, still failed on THIS worktree, passed
  cleanly on a disposable detached worktree checked out at the immediate parent
  commit (`git worktree add --detach /tmp/... a727995`, same node_modules via
  symlink). That looked like it might implicate the diff — so I went further:
  copied the PARENT commit's `tv.module.css` byte-for-byte onto this worktree
  (fully reverting the one line this ticket changes) and re-ran the SAME failing
  test on THIS worktree: **it still failed**, proving the CSS change is not the
  cause. Narrowed further by port: the failure was tied to port 3095 specifically
  (used continuously for ~2 hours of manual testing this session) — a stale
  `/tmp/boraoke-ls-3095.json` (the Node `--localstorage-file` polyfill Next
  needs for SSR `localStorage`, keyed per-port by `playwright.config.ts`) was
  the actual variable. Re-ran the same test, same worktree, same (restored) fix,
  on a never-before-used port (3097): **passed cleanly (43.3s)**. Confirmed:
  this was 100% an artifact of my own hours of manual ad-hoc testing on a reused
  port/state-file, not a regression from this diff. Final full-suite run used a
  fresh port (3098) with no prior state file — see below.

**Final clean full-suite run** (`PORT=3098`, no prior localStorage file, no
manually-run server for Playwright to accidentally reuse):

```
110 passed (6.6m)
```

All specs green, including all 17 in `tv.spec.ts` and both previously-flaky
`tv-watchdog.spec.ts` tests. This is the number the gates checklist reflects.

## Gate note

This repo (`boraoke`) has no `scripts/verify-green-local.sh` / Docker-gate wrapper
— its gate chain, per the ticket, is `npm test`, `npm run test:e2e`, the ES2019
bundle check, and `scripts/check-css-target.mjs`, all four of which were run
directly above with verbatim output captured (macOS, not a clean-Debian
container — flagging that distinction explicitly per "prose is not proof" rather
than rounding up to an unqualified "green").

## Friction

- See "Reproduction technique" above — the fast auto-drain of the in-memory queue
  in this sandbox (both via headless-Chromium watchdog skips AND, per the
  existing `run-app` skill warning, via dev-server route recompiles) makes ad-hoc
  manual capture significantly harder than the documented warm-up alone suggests.
  Worth a skill-improvement note for future manual TV testers in this repo: seed
  generously (20+ songs) and capture in a single navigate+screenshot burst rather
  than the documented 3-song seed.

## Not fixed here (out of scope, documented for the record)

The focus-state `.chrome`/`.join` bounding-box overlap noted under Evidence above
is real but harmless (the overlapping chrome is always `opacity: 0` +
`pointer-events: none` whenever focus is active, by construction —
`focusModeActive = !chromeVisible && hasNowPlaying`) and pre-existing
(unaffected by this diff). Not filing a separate ticket unilaterally per house
process — flagging it here for the TM to triage since it might be worth a
tracking ticket for someone who later loosens that hidden/active coupling.
