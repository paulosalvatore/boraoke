# TICKET-103 — Plan: app-owned TV focus state

**Author:** Dev · **Date:** 2026-09-27 · **Branch:** `ticket/103-tv-focus` · **Worktree:** `.worktrees/t103-tv-focus`
**APPROVED-BY:** auto-approved (no plan-gate escalation) — validated downstream by gates + TL merge of PR #83

Step 0 is done (`work/reports/testing/TICKET-103-test-report.md`). This plan builds on its two decisive findings and does not re-derive them.

## The premise I am building on

1. The 4s chrome-hide timer is **not** the Tech Lead's symptom — after it fires, video/meta/rail/QR are all still painted at opacity 1 (measured at 1920x1080). Only the Skip/Fullscreen button pair fades.
2. **YouTube-native fullscreen is reachable despite `fs: 0`** (click inside the iframe to focus it, then `F`). The iframe becomes the fullscreen element, the video fills the viewport, and **nothing of ours composites — including the QR**. That is the state that literally matches the TL's report, and it is why the QR vanished.
3. `.video` is **54.7% x 65.0% of the viewport (35.6% of area)** in the normal, chrome-hidden AND app-fullscreen states alike. App (`documentElement`) fullscreen reclaims zero space today.

The product insight: the state the TL liked is an **accident of a YouTube keyboard shortcut**, and that accident is exactly why the QR disappeared. This ticket makes that state **ours**.

## Approach

### 1. Close the native-fullscreen hazard (defect, not theory)

`fs: 0` removes the *button*; it does not remove the *keyboard shortcut*, and a patron or a webOS remote reaches it by accident. While the iframe is the fullscreen element we cannot paint anything, so brief items 1 and 3 are undeliverable in that state.

Follow the existing precedent rather than invent: `exitFullscreenIfPlayerIsFullscreen` (`TvScreen.tsx:185-199`) already performs exactly this escape when the queue empties. Widen it from "on the idle transition" to "whenever it happens":

- Handle `fullscreenchange` / `webkitfullscreenchange`: if the fullscreen element is inside `playerHostRef`, exit it immediately. `exitFullscreen()` needs **no user gesture**, so this always works (the TICKET-89 comment already establishes that, and establishes that *re*-entering fullscreen does need one, which is why we do not try).
- **The redirect target must therefore not be a real fullscreen request.** That is the design constraint that shapes item 2 below: the focus state is **pure CSS**, driven by a class, so redirecting into it needs no gesture and cannot silently no-op in the field. This is strictly better than the TICKET-89 posture, which could only *exit* and leave the venue in the ordinary small-video layout.
- Also blur a focused player iframe on our own `f`/`F` handler, so a second keypress reaches us rather than YouTube. This is belt, not braces — the `fullscreenchange` redirect is the actual closure, and it covers every path (double-click, a browser ignoring `fs`, a remote, a player created before this ships).

Residual, stated honestly: we cannot *prevent* the first keypress from being delivered to a cross-origin iframe. We detect and undo it within one event-loop turn.

### 2. The app-owned focus state (brief items 1, 2, 4)

**Trigger:** reuse the signal the TL already experiences — `pokeChrome`'s idle window. Focus state is active when `chromeVisible === false` **and** a song is playing. Pointer/remote activity brings everything back, exactly as he described ("used the remote, UI showed"). No new timer, no new idle concept.

**Mechanism: one class on `.tv` (`.focus`), all layout in CSS.** No React re-render of the player node, no `requestFullscreen`.

| Element | Normal | Focus |
|---|---|---|
| `.topBar` | visible | `opacity: 0` + `max-height: 0` (space reclaimed, transitionable) |
| `.meta` | `flex: 1` (~36vw) | `opacity: 0` + `max-width: 0` (space reclaimed, transitionable) |
| `.video` | `flex: 1.5` beside `.meta` | takes the whole `.main` row |
| `.tv` padding | `2.5vw 3vw` | `1vw 1.5vw` (more room again) |
| `.rail` | in flow at the bottom | `position: absolute` overlay, bottom-right, over the video |
| `.join` (QR) | in the rail | **still in the rail — one node, always painted** |
| `.nextCard` / `.railLabel` | visible | `opacity: 0`, revealed on the peek timer |

Two things this buys deliberately:

- **The QR is the same single DOM node in both states** (item 1). It is never conditionally unmounted, never behind an opacity-0 parent, and is not duplicated — so there is no second `tv-powered-by`-style wart, and no state where one copy is painted and the other is not.
- **The reserved-strip fallback (item 3) is one CSS rule block.** If the captured evidence says on-video reads badly, remove `.focus .rail { position: absolute … }` and the rail stays in flow as a bottom strip; nothing in TSX changes. That is the whole point of putting the placement in CSS on an element that already exists.

