# TICKET-103 — TV focus state: always-visible QR, bigger video, timed queue overlay

**Filed:** 2026-09-27, from the Tech Lead's live TV-mode test of 2026-09-26 (brief: `agentic-software-house/work/status/global-tm/handoffs/2026-09-26-boraoke-tv-mode-and-ux.md`, items 1-4)
**Priority:** HIGH — the TL is actively testing this surface and likes it; this is polish on a working base, not a rescue.
**Type:** UX / TV surface
**Size:** M

## What the TL asked for

While the TV is in the state he describes as "the screen goes black with only the video playing" (which he likes, it focuses attention):

1. **The QR must ALWAYS be visible** — he reports it disappears. Anyone must be able to scan and join at any moment.
2. **The video should be bigger** — the chrome is hidden, so the reclaimed space should go to the video.
3. **QR overlaid on the video is allowed if it looks good** — "test seeing the visual." Decide by captured screenshots, not by assertion. If on-video reads badly, fall back to a reserved strip.
4. **Show the queue periodically as a timed overlay** — not permanently on screen; reveal every so often, then hide. Should look intentional.

## The finding that reframes this ticket — read before writing code

**The state the TL describes does not exist in the codebase.** Recon (read-only, 2026-09-27) established:

- The only idle behaviour is `CHROME_HIDE_MS = 4000` (`components/tv/TvScreen.tsx:64`), which fades **only** the `.chrome` bar (Skip button, Fullscreen button, "Esc to exit" hint) via `chromeHidden` (`components/tv/tv.module.css:441-444`) and hides the cursor. It does not black the screen and it does not touch the QR.
- **The QR is never hidden by a timer.** Both QR surfaces are queue-state-driven: the bottom-rail join card while playing (`TvScreen.tsx:968-984`, `QrCode size={120}`) and the full idle recruitment poster when the queue is empty (`TvScreen.tsx:989-1004`, `size={280}`).

So there are two candidate explanations for what he actually saw, and they have **opposite** implications:

- **(a) The app's own fullscreen** (`tv-fullscreen` button or `F` key) fullscreens `document.documentElement` (`TvScreen.tsx:703-712`). Everything still paints, QR included — so this does not explain a disappearing QR.
- **(b) YouTube's own fullscreen**, which makes the **iframe** the fullscreen element. `TvScreen.tsx:164-166` records, from measurement, that this is when "the TV shows a black screen". This matches his description exactly: black, only the video, QR gone.

**Why (b) is load-bearing:** when the iframe is the fullscreen element, nothing outside it paints. A DOM QR overlay on top of it is **not possible** — not hard, impossible. Items 1 and 3 cannot be delivered in that state at all. The only way to satisfy them is for the focus state to be **app-owned**: `documentElement` fullscreen, with the video scaled up and the QR + queue overlay as absolutely-positioned siblings *inside* the fullscreen element, where they still render.

Note the player is already configured `fs: 0` (`TvScreen.tsx:553-557`) specifically to suppress YouTube's fullscreen button for this reason, and `exitFullscreenIfPlayerIsFullscreen` (`TvScreen.tsx:185-199`) actively exits iframe-fullscreen when the queue empties. The hazard is known; this ticket closes the loop by building the state the TL wants on the path where it can work.

## Sequencing (do not skip step 0)

**Step 0 — reproduce, with screenshots, before any code.** Capture the current `/tv` in: normal playing; after the 4s chrome fade; app fullscreen (`F`); and YouTube-native fullscreen if it is still reachable at all with `fs: 0` (double-click, or `f` with focus inside the iframe). This is the cheapest decisive step — it tells us which state he means and whether the QR survives it. Do not build against a guess.

