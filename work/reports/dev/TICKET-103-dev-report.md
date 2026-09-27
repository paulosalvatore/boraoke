# TICKET-103 — Dev report: app-owned TV focus state

**Status:** IMPLEMENTED, all gates green, delivered as a draft PR.
**Branch:** `ticket/103-tv-focus` · **Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t103-tv-focus`
**Plan:** `work/plans/TICKET-103-plan.md` · **Step 0 evidence:** `work/reports/testing/TICKET-103-test-report.md`

## Picking up from

Step 0 was already done and committed on this branch; I did not redo it. I built on its two decisive findings:

1. The 4s chrome-hide timer is **not** the Tech Lead's symptom — after it fires, video/meta/rail/QR are all still painted at opacity 1.
2. **YouTube-native fullscreen is reachable despite `fs: 0`** (click into the iframe, press `F`). The iframe becomes the fullscreen element, the video fills the viewport, and nothing of ours composites — including the QR. That is the state that literally matches the TL's report.
3. Baseline: `.video` = 54.7% x 65.0% of a 1920x1080 viewport = **35.6% of its area**, identical in normal, chrome-hidden and app-fullscreen states.

## The product framing this implements

The state the TL liked is an **accident of a YouTube keyboard shortcut**, and that accident is exactly why the QR disappeared — a DOM overlay on top of a fullscreen cross-origin iframe is impossible, not merely hard. So the work is not "put the QR back in that state"; it is to make an equivalent-looking state **ours**, in our own DOM, where the QR and the queue overlay still paint, and to stop the venue from falling into YouTube's version by accident.

## What shipped

### 1. The native-fullscreen hazard is closed (defect)

`TvScreen.tsx` now handles `fullscreenchange` / `webkitfullscreenchange`: if the fullscreen element turns out to be inside the player host, it leaves immediately, reusing the existing `exitFullscreenIfPlayerIsFullscreen` helper (TICKET-89) rather than inventing a second mechanism. TICKET-89 only ran that on the queue-empties transition; this widens it to **every** path — remote, patron, a browser ignoring `fs`, a player created before this shipped.

The redirect deliberately does **not** pair with a `requestFullscreen()` re-entry. Re-entering needs a user gesture, and the gesture that lands us here was spent inside a cross-origin iframe — a fullscreen-based fix would look correct in a harness that grants it and silently no-op in the venue. That constraint is the reason the focus state below is a **CSS class**, not a fullscreen request.

Belt, not braces: the `f`/`F` handler now blurs a focused player iframe first, so the venue's *next* press reaches us. Residual, stated plainly: we cannot stop a cross-origin iframe receiving the *first* keypress. We detect and undo it within one event-loop turn.

`nativeFsRedirects` is surfaced as `data-native-fs-redirects` on `tv-root` — not UI, purely so a redirect that completes in one turn is externally observable and therefore assertable.

### 2. The app-owned focus state (items 1, 2, 4)

**Trigger:** the idle signal the venue already experiences (`chromeVisible === false`) plus a song playing. One idle notion on this surface, not two, and the TL keeps the exact cycle he described ("used the remote, UI showed, then black again") — only now with a far bigger video and a QR that stays.

**Mechanism:** one class on `.tv`. The meta panel and top bar collapse via animatable `max-width` / `max-height`, page padding shrinks, the video takes the whole row, and the rail is lifted out of flow and floated over the video.

**Measured result at 1920x1080** (`work/evidence/TICKET-103/`, captured this branch, same harness and geometry as Step 0):

| State | `.video` box | % of viewport area |
|---|---|---|
| Normal | 1049.9 x 702.3 | **35.6%** (matches Step 0 exactly) |
| Focus | 1862.4 x 1041.6 | **93.6%** |

**2.63x growth.** Step 0 established that no pre-change state gave `.video` more room in any fullscreen state, so all of this is new.

**Item 1 — the QR is always painted.** It is the **same single DOM node** in both states: the join card is repositioned, never unmounted, never put behind an opacity-0 parent, and deliberately not duplicated into a focus-only copy (which is how `tv-powered-by` ended up on two nodes). In the focus state it sits at (1427, 883) 153.6 x 153.6 — inside the video box, on a near-opaque plate, rastered at 240px so it stays crisp at the larger size.

**Item 4 — the timed queue overlay.** Up-next cards fade in after a 3s lead-in on entering focus, stay 6s, hide, and repeat on a 30s cycle. They stay **in layout** throughout and only `opacity` animates, with the overlay right-aligned — so the QR card does not move when the queue appears. That is what makes it read as a composed panel rather than the bottom of the screen jumping.

### 3. Item 3 — QR-on-video: decided by the captures, not by me

The overlay was implemented, captured, and **judged from the screenshots**, which is what the ticket asked for. Two real defects were found that way and fixed before delivery, both visible in the intermediate captures:

- The overlay was pinned to both edges, which marooned the "A SEGUIR" label in the opposite corner from the cards it labels, with the whole screen between them. Fixed by shrink-to-fit (`left: auto`).
- The label was bottom-aligned and read as falling off the screen; and its muted colour vanished against a blown-out sky. Fixed by centring the row and giving the label the same dark plate the cards have.

**Verdict: the on-video placement ships. The reserved-strip fallback is NOT needed.** The composed row (label · card 2 · card 3 · QR) over a near-full-bleed video reads as designed. Evidence: `t103-2-focus-qr-on-video-1080p.png` (resting focus view) and `t103-3-focus-queue-peek-1080p.png` (timed reveal). If the visual gate disagrees, the fallback is one CSS rule — delete the `.focus .rail { position: absolute … }` block and the rail stays in flow as a bottom strip, with zero TSX change. That is why the overlay is a repositioned existing element rather than a new one.

### 4. Wake signals widened (a gap the focus state itself created)

At near-full-bleed the player iframe covers ~97% of the screen, and **pointer events over a cross-origin iframe are delivered to that iframe and never reach us** — so `mousemove`/`pointerdown` alone would have left a venue waving the remote at the video with nothing waking up. `keydown` and window `blur` are now poke signals too. This was found by a test failing, not by inspection; see Friction.

Residual, recorded rather than papered over: a pointer that moves only inside the already-focused iframe still wakes nothing. Judging that needs real webOS hardware — it belongs with the device-validation follow-up the ticket already anticipates, not in this PR.

### 5. Tester friction fixed (`run-app`)

`.claude/skills/run-app/SKILL.md` now carries the warm-every-route-first note, including the implicit `<head>` metadata routes (`/icon.png`, `/apple-icon.png`, `/robots.txt`, `/sitemap.xml`) that wiped Step 0's state twice, plus a note that the focus state must be woken with the **keyboard**, not the mouse.

## Files changed

| File | Change |
|---|---|
| `components/tv/focus-state.ts` | **new** — pure decisions: `focusModeActive`, `shouldRunQueuePeek`, `nextQueuePeekStep` + timing constants |
| `__tests__/tv-focus-state.test.ts` | **new** — 13 unit tests |
| `components/tv/TvScreen.tsx` | focus class, peek timer, fullscreenchange redirect, widened wake signals, QR raster 240 |
| `components/tv/tv.module.css` | `.focus` / `.peek` rules + animatable base properties |
| `components/QrCode.tsx` | placeholder no longer forces its own box when the caller supplies a class |
| `e2e/tv.spec.ts` | 3 new tests + shared measurement helpers |
| `.claude/skills/run-app/SKILL.md` | warm-routes + focus-state notes |
| `work/plans/`, `work/reports/dev/`, `work/evidence/TICKET-103/` | plan, this report, 3 captures |

## Constraint compliance

- **Chrome 68 CSS floor:** only `opacity` / `max-width` / `max-height` animate. No flex `gap`, no `inset` shorthand, no `aspect-ratio`, no fluid-clamping function, no `backdrop-filter`. `check-css-target.mjs` is GREEN on the TV surface. (One trap hit and documented in the file: the gate greps the stylesheet textually and does not skip comments, so naming a banned function in prose fails it.)
- **React does not own the player node:** only classes on `.tv` / `.main` / `.video` change. The host `<div ref>` and the imperatively-created inner node are untouched; the TICKET-82/89 e2e tests that assert no remount and no reload are green, and the new redirect test additionally asserts `created: 1, destroyed: 0` after two redirects.
- **The if-changed queue write is intact:** the peek is a boolean of my own, written at most twice per 30s cycle by a self-scheduling timeout, never a tick. It does not touch `queue`, so `queueItemsEqual` still returns `prev` and the player effect (which depends on `queue`'s identity) does not re-run.
- **testids:** one new id, `tv-rail` (the rail had none). Focus/peek state is asserted via classes on the existing `tv-root`. The `tv-powered-by` wart is left alone.
- **Jest is node-env:** every decision is in a pure module (the `watchdog.ts` / `self-heal.ts` pattern); visual behaviour is Playwright + committed screenshots. No `waitForTimeout` in any new assertion — class-based `toHaveClass` and `expect.poll` throughout.

## Gate results (real output, real counts)

```
$ npm test
Test Suites: 53 passed, 53 total
Tests:       5 skipped, 931 passed, 936 total

