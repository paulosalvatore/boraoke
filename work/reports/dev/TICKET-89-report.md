# TICKET-89 — Dev report: fullscreen across the idle gap

- **Branch:** `ticket/89-fullscreen-idle-transition`
- **Base:** `f515987` (origin/main)
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-89`
- **Dev server:** PORT=3197, `ADVANCE_AUTH=enforce`
- **Outcome:** implemented (the investigation changed what the fix had to be)

## Headline: the premise in TICKET-82's N4 is wrong, and the real behaviour is worse

TICKET-82's review recorded, as accepted follow-up N4, that `display: none` on `.main` would make a fullscreen player "drop out of fullscreen", and TICKET-89 was filed on that basis — a venue annoyance where someone has to walk over and re-enter fullscreen.

Measured against real Chromium, both headless and headed, that is not what happens:

> `display: none` on the fullscreen element — **or on any ancestor of it** — does **not** exit fullscreen. The element collapses to a **0×0 box**. The document stays fullscreen and paints nothing.

So the venue does not get "a TV that fell out of fullscreen". It gets **a black fullscreen screen for the entire gap between singers**, with the recruitment QR poster rendered but unreachable behind the still-fullscreen (and now invisible) player. Nobody can scan it, and the only exit is a human pressing Esc. That is a kiosk defect, not a cosmetic rough edge, and it reproduces in the real app (see the negative control below).

Evidence: `work/evidence/TICKET-89/fullscreen-probe-chromium.json` and `fullscreen-probe-headed.json`, probes **A** (hide the fullscreen element itself) and **B** (hide an ancestor) — both `"exited": false`, both with a `0×0` `fullscreenElementBox`. The probe script is committed (`fullscreen-probe.mjs`) and re-runnable.

## Which fullscreen, though — this is the whole crux

There are two different fullscreen elements in play, and they behave oppositely:

| How the venue entered fullscreen | Fullscreen element | Survives the idle transition? |
|---|---|---|
| The screen's own affordance — the "Tela cheia" button or `F` | `document.documentElement` | **Yes, perfectly.** Probe **D**: hiding a descendant cannot affect it. The idle poster shows *in* fullscreen. |
| YouTube's own fullscreen button inside the embed (`controls: 1`) | the `<iframe>`, which lives inside `.main` | **No** — this is the black-0×0 state above. |
| The browser's own F11 | not the Fullscreen API at all | Unaffected. |

The ticket's venue scenario ("a bar sets the TV to fullscreen at the start of the night") therefore **already worked** on the affordance the product actually ships. The broken path is YouTube's control, which the product never intended to be the venue's fullscreen mechanism.

## The Fullscreen API constraints that shaped the fix

1. **Re-entering fullscreen requires a user gesture; exiting does not.** The ticket floated "detect the exit and proactively re-request fullscreen". Beyond being unnecessary once you know fullscreen is never actually lost, it is **unverifiable in our harness**: `work/evidence/TICKET-89/activation-probe-headed.json`, probe **H0**, shows `requestFullscreen()` resolving on a page that has **never been clicked**. Playwright bypasses the activation requirement, so a gesture-dependent fix would look green here and silently no-op on a real kiosk. I refused to build on it. `exitFullscreen()` has no activation requirement, so the fix uses only that direction.
2. **`visibility: hidden` and `opacity: 0` are not the answer either.** Probe **E**: an ancestor with `visibility: hidden` keeps the fullscreen element at full size and *still fullscreen* — so it would paint a hidden-but-present player, which is the same black screen by another route, and it does nothing the current code needs.
3. **Hiding never silences media.** Probe **G**, real Chromium: after both `display: none` and `visibility: hidden` on an ancestor, the media element reports `paused: false` with `currentTime` advancing. Any "keep it visible so fullscreen survives" approach must therefore stop the media explicitly or it leaks audio over an empty room — much worse than losing fullscreen. The existing `stopVideo()` call is what makes the idle screen silent; it is load-bearing, not a formality, and it is now asserted by a test instead of assumed.
4. **Rendering the idle poster inside the still-fullscreen container does not work for the iframe case.** The fullscreen element is the *cross-origin YouTube iframe*; we cannot render into it, and a fullscreen element is in the top layer, so no z-index of ours can appear over it. That option is only available for the `documentElement` case — where it already happens for free.

## The fix

Two parts, in `components/tv/TvScreen.tsx` only. `tv.module.css` is untouched, so the TICKET-82 parking mechanism and the TICKET-70 rail layout are byte-identical.

**1. `fs: 0` in `playerVars`** — build the embed without YouTube's own fullscreen control, so the iframe cannot become the fullscreen element through the UI. This removes a strictly worse control rather than a capability: the screen's own affordance gives the venue fullscreen that survives the idle gap *and* keeps showing the recruitment poster.

**2. A defensive exit at the idle transition** — `exitFullscreenIfPlayerIsFullscreen(host)`, called in the player effect's `!nowVideoId` branch (the exact idle transition, which is also where `stopVideo()` already lives). If `document.fullscreenElement` is inside the player host, leave fullscreen deliberately. `host.contains()` is what separates the two cases: true for our player's iframe, false for `documentElement` — so it **never** cancels the venue's own fullscreen. This covers anything that reaches the bad state despite `fs: 0` (a double-click, a browser that ignores `fs`, a player created before this shipped), turning black-limbo into a visible idle poster with the fullscreen button back on screen.

The effect runs once per idle transition: the queue write is if-changed (TICKET-62), so a static empty queue does not re-fire it, and the fix cannot fight a venue that deliberately re-enters fullscreen.

### Why not "just keep `.main` laid out and overlay the poster"

Considered and rejected. It preserves iframe-fullscreen, but during idle the top layer still shows the stopped YouTube frame and the QR poster stays unreachable — so the venue keeps fullscreen at the cost of the recruitment surface that the idle state exists for. Funnelling onto the app's own fullscreen gets both, with a smaller diff and no CSS/layout risk to TICKET-70.

## TICKET-82 is not reintroduced

The player is still mounted for the component's whole life and the iframe is never unmounted. Nothing in the diff touches the host, the create path, the liveness guard, or `.mainHidden`. The two TICKET-89 tests re-assert TICKET-82's own contract inline (`sameNode`, `destroyed === 0`, `loaded === ["oHg5SJYRHA0"]` after refill), and TICKET-82's three tests were re-run green.

## Verification

**Negative control** — the fix reverted (`git checkout f515987 -- components/tv/TvScreen.tsx`), tests kept:

```
PORT=3197 npx playwright test e2e/tv.spec.ts --grep "black 0x0" --reporter=list --timeout 120000

  ✘  1 … a YouTube-fullscreened player never leaves a black 0x0 fullscreen while idle (TICKET-89) (19.7s)

    Error: expect(received).toMatchObject(expected)
      - Expected  - 1        + Received  + 4
    -   "fs": 0,
    +   "autoplay": 1, "controls": 1, "playsinline": 1, "rel": 0,
    > 761 |     expect.soft((await fullscreenSnapshot(page)).vars).toMatchObject({ fs: 0 });

    Error: expect(received).toBe(expected) // Object.is equality
    Expected: false
    Received: true
    > 780 |     expect(blackFullscreen).toBe(false);