**Expected video size:** `.main` becomes ~94vw x ~90vh instead of 54.7% x 65.0% — i.e. roughly **35.6% -> ~80% of viewport area** (item 2). Exact measurement goes in the dev report from the real capture, not asserted here.

**Item 4 — the timed queue overlay.** In focus mode the up-next cards fade in for a window, then fade out, on a cycle. They stay **in layout** the whole time (only `opacity` animates) with the rail right-aligned, so the QR card never moves when they appear — that is what makes it read as intentional rather than as a glitch. Timings: a short lead-in after entering focus (so a venue actually sees it happen), then a long hidden window and a short visible one.

### 3. Tester friction fix (in scope, boraoke's own skill)

Step 0 lost state twice to the in-memory store resetting on a route's **first compile** — once to `/apple-icon.png`, an implicit `<head>` metadata route nobody navigates to on purpose. The Playwright suite already sidesteps this via `warmTvRoutes`; an interactive tester has no such helper. Add the warm-every-route-including-implicit-metadata-routes note to `.claude/skills/run-app/SKILL.md`.

## Files touched

| File | Change |
|---|---|
| `components/tv/focus-state.ts` | **new** — pure decision helpers (focus-active, queue-peek scheduling) |
| `__tests__/tv-focus-state.test.ts` | **new** — unit suite for the above |
| `components/tv/TvScreen.tsx` | focus class, queue-peek timer, `fullscreenchange` redirect, QR raster size |
| `components/tv/tv.module.css` | `.focus` / `.peek` rules, transitionable base properties |
| `e2e/tv.spec.ts` | focus-state visual/measurement test, queue-peek timing test, native-fullscreen-redirect test |
| `.claude/skills/run-app/SKILL.md` | warm-routes note |
| `work/plans/`, `work/reports/dev/`, `work/evidence/TICKET-103/` | plan, report, screenshots |

## Risks and how each is handled

| Risk | Handling |
|---|---|
| Chrome 68 CSS floor regression | No flex `gap`, no `inset` shorthand, no `aspect-ratio`, no `clamp()`, no `backdrop-filter`. `npm run check:css-target` is a gate. Transitions use `opacity` / `max-width` / `max-height` only — all pre-Chrome-68. |
| React remounting the player node | Only classes on `.tv` / `.main` / `.video` change. The player host `<div ref>` and the imperatively-created inner node are untouched, so `loadVideoById` is never re-reached and the iframe never remounts. The existing TICKET-82/89 e2e tests cover this and must stay green. |
| Defeating the if-changed queue write | The peek timer toggles a **boolean of my own**, at most twice per cycle. `queueItemsEqual` still returns `prev`, so `queue`'s identity is unchanged and the player effect (which depends on `queue`) does not re-run. No tick/interval-driven re-render. |
| `testid` collisions | New ids only, `tv-`-prefixed kebab-case. The rail gets `tv-rail` (it has none today); the focus state is asserted via the class on the existing `tv-root`. Existing `tv-powered-by` wart left alone. |
| Jest is node-env (no jsdom) | All decision logic lives in `focus-state.ts` as pure functions (the `watchdog.ts` / `self-heal.ts` pattern). Visual behaviour is proven by Playwright + committed screenshots, with class-based web-first polling — never `waitForTimeout`. |
| A timed e2e test racing the cycle | Assertions poll classes with a bounded `toHaveClass` timeout, and the test raises its own `test.setTimeout` explicitly rather than trimming the product timings to suit the test. |

## Test strategy

- **Unit (`focus-state.ts`)**: focus-active truth table; the peek cycle's lead-in/hidden/visible step sequence; the guard that suppresses the cycle with nothing upcoming; clamping when a caller passes a visible window >= the period. Both `prove-your-test-can-fail` instruments run, with verbatim output in the dev report.
- **E2E**: (a) focus state — `tv-root` gains `focus`, `.meta` collapses, QR still painted at opacity 1 with a non-zero box, and `.video` area is materially larger than the same measurement in the normal state (measured in-test, both states, same page); (b) queue peek — the rail's cards go visible then hidden again on the cycle, polled by class; (c) the redirect — with `fullscreenElement` stubbed to the player iframe, `exitFullscreen` is called.
- **Gates**: `npm test`, `npm run test:e2e`, `npm run check:es-target`, `npm run check:css-target`.
- **Evidence**: focus-state screenshots at 1920x1080 (QR-on-video, peek visible, peek hidden) committed to `work/evidence/TICKET-103/`, because item 3 is decided by captured evidence, not by my judgment.

## Product decision NOT taken here

Item 3's on-video-vs-reserved-strip call is deliberately left to the evidence. I implement the overlay, capture it, and report; if it reads badly the fallback is the one-rule change above. I do not silently pick the fallback to be safe, and I do not declare the overlay good because I wrote it.