$ npm run build          # runs check-bundle-es-target.mjs + check-css-target.mjs
bundle-es-target: OK — all 47 chunk(s) parse at ES2019.
css-target: OK — the TV surface uses nothing newer than Chrome 68 (13 stylesheet(s) scanned).

$ PORT=3103 npx playwright test
109 passed (7.5m)
```

`css-target` also prints 15 **advisory** findings on non-TV stylesheets (phone/desktop/admin). All are pre-existing and none is build-blocking; the strict TV set is clean.

**On the CI-verified-green contract:** `scripts/verify-green-local.sh` is the *framework* repo's Docker harness for its own `md-doctor`/`shell-tests` suites; boraoke has no such script and those suites do not exist here. The product's own gate chain is the four commands above, and all four are green from this worktree. I am not claiming a local-Docker verdict I did not run.

## prove-your-test-can-fail

### (b) Reverse-check — the new unit suite against pre-change behaviour

The module is new, so "run it against the old file" would only produce an import error — a worthless positive control. Instead I substituted a stub implementing the **pre-change behaviour of `/tv`** (no focus state exists; nothing is ever revealed on a timer) and ran the new suite against it:

```
    ✕ is active exactly when the chrome has idled away AND a song is playing (2 ms)
    ✓ is NOT active while the chrome is still showing — activity means the venue is interacting
    ✓ is NOT active on an empty queue, even when idle — the idle poster owns that screen (1 ms)
    ✕ runs inside the focus state when there is something up next
    ✓ does NOT run outside the focus state — the rail is already on screen there
    ✓ does NOT run with an empty up-next list — never flash an empty overlay
    ✕ first transition after entering focus reveals on the SHORT lead-in, not the full period (2 ms)
    ✓ a revealed overlay always schedules its own HIDE — it can never stick
    ✕ later reveals wait out the REMAINDER of the period, so reveal-to-reveal spacing is exactly the period (1 ms)
    ✕ walks a full cycle: hidden -> revealed -> hidden -> revealed, alternating (1 ms)
    ✕ honours caller-supplied timings (the e2e suite drives its own cycle length)
    ✕ clamps a visible window that meets or exceeds the period — the hidden window can never collapse
    ✕ production constants themselves satisfy the never-permanent invariant
