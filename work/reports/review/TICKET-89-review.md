# TICKET-89 — Reviewer report (D-022 opus gate)

- **Branch:** `ticket/89-fullscreen-idle-transition`
- **Base:** `f515987`
- **HEAD:** `40d491d1a76f7d3419f6e6a8628dcdf1f8225b06`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-89`
- **Dev server:** `http://127.0.0.1:3197` (`ADVANCE_AUTH=enforce`)

## Verdict

**APPROVE WITH NITS** — no blocking findings. The central factual claim is true (I re-derived it from scratch), TICKET-82 is not reintroduced, the idle path is genuinely silent, and the negative control is exactly as honestly described in the dev report.

---

## 1. The central factual claim — independently re-derived, and TRUE

I did **not** rely on the committed probe JSONs. I wrote my own minimal probe outside the repo (plain `<div><div><iframe>` + a `fullscreenchange` recorder, headless Chromium via the worktree's own Playwright) and measured:

```
A_before  { fs: "fr",   box: {w:1280,h:720}, log: ["fr"] }     // iframe fullscreen
A_after   { fs: "fr",   box: {w:0,h:0},      log: ["fr"] }     // display:none ON the fs element
B_before  { fs: "fr",   box: {w:1280,h:720}, log: ["fr"] }
B_after   { fs: "fr",   box: {w:0,h:0},      log: ["fr"] }     // display:none on an ANCESTOR
D_before  { fs: "HTML", box: {w:1280,h:342}, log: ["HTML"] }
D_after   { fs: "HTML", box: {w:1280,h:34},  log: ["HTML"] }   // documentElement fullscreen: immune
E_afterExit { fs: null, box: null, log: ["HTML", null] }        // exitFullscreen() with NO user gesture
```

Three things fall out of this, all of which the ticket depends on:

1. **`display: none` does not exit fullscreen in Chromium** — neither on the fullscreen element itself (A) nor on any ancestor of it (B). The element collapses to a **0x0 box** and **no `fullscreenchange` event fires** (the `log` array never grows). The screen stays fullscreen and paints nothing. This is the black-fullscreen state the ticket describes, and it is real.
2. **TICKET-82's review follow-up N4 is factually wrong.** N4 asserted "browsers exit fullscreen in that situation" and framed the consequence as "strictly better than base". It is not better — it is a black screen for the entire gap between singers with the recruitment QR unreachable behind it, on an unattended kiosk. TICKET-89's premise is correct.
3. **N4's suggested remedy was also wrong**, and worth recording so nobody picks it up later: N4 advised parking with "zero-size + `visibility: hidden`" instead of `display: none`. The committed headed probe's case E measures `visibility: hidden` on an ancestor and it *also* does not exit (`exited: false`). Following N4's advice would have changed nothing.
4. **`exitFullscreen()` needs no user activation** (E), so the chosen defensive exit genuinely works in the field — unlike a re-entry fix, which would need a gesture and would silently no-op on a kiosk. The dev's reasoning here is sound and I reached the same conclusion independently.

Only after measuring the above did I read `work/evidence/TICKET-89/fullscreen-probe-headed.json`. It corroborates my headless results (`exited: false`, box 0x0 for A and B; documentElement immune in D), so this is not a headless artifact.

## 2. TICKET-82 is NOT reintroduced

Re-run by me, including the empty-then-refill case:

```
PORT=3197 npx playwright test e2e/tv.spec.ts --grep "TICKET-82" --reporter=list --timeout 120000

Running 3 tests using 1 worker
  ✓  1 … player survives a queue update while fullscreen — no remount, no black screen (TICKET-82) (6.3s)
  ✓  2 … player survives the queue emptying and refilling — the reported black screen (TICKET-82) (9.3s)
  ✓  3 … a real track change loads the new video in the SAME player (TICKET-82) (7.5s)
  3 passed (24.9s)
```

The watchdog `recreate` rung too:

```
PORT=3197 npx playwright test e2e/tv-watchdog.spec.ts --reporter=list --timeout 120000
  ✓  1 … onError 150 (embedding disabled): pt-BR notice + auto-advance (5.2s)
  ✓  2 … onError 100 (video removed) also skips; non-fatal codes do not (1.5s)
  ✓  3 … the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82) (42.9s)
  3 passed (50.1s)
```

Structurally the diff cannot reintroduce it: it adds a `useCallback` and one call inside the existing `!nowVideoId` branch, plus a `playerVars` key. It does not touch the host, the create path, the liveness guard, or `.mainHidden`. The player stays mounted for the component's life and is parked, never unmounted.

## 3. Audio while idle — the load-bearing safety property

**Finding: the idle path is genuinely silent, and the test asserting it has real teeth.**

The fix does **not** move the app toward keeping media "visible" while idle — that was precisely the alternative the dev rejected. `.mainHidden` (`display: none`) is unchanged; the fix only *leaves fullscreen*, it does not un-hide the player. So the silence mechanism is untouched.

I did not take the test's word for it. I temporarily removed the `playerRef.current.stopVideo()` call from the idle branch and re-ran the silence test:

```
PORT=3197 npx playwright test e2e/tv.spec.ts --grep "SILENT" --reporter=list --timeout 120000

  ✘  1 … an idle screen is SILENT — the player is stopped, not merely hidden (TICKET-89) (5.5s)
    Error: expect(received).toBe(expected)
    Expected: false
    Received: true
      > 732 |     expect(idle.playing).toBe(false); // NO audio while idle
  1 failed
```

The test is **not vacuous**: it establishes `playing === true` before draining (via `expect.poll`), then requires `false` after. Remove the one call that silences the player and it fails on exactly that assertion. This is a real guard rail against the "keep it laid out so fullscreen survives" class of future fix, which is the change most likely to leak audio over an empty bar. `components/tv/TvScreen.tsx` restored afterwards.

## 4. Negative control

`git checkout f515987 -- components/tv/TvScreen.tsx`, new tests kept:

```
PORT=3197 npx playwright test e2e/tv.spec.ts --grep "TICKET-89" --reporter=list --timeout 120000

  ✓  1 … the venue's fullscreen survives the queue emptying and refilling (TICKET-89) (7.6s)
  ✓  2 … an idle screen is SILENT — the player is stopped, not merely hidden (TICKET-89) (5.5s)
  ✘  3 … a YouTube-fullscreened player never leaves a black 0x0 fullscreen while idle (TICKET-89) (5.8s)

    Error: expect(received).toMatchObject(expected)
      Object {
    -   "fs": 0,
    +   "autoplay": 1,
    +   "controls": 1,
    +   "playsinline": 1,
    +   "rel": 0,
      }
      > 761 |     expect.soft((await fullscreenSnapshot(page)).vars).toMatchObject({ fs: 0 });

    Error: expect(received).toBe(expected)
    Expected: false
    Received: true
      > 780 |     expect(blackFullscreen).toBe(false);

  1 failed, 2 passed (20.3s)
```

**The dev's claim is accurate and honestly stated.** Two of the three tests pass at base — they are guard rails, not proof of this fix — and only the "black 0x0" test has teeth. It fails at base on *both* halves: the `fs: 0` playerVar is absent, and behaviourally the TV sits in `IFRAME` fullscreen at 0x0 while idle. That is the defect, reproduced by the test at base and cured at HEAD.

**Is the one test with teeth asserting the right thing?** Yes. `blackFullscreen = kind !== null && box.w === 0 && box.h === 0` forbids the actual failure mode without over-specifying *how* it is avoided — it would pass if a future fix exited fullscreen, or kept it non-zero, or never entered it. It then also checks the idle poster has a real box (the venue can see the QR), that the player was never destroyed (TICKET-82), and that the refill loads into the same node. That is the correct contract.

Both reverts were restored; `git status --short` is empty and `git diff --name-only f515987 HEAD` is unchanged.

## 5. Correctness for an unattended kiosk

- **Does it ever cancel the venue's OWN fullscreen?** No. The guard is `host.contains(fsEl)`, where `host` is `playerHostRef.current`. The app's affordance (`requestAppFullscreen`, line ~703) fullscreens `document.documentElement`, which is an *ancestor* of the host, so `contains()` is false and the helper returns early. I confirmed this behaviourally: the "venue's fullscreen survives" test keeps `kind: "HTML"` across drain and refill, and the pre-existing AC2 affordance test still passes.
- **Can it fire repeatedly / fight a user?** Effectively no, on two counts. First, `setQueue` is if-changed — both call sites use `setQueue((prev) => (queueItemsEqual(prev, items) ? prev : items))` (lines 301, 410) — so a statically empty queue does not churn the `queue` identity and does not re-fire the effect. The code comment's claim here is accurate; I verified it rather than assuming. Second, even if it did re-fire, the call is idempotent: after the first exit `document.fullscreenElement` is null and the helper returns at the `!fsEl` guard. It cannot fight the venue's own fullscreen (see above), and it can only "fight" a user re-fullscreening the *iframe* during idle — which is unreachable, since the iframe is `display: none` and `fs: 0` removed its control.
- **Placement in the effect.** Correct. It sits inside the `!nowVideoId` branch, after `stopVideo()` and the `currentVideoIdRef` reset, before the `return` — i.e. exactly at the idle transition. The effect body runs post-commit so `.mainHidden` is already applied, which does not matter because `exitFullscreen()` works regardless of the element's display. The liveness-guard path above it also flows into this branch correctly (player destroyed → `playerRef.current` null → `stopVideo()` skipped → exit still called).
- **Does the new dependency change re-run behaviour?** No. `exitFullscreenIfPlayerIsFullscreen` is a `useCallback` with an empty dep array, so its identity is stable for the component's life. Adding it to the deps satisfies the lint rule without adding a single re-run.
- **Is `fs: 0` a real capability loss?** No, and arguably a net gain. YouTube's button fullscreens the *iframe*, which shows the bare video and drops the TV layout (hero, singer, up-next rail) that is the product. The app's own affordance fullscreens `documentElement`, which keeps the whole designed screen AND survives the idle gap showing the QR poster. Removing the YouTube control funnels venues onto the strictly better path.
- **Browsers/paths that ignore `fs: 0`.** This is exactly what the defensive exit is for, and it is the path the one test-with-teeth actually exercises: it forces `iframe.requestFullscreen()` directly, ignoring `fs: 0` entirely, and requires the component to leave that state. So the belt is tested independently of the braces. Note also that `fs: 0` only affects *newly created* players, so a kiosk already running at deploy time keeps its button until reload — the defensive exit covers that window too. The dev's inline comment names this case explicitly.
- **Cross-browser.** `webkitFullscreenElement` / `webkitExitFullscreen` fallbacks are present and consistent with the detection side. The whole helper is wrapped in `try`/`catch` plus a `.catch(() => {})` on the promise, so it can never break the TV over a chrome nicety — the right posture for a kiosk.

## 6. TICKET-70 not regressed

```
PORT=3197 npx playwright test e2e/tv.spec.ts --grep "TICKET-70" --reporter=list --timeout 120000
  ✓  1 … realistic Brazilian nicknames render in full on a long room slug (TICKET-70) (1.5s)
  ✓  2 … an 11-char Brazilian nickname still fits at the narrower 1440x900 width (TICKET-70) (843ms)
  ✓  3 … a pathologically long nickname degrades gracefully without breaking the layout (TICKET-70) (824ms)
  3 passed (4.2s)
```

The diff contains no CSS change at all, so there is no layout surface to regress — this is the main structural advantage of the chosen fix over the rejected overlay alternative.

## 7. Scope discipline

```
git diff --name-only f515987 HEAD
components/tv/TvScreen.tsx
e2e/tv.spec.ts
work/events/by-branch/ticket-89-fullscreen-idle-transition.jsonl
work/evidence/TICKET-89/…  (probes, screenshots, README)
work/reports/dev/TICKET-89-report.md
work/tickets/TICKET-89-fullscreen-idle-transition.md
```

No sibling-owned path appears (checked all eight: the two `page.tsx`, `app/layout.tsx`, `lib/youtube-search.ts`, `app/api/search/route.ts`, `e2e/rotation-modes.spec.ts`, `e2e/render-and-links.spec.ts`, `e2e/helpers.ts`). Clean.

## 8. Other suites

**Full `/tv` suite — 13/13:**

```
PORT=3197 npx playwright test e2e/tv.spec.ts --reporter=list --timeout 120000
  ✓ 1 idle state renders the recruitment poster without errors (AC3, AC6) (2.1s)
  ✓ 2 playing state: hero scale, max-3 rail, nothing under 28px (AC1) (1.0s)
  ✓ 3–5 up-next TICKET-70 ×3
  ✓ 6 fullscreen affordance enters fullscreen and hides after (AC2) (863ms)
  ✓ 7–9 TICKET-82 ×3
  ✓ 10–12 TICKET-89 ×3
  ✓ 13 chrome auto-hides and the cursor goes with it (5.2s)
  13 passed (52.8s)
```

**Jest:** `Test Suites: 45 passed, 45 total / Tests: 788 passed, 788 total` — all green.

**`npx tsc --noEmit`:** base **2487** lines / **2447** `error TS` (recomputed by me at `f515987` for both changed files); HEAD **2487** / **2447**. **Delta: zero.** No error mentions `components/tv/TvScreen.tsx` or `e2e/tv.spec.ts`. The pre-existing errors are the known missing-`@types/jest` noise.

**`npm run build`:** succeeds, routes emitted normally.

---

## Findings

### Blocking

None.

### Nits

**N1 (low) — the `fs: 0` assertion is a source mirror, not a behavioural proof.** `expect.soft(vars).toMatchObject({ fs: 0 })` reads the playerVars recorded by the *fake* player, so it proves the component *asks* for `fs: 0`, not that YouTube honours it. That is the right scope given a stubbed player, and the honouring risk is covered behaviourally by the defensive exit — but it is a guard rail, not evidence about real YouTube. The `expect.soft` choice is correct and well-justified in the comment (a hard assert would abort before the behavioural check, which is the one that encodes the defect).

**N2 (low) — no live-YouTube confirmation that `fs: 0` removes the control.** Every test runs against the stub. `fs: 0` is a documented IFrame Player API parameter and is ignored on some mobile paths, but the kiosk target is desktop Chrome. Worth one real-embed eyeball at the next venue night rather than a follow-up ticket, since the defensive exit makes it non-load-bearing.

**N3 (info) — TICKET-82's N4 should be marked corrected.** N4 is now known-wrong on both its claim and its suggested remedy (`visibility: hidden` on an ancestor also fails to exit — headed probe case E). It lives in a merged review that a future agent could reasonably treat as authoritative. This ticket's inline comments already document the correction at the point of use, which is the important half; flagging it here so the stale advice is not resurrected.

**N4 (info) — `exitFullscreenIfPlayerIsFullscreen(host)` takes a parameter that is always `playerHostRef.current`.** Harmless, and arguably clearer than closing over the ref. No change requested.

---

## Judgment call

**Was implementing this the right decision at all, versus accepting the current behaviour?** Yes, clearly. The alternative framing — "losing fullscreen during idle is an acceptable tradeoff" — is not the actual choice on offer, because the measurement shows the TV does *not* lose fullscreen. It sits in a **black fullscreen** for the whole gap between singers, with the recruitment QR unreachable behind it, on an **unattended kiosk** where nobody is present to press Esc. That is the exact failure class TICKET-82 was raised for (a black screen only a human could cure), reached by a different route. Accepting it would mean knowingly shipping a state where the idle screen — whose entire purpose is the recruitment QR — displays nothing. The fix is ~35 lines of guarded, idempotent, try/caught code with zero CSS surface and zero tsc delta. The cost/benefit is not close.

**Is this the right fix versus the rejected alternative?** Yes. Keeping `.main` laid out and overlaying the idle poster would preserve iframe-fullscreen, but the fullscreen element would still be the iframe, so the top layer would render the stopped YouTube frame and the QR poster would remain unreachable — it buys fullscreen at the cost of the very surface the idle state exists to show. It also requires CSS/stacking changes to the one subtree TICKET-70 depends on, which the chosen fix avoids entirely (the diff has no CSS). The chosen approach funnels venues onto `documentElement` fullscreen, which probe D proves is immune to a hidden descendant, and which keeps *both* fullscreen and the poster. The dev's stated rationale matches what I measured independently.

One point in the dev's reasoning is worth endorsing explicitly because it is the kind of thing usually got wrong: choosing **exit** over **re-entry**. Re-entering fullscreen requires user activation, and the test harness grants `requestFullscreen()` on a never-clicked page — so a re-entry fix would look green here and silently no-op at the venue. Preferring the mechanism that is *verifiable in the harness and gesture-free in the field* is the correct call for a kiosk.

---

## Verdict

**APPROVE WITH NITS** (N1–N4, none blocking, none requiring a follow-up ticket).

The premise is true and I re-derived it from scratch rather than trusting the committed probes. TICKET-82 is intact including empty-then-refill. The idle path is genuinely silent and its test has proven teeth. The negative control is exactly as the dev honestly described — two guard rails, one test with teeth, failing at base on both the missing `fs: 0` and the black 0x0 state. Scope is clean, TICKET-70 is untouched, jest is 788/788, the tsc delta is zero, and the build passes.