```

`blackFullscreen === true` at base is the defect reproducing **in the real app**, not just in the standalone probe. The `fs: 0` assertion is deliberately `expect.soft` so it cannot abort the run before that behavioural assertion — a hard assert there masked it on the first negative-control run, and the behavioural line is the one that encodes the bug.

**Honest note on the other two tests:** "fullscreen survives the queue emptying and refilling" and "an idle screen is SILENT" both **pass at base**. They are guard rails, not proof — the `documentElement` path already survived, and `stopVideo()` already existed. Their value is forward-looking: they lock in that a future change cannot start hiding the wrong element, and cannot adopt a "keep it visible" approach that leaks audio. Read only the black-0×0 test as proof of this fix.

**Fixed state:**

```
PORT=3197 npx playwright test e2e/tv.spec.ts --grep "TICKET-89|TICKET-82|TICKET-70" --reporter=list --timeout 120000
  8 passed, 1 failed (4.2m)
```

The one failure was `TICKET-70 › a pathologically long nickname degrades gracefully` with `scrollWidth: 0, clientWidth: 0` — a node with no layout box, i.e. a not-yet-rendered element under load, and the diff cannot reach the rail (different subtree, CSS untouched). Re-run in isolation:

```
PORT=3197 npx playwright test e2e/tv.spec.ts --grep "TICKET-70" --reporter=list --timeout 120000
  ✓ 1 … realistic Brazilian nicknames render in full on a long room slug (34.2s)
  ✓ 2 … an 11-char Brazilian nickname still fits at 1440x900 (36.6s)
  ✓ 3 … a pathologically long nickname degrades gracefully (24.5s)
  3 passed (2.4m)
```

**Jest:** `npm test` → **45 suites / 788 tests passed**, 27.5s.

**tsc:** `npx tsc --noEmit` — **2487 errors at base, 2487 at HEAD, byte-identical sets (`diff` empty)**. All pre-existing: `@types/jest` is not installed so every `__tests__/*.ts` reports `Cannot find name 'jest'/'expect'/'it'`, plus one pre-existing `e2e/advance-auth.spec.ts` `method` property error. **Zero delta from this diff.**

**Timeouts:** the suite needs `--timeout 120000` on this machine. Four sibling ticket worktrees are running concurrently and the Next dev server compiles routes on demand; at the default 30s the failures were `page.goto` / `apiResponse.json` timeouts whose identity **shifted between identical runs** (blackfs passed in one run and failed at a trailing `drainQueue` in the next). That is contention, not the diff. Once routes were warm and the timeout raised, runs were stable.

## Scope

```
components/tv/TvScreen.tsx
e2e/tv.spec.ts
work/tickets/TICKET-89-fullscreen-idle-transition.md
work/reports/dev/TICKET-89-report.md
work/evidence/TICKET-89/**
```

No sibling-owned path touched: `app/(patron)/[room]/tv/page.tsx`, `app/layout.tsx`, `app/(patron)/[room]/page.tsx`, `lib/youtube-search.ts`, `app/api/search/route.ts`, `e2e/rotation-modes.spec.ts`, `e2e/render-and-links.spec.ts`, `e2e/helpers.ts` are all unmodified. `components/tv/tv.module.css` and `components/tv/self-heal.ts` were in scope but needed no change.

## Follow-ups worth filing

- **`fs: 0` cannot be verified against the real YouTube embed here.** Our stub ignores playerVars, so the test asserts we *asked* for `fs: 0`, not that YouTube honours it. Double-clicking a real YT player is a second route into iframe fullscreen and may not respect `fs`. Part 2 of the fix is exactly why that is not load-bearing — but a real-embed manual check at a venue night would close it properly.
- **TICKET-82's N4 should be corrected in the record**, since it is cited as an accepted tradeoff and is factually wrong about what browsers do. This ticket's file has been updated; the TICKET-82 review is left as the historical document it is.