Test Suites: 1 failed, 1 total
Tests:       8 failed, 5 passed, 13 total
```

8 of 13 fail. The 5 that pass are the negative-direction assertions (things that were false before and are still false) — expected, and stated rather than glossed.

### (b) Reverse-check — the new e2e tests against the pre-change implementation

`components/tv/TvScreen.tsx`, `tv.module.css` and `QrCode.tsx` restored from `92ec168` (the commit before mine), new tests re-run:

```
  ✘  1 focus state: the video grows, the meta panel collapses, and the QR stays painted ON the video (TICKET-103 items 1-3) (11.8s)
  ✘  2 focus state: the up-next queue reveals on a timer, hides again, and comes back (TICKET-103 item 4) (5.9s)
  ✘  3 YouTube's own fullscreen is caught and redirected out of, so our overlays are never un-paintable (TICKET-103) (6.0s)
    Error: expect(locator).toHaveClass(expected) failed
    Expected pattern: /focus/
    Received string:  "tv_tv__qmayt tv_cursorHidden__4aIfM"
    Error: expect(locator).toBeVisible() failed  [tv-rail]
    Error: expect(locator).toHaveAttribute(expected) failed
    Expected: "0"   Received: ""
  3 failed
```

All three fail, each on the precondition its own feature introduces.

### (a) Which mutation kills each assertion

**Unit suite — 8 mutants, all KILLED** (each run restored to a clean baseline of 13 passed afterwards):

| # | Mutation | Killed |
|---|---|---|
| M1 | `focusModeActive` drops the `hasNowPlaying` conjunct | `is NOT active on an empty queue` (1 failed) |
| M2 | `focusModeActive` loses the negation (`input.chromeVisible &&`) | `is active exactly when…`, `is NOT active while the chrome is still showing` (2 failed) |
| M3 | `shouldRunQueuePeek` uses `>= 0` instead of `> 0` | `does NOT run with an empty up-next list` (1 failed) |
| M4 | `shouldRunQueuePeek` drops the `focusActive` conjunct | `does NOT run outside the focus state` (1 failed) |
| M5 | later reveals wait `periodMs` instead of `periodMs - visibleMs` | 4 failed incl. the reveal-to-reveal spacing property |
| M6 | the `first` lead-in is ignored | `first transition… SHORT lead-in`, `walks a full cycle` (2 failed) |
| M7 | `clampVisibleMs` returns `visibleMs` unconditionally | `clamps a visible window that meets or exceeds the period` (1 failed) |
| M8 | the revealed branch hides after `periodMs` instead of `visibleMs` | 4 failed incl. `a revealed overlay always schedules its own HIDE` |

**E2E — 3 mutants on the load-bearing visual assertions, all KILLED.** These matter more than the unit mutants here, because the ticket's acceptance is visual and a reverse-check that dies at the precondition does not prove the measurements themselves are live:

| # | Mutation (focus class still applied) | Result |
|---|---|---|
| E1 | remove `.focus .meta` collapse | `expect(focusArea / normalArea).toBeGreaterThan(2)` → **Received: 1.58** — FAIL |
| E2 | `.focus .rail { opacity: 0 }` (reproduces the reported "QR gone" symptom) | `expect(await paintedOpacity(qr)).toBe(1)` → **Received: 0** — FAIL |
| E3 | `.focus .rail { position: static }` (i.e. the reserved-strip fallback) | QR-inside-video containment → **Expected: <= 867.8, Received: 1040.6** — FAIL |

E2 is the one worth noting: the assertion that would have caught the TL's actual complaint does catch it, and it catches it because `paintedOpacity` multiplies ancestor opacities rather than using `toBeVisible()` — Playwright calls an `opacity: 0` element visible, which is precisely the wrong instrument for "does the venue see the QR".

### (c) Hollowing-out

**A primitive beneath existing assertions DID change**, so the required declaration is positive, not the verbatim negative:

- **`QrCode`'s placeholder sizing** changed from always-inline `width/height` to class-owned when a `className` is supplied. Assertions that could depend on it: `e2e/tv.spec.ts` has no assertion on the QR's box other than mine, and the only callers passing a `className` are the two TV surfaces, both of which set explicit `width`/`height` in `tv.module.css` (`.qr`, `.idleQr`). The other two callers (`app/new/page.tsx`, `AdminRoom.tsx`) pass **no** className and are on the unchanged branch. Re-examined and unaffected; the full 109-test e2e suite (which covers `/new` and the admin console) is green.
- **The chrome-poke listener set** changed (added `keydown`, `blur`). The existing assertion `chrome auto-hides and the cursor goes with it` (`tv.spec.ts:800`) still wakes the chrome with `page.mouse.move` on the **idle** poster, where there is no player iframe to swallow it — so that assertion is still exercising the mousemove path specifically and has not been made true-by-construction by the new listeners. Verified green unchanged.
- **The `fullscreenchange` handler** changed shape. The TICKET-82/89 assertions that read `document.fullscreenElement === node` do not dispatch `fullscreenchange`, so they never enter the new branch; they are unaffected and still green. The one that *would* be hollowed — a test asserting "the app does nothing when the iframe is fullscreen" — does not exist, and the new redirect test asserts the opposite behaviour explicitly.

### (d) Triggered mutation pass

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`

