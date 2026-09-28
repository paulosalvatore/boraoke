# TICKET-103 — Step 0: reproduce and photograph the current `/tv` states

**Scope:** Step 0 ONLY (per the ticket's own sequencing note — "do not skip step 0"). No product code was written or changed. This report reproduces the current `/tv` behavior with screenshots and settles two questions: (1) is the Tech Lead's "screen goes black, QR gone" symptom our own `CHROME_HIDE_MS` timer, or a TV hardware rest/screensaver mode; and (2) is YouTube-native fullscreen reachable despite `fs: 0`.

**Verdict: N/A (evidence-gathering ticket, not a PR).** This is not a PASS/FAIL/BLOCKED gate — it is the reproduction step a Dev builds on. Both findings below are decisive, not ambiguous.

## Reframe note

The Tech Lead's own hypothesis (a TV hardware rest/screensaver mode) is **not reproducible and was not chased** — you cannot reproduce TV-hardware sleep from a browser, headless or otherwise. Per the coordinator's redirect, this report instead tests the competing, testable hypothesis: that "remote input → UI appears → goes black again after a few seconds" is the exact signature of our own `CHROME_HIDE_MS = 4000` timer (`components/tv/TvScreen.tsx:64`) re-arming on every `pointerdown`/`mousemove` a webOS magic remote emits. **All captures below are at 1920×1080 (TV geometry), not a desktop default**, per that redirect.

## Environment

- App booted via `npm install && npx next dev -p 3141` in this worktree (`.worktrees/t103-tv-focus`, branch `ticket/103-tv-focus`) — **port 3141**, not the `run-app` default 3040, to keep 3040 free for other concurrent work.
- Room created through the real UI at `/new` (never seeded directly into the store): venue name "Bar Ticket 103 TV" → room `bar-ticket-103-tv`.
- Two songs queued through the real patron UI at `/bar-ticket-103-tv` (nickname `Tester103`, table `1`, "💃 Só curtir" mode to avoid the unrelated mic-call banner cluttering the captures): `aqz-KE-bpKQ` (now playing) and `eRsGyueRtiY` (up next), both Blender Foundation Creative-Commons shorts, reliably embeddable.
- Browser automation: Playwright MCP, **headless**, own isolated browser context — never the Tech Lead's screen/mouse.
- Viewport: **1920×1080** for every capture in this report (superseding the earlier 1280×720 pass — see Appendix).

## Finding 1 (decisive): the black-screen/QR-gone symptom is our own chrome-hide timer, not a hardware rest mode

**Element-by-element, right after the 4s chrome-hide fires (`chromeHidden` class confirmed present, polled — never a timed guess):**

| Element | Painted? | Measured box (1920×1080 viewport) |
|---|---|---|
| `.video` (the YouTube iframe's container) | **Yes** — opacity 1, visible | 1049.9 × 702.3 px |
| `.meta` ("Tocando agora" panel) | **Yes** — opacity 1, visible | 697.3 × 702.3 px |
| `.rail` ("A SEGUIR" up-next rail) | **Yes** — opacity 1, visible | 1804.8 × 146.0 px |
| `.join` (QR join card) | **Yes** — opacity 1, visible | 499.2 × 146.0 px |
| `.qr` (the QR code itself) | **Yes** — opacity 1, visible | 105.6 × 105.6 px |
| `.chrome` (Skip/Fullscreen button bar) | **No** — opacity 0 (`chromeHidden` class) | 413.8 × 67.9 px (laid out, not painted) |

**Screenshot `tv-2-chromehidden-1080p.png` confirms this visually**: after the chrome-hide timer fires, the video, the "TOCANDO AGORA" panel, the "A SEGUIR" rail, and the QR join card are all still fully on screen — the only thing that disappears is one small button pair in the bottom-right corner. **This does not read as "everything black but the video" from across a room — it reads as a barely-noticeable UI chrome fade.** The QR is not among what disappears; it survives, exactly as the ticket's original recon said.

**The reveal→re-hide cycle reproduces cleanly and matches the Tech Lead's description mechanically:**

1. Dispatched a synthetic `pointerdown` + `mousemove` at the video center (the same event pair a webOS magic remote emits) — chrome (`.chrome`, "Pular"/"Tela cheia" buttons) reappeared in **22ms**.
2. With no further input, chrome auto-hid again — measured at **4020ms** after the dispatch, i.e. within 20ms of `CHROME_HIDE_MS = 4000`.

**This is the Tech Lead's own described cycle** ("used the remote, UI showed, then black again") **reproduced in our own code, on a stopwatch that lines up with the constant in the source.** A hardware screensaver would not re-arm on every single remote press with a fixed ~4s window, and it would not leave the video (and, per the table above, the meta panel/rail/QR) still painted underneath it — it would blank the whole panel including the video. Ours does neither: it fades one small button bar and nothing else.

**Conclusion: what the Tech Lead is describing is very likely our own `CHROME_HIDE_MS` mechanism being perceived as "the screen goes black."** It is not proof beyond all doubt (see "What would settle it further" below), but it is a precise mechanical match on both the trigger (remote input) and the timing (~4s), and the one part of his description that doesn't fit our current code — "QR gone" — is contradicted by direct DOM measurement (the QR stays painted, opacity 1, throughout). If his repeated "goes black" impression is really about the small chrome bar rather than the QR, this finding fully explains his report without needing a device-level hypothesis at all.

**Not fully settled, stated plainly:** I cannot rule out that the TL is ALSO seeing a real webOS-level rest state layered on top of (or instead of) this — that requires the actual LG webOS hardware/remote, which is out of reach for browser automation. **What would settle it for good:** have the TL reproduce on the real TV once more and specifically watch whether the QR card (bottom-right, small) is still there during the "black" phase, or note the exact wall-clock gap between "stopped touching anything" and "went black" (if it's consistently ~4s, that's our timer; if it's tens of seconds to minutes, that points back to a device sleep timer we don't control).

## Finding 2 (decisive, confirmed twice): YouTube-native fullscreen is reachable despite `fs: 0`

Re-verified at 1920×1080 (previously confirmed at 1280×720 too — see Appendix): a real mouse click inside the `#movie_player` iframe (to focus it) followed by pressing `F` flips `document.fullscreenElement` to the `<iframe>` itself. Screenshot `tv-4-ytfullscreen-1080p.png`: the video fills the **entire 1920×1080 viewport**, no Boraoke chrome, no meta panel, no up-next rail, no QR — this is the unambiguous "black screen, only the video" state, reachable through YouTube's own keyboard shortcut regardless of `fs: 0`. (Double-click alone does **not** reach it — confirmed in the earlier 1280×720 pass, not re-run here since the mechanism is resolution-independent.)

This remains a live, separate hazard from Finding 1: if the TL (or a patron near the TV, or the webOS remote's own focus behavior) ever puts keyboard focus inside the iframe and a `F`/fullscreen shortcut fires, the result is genuinely irrecoverable-by-us (nothing outside the fullscreen iframe paints — confirmed by DOM measurement: the QR element still has a non-zero bounding box but is not composited). Step 1 should still close this off, independently of Finding 1.

## Video size baseline (item 2 — "make the video bigger")

Measured at 1920×1080 (matches the 1280×720 pass proportionally, confirming the CSS is `vw`-relative and resolution-independent):

- **Normal / chrome-hidden / app-fullscreen (all three, identical):** `.video` = 1049.9 × 702.3 px → **54.7% of viewport width, 65.0% of height, 35.6% of area.**
- **App fullscreen via the `tv-fullscreen` button reclaims ZERO space** — `tv-3-appfullscreen-1080p.png` is layout-identical to the normal-state screenshot, pixel-for-pixel on every non-video element too. In this harness the browser is already borderless/full-viewport before requesting fullscreen, so `documentElement` fullscreen has no visible effect. There is no CSS in `tv.module.css` today that gives `.video` more room in a fullscreen state — confirmed by reading the source (`.video` is a static `flex: 1.5` inside the always-present `.main` row).
- **YouTube-native fullscreen (Finding 2):** iframe fills 100% of viewport — but at the cost of every other element (Finding 1's opposite: this is the state where things really do disappear).

## Evidence index

| File | What it proves |
|---|---|
| `tv-1-normal-1080p.png` | Baseline at TV resolution: chrome visible, QR visible, up-next rail visible, video = 35.6% of viewport area. |
| `tv-2-chromehidden-1080p.png` | **Decisive for Finding 1.** After the 4s chrome-hide timer: video, meta panel, up-next rail, and QR all still painted — only the small button bar fades. Does not match "everything black." |
| `tv-3-appfullscreen-1080p.png` | App (`documentElement`) fullscreen: layout pixel-identical to baseline, video size unchanged — confirms "video bigger" is not yet implemented in any current state. |
| `tv-4-ytfullscreen-1080p.png` | **Decisive for Finding 2.** YouTube-native (iframe) fullscreen via focus+`F`: video fills 100% of viewport, nothing else renders. This — not the chrome-hide timer — is the state that actually matches "black screen, QR gone" literally. |

## Appendix — first pass at 1280×720 (superseded by the 1080p pass above, kept for the record)

Before the reframe, an initial pass was run at a 1280×720 desktop viewport and is committed alongside this report:

- `tv-1-normal-playing-chrome-visible.png`, `tv-2-chrome-hidden-4s-idle.png` — same normal/chrome-hidden states, smaller viewport. Same conclusion as Finding 1's table (QR + video both painted through the chrome-hide).
- `tv-3-app-fullscreen-button.png`, `tv-3b-app-fullscreen-fkey.png` — app fullscreen via button and `F` key; both land in `documentElement` fullscreen, video size unchanged (700.5×467.8 in 1280×720 = same 35.6% area).
- `tv-4-youtube-native-fullscreen-fkey.png` — first confirmation that YouTube-native fullscreen is reachable via focus+`F` despite `fs:0`; video fills 100% of viewport, QR present in DOM (non-zero bounding box) but not painted.
- `tv-4b-youtube-doubleclick-no-fullscreen.png` — a real `page.mouse.dblclick()` on the player does **not** trigger fullscreen; only the keyboard path does.

This pass is what first identified YouTube-native fullscreen as reachable and measured the video-size baseline; it did not yet test the reveal/re-hide cycle or the element-by-element chrome-hide breakdown, which the reframe above added.

## Friction (feeds skill-improvement)

- **`https://www.youtube.com/watch?v=dQw4w9WgXcQ` (Rick Astley) failed fast** in this environment — the TV's `onError`/watchdog fired an auto-skip within ~10s of queueing it (confirmed real internet egress via `youtube.com` and its oEmbed endpoint, so not a sandbox network limitation). Switched to Blender Foundation Creative-Commons shorts (`aqz-KE-bpKQ`, `eRsGyueRtiY`), which played reliably for every capture. Not investigated further — orthogonal to this ticket.
- **The documented memory-driver caveat in `playwright.config.ts`** ("singletons live in ONE Next dev process and reset on each route's first compile") cost real time on the first pass: the room + queue store was wiped mid-test twice, including once by `/apple-icon.png`'s first compile — an implicit `<head>` resource, not something navigated to on purpose. Fix: `curl` every route (including implicit metadata routes — `/icon.png`, `/apple-icon.png`, `/robots.txt`, `/sitemap.xml`) once before creating any real room/queue state, so nothing compiles "fresh" mid-test. Worth a line in this product's `run-app`/`capture-screenshots` docs for the next interactive (non-Playwright-test-runner) tester — the existing note only documents this for the Playwright test runner, which sidesteps it by running serially against one already-warm process.
- Playwright's strict click-actionability check blocked a direct click on the `tv-fullscreen` button (the bottom-rail element intercepted the hit-test) and on elements inside the cross-origin YouTube iframe (its own hover-controls overlay intercepted). Worked around via `element.click()` in-page for the app button, and via `page.mouse.click()`/`page.keyboard.press()` at real coordinates (through `page.frames()`) for the iframe interactions — both are real, trusted-enough interactions for this harness, not simulated bypasses of the product's own behavior.