**Step 1 — build the app-owned focus state**, satisfying 1-4 inside `documentElement` fullscreen. If step 0 shows YouTube-native fullscreen is reachable, additionally treat that as a defect to close (suppress or redirect it to the app's own path), because in that state nothing we render can help him.

## Constraints that bind this work

- `components/tv/tv.module.css` is hard-pinned to the **Chrome 68** floor — **no flex `gap`, no `inset` shorthand** — enforced at build time by `scripts/check-css-target.mjs` (header comment, `tv.module.css:1-18`). Any aspect/sizing work stays inside that floor. `.video`/`.playerHost` currently have **no** `aspect-ratio` rule: sizing is flex (`.video` `flex: 1.5` vs `.meta` `flex: 1`) plus absolute fill (`tv.module.css:115-136`); letterboxing is YouTube's, not ours.
- **Do not let React own the player node.** The player host is a stable React-owned wrapper (`TvScreen.tsx:900`); the inner node is replaced imperatively by the YT API (`TvScreen.tsx:541-585`, with the reasoning at L447-473). Resizing must act on `.video`/the wrapper, never by re-rendering the iframe's node.
- Queue data arrives by 3s polling with an if-changed write (`queueItemsEqual`, `TvScreen.tsx:289-321`). **Several timers depend on a no-op write not re-rendering** — a timed overlay must not defeat that.
- `data-testid` convention on this surface is `tv-`-prefixed kebab-case. Note the existing wart: `tv-powered-by` is used on **two different nodes**. New overlays need their own ids.
- Chrome-hide assertions in e2e are class-based web-first polling (`e2e/tv.spec.ts:800-822`), never `waitForTimeout`. Match that.
- Jest is **node env only** (no jsdom), so React component tests are not runnable in the unit suite. Logic worth testing goes in a pure helper (the `components/tv/watchdog.ts` / `self-heal.ts` pattern); visual behaviour is proven by Playwright + screenshots.

## Acceptance

- The QR is visible in every state a venue can reach while a song is playing, including the focus state, and that is proven by screenshots rather than asserted.
- The video occupies materially more of the screen in the focus state than in the normal state.
- The QR-on-video placement is decided by captured evidence; if it reads badly, the reserved-strip fallback ships instead, with the screenshots that drove the call committed.
- The queue overlay appears on a timer, is legible, disappears again, and does not permanently clutter the focus view.
- The Chrome 68 CSS gate and the ES2019 bundle gate stay green.

## 2026-09-27 UPDATE — the Tech Lead's own account, and why it does not close the question

Asked directly what the black state was, the TL answered that it is **the TV's own rest/screensaver mode** (webOS hardware): *"everything black but the video for a while; used the remote, UI showed, then black again."* So neither of the two candidates above is his explanation.

**Treat that as a symptom report, not a diagnosis.** He described what he saw accurately; the attribution to rest mode is a hypothesis, and he has no reason to know what our own timers do. Two things argue against it, and one argues for us:

- A hardware screensaver does not re-arm every few seconds, and it would not leave the video painted — he specifically says everything went black **but the video**.
- **"Used the remote, UI showed, then black again" is the exact signature of `CHROME_HIDE_MS = 4000`.** `pokeChrome()` (`TvScreen.tsx:786-804`) listens on `mousemove` and `pointerdown`, and a webOS magic remote emits pointer events. Remote input → chrome reappears → hides again four seconds later is precisely what that code does.

**Why this is not a quibble.** If it is the TV's rest mode, the disappearing QR is a device limitation, only validatable on real hardware. **If it is our timer, the disappearing QR is our bug — reproducible headless and fixable in this PR.** Item 1 is the one the TL cared most about ("it must ALWAYS be visible"), so which of these is true decides whether this ticket can deliver it at all.

**The wrinkle that keeps it open rather than settled in our favour.** The chrome-hide timer provably does not touch either QR surface. So either something else hides the QR at TV geometry, or he saw the idle-poster↔join-card QR swap and read that as a disappearance. Both are testable; neither is assumed.

### Step 0, retargeted

Reproducing a TV hardware rest mode headless is impossible, so that is dropped. What replaces it:

- **Run at 1920x1080**, the TL's actual geometry — not a desktop default. The difference may be entirely geometric.
- After the fade, report **element by element** what is still painted (video, meta panel, up-next rail, join card, QR) and judge whether a venue across a room would call that "everything black but the video".
- **Reproduce the cycle**: dispatch a pointer event, confirm the chrome returns, confirm it hides again ~4s later. Class-based polling, never a sleep.
- Keep the video's viewport-share measurement (item 2 needs the real starting number) and the reachable in-browser states.
- Confirm in one line whether YouTube-native fullscreen is reachable at all with `fs: 0`.

### Build direction (settled, and independent of the above)

Build the **app-owned focus state** — large video, an **always-painted** QR, and the periodic queue overlay as siblings inside our own DOM — so it is excellent in a normal browser, which is where the TL is testing and where he already says TV mode looks good. **Do not block this PR on the television.** Whether the TV's rest mode preserves those overlays is a **validate-on-real-device follow-up**, not something provable headless — file it as such rather than leaving it implied.

The LG model / webOS version is now load-bearing, since rest-mode behaviour is model-specific.