(`nextQueuePeekStep` is new and pure, but it is a timer-scheduling decision, not parsing or normalising user input on any of those paths. The 8-mutant pass above was run anyway.)

## Friction

- **The unstubbed YouTube embed auto-skips.** The first version of the two focus e2e tests did not stub the player, and the real embed's `onError` auto-skip drained the queue within ~10s — which drops the focus state, which returns the up-next cards to opacity 1, which made `not.toHaveClass(/peek/)` pass for entirely the wrong reason. Step 0's report recorded the same auto-skip behaviour independently. Every long `/tv` test in this file already stubs the player; mine now do too, with the reason written down rather than copied.
- **Pointer events over a cross-origin iframe never reach the app.** This cost two debugging rounds and was a *product* bug hiding inside a test failure, not a harness quirk: the baseline "keep the chrome awake" poke was a `page.mouse.move` at the screen centre, which is inside the player iframe, so the poke silently did nothing and the "normal" baseline was measured in the focus state. It passed when the file ran alone and failed in the full suite, purely on machine speed. The fix in the test (use a key) and the fix in the product (listen for `keydown` + `blur`) are the same insight.
- **`check-css-target.mjs` greps the stylesheet textually and does not skip comments.** Writing the banned function's name in a block comment explaining why it is banned fails the gate. Correct trade for a gate that must never miss a real use, but worth knowing before it costs a build.
- **The `.chrome` button bar overlaps the join card in the NORMAL state** at 1920x1080 (visible in `t103-1-normal-1080p.png`, bottom-right: "Pular"/"Tela cheia" sit on top of the QR card's text). **Pre-existing, not introduced here** — `.chrome` is `position: fixed` bottom-right and the rail's join card occupies the same corner — and out of this ticket's scope, but it is a real 10-foot-UI defect and someone should file it. It does not affect the focus state, where the chrome is hidden by definition.

## Open items for the Tech Manager

1. **Device validation remains open and is not provable headless.** Whether the TV's own rest/screensaver mode preserves these overlays needs the real LG hardware. The ticket already anticipates this as a follow-up; it should be filed explicitly rather than left implied. The LG model / webOS version is still load-bearing and still unknown.
2. **The residual iframe-pointer gap** (a pointer moving only inside the focused iframe wakes nothing) belongs with that same device-validation follow-up.
3. **No product decision was taken on the TL's behalf.** Item 3 was decided by the captured evidence as the ticket instructed; if the visual gate reads the overlay differently, the fallback is one CSS rule.
