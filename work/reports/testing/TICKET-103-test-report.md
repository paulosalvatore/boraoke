# TICKET-103 — Step 0: reproduce and photograph the current `/tv` states

**Scope:** Step 0 ONLY (per the ticket's own sequencing note — "do not skip step 0"). No product code was written or changed. This report reproduces the current `/tv` behavior with screenshots and settles which of the two candidate explanations (app fullscreen vs YouTube-native fullscreen) matches the Tech Lead's "screen goes black, QR gone" description.

**Verdict: N/A (evidence-gathering ticket, not a PR).** This is not a PASS/FAIL/BLOCKED gate — it is the reproduction step a Dev builds on. The finding below is decisive, not ambiguous.

## Environment

- App booted via `npm install && npx next dev -p 3141` in this worktree (`.worktrees/t103-tv-focus`, branch `ticket/103-tv-focus`) — **port 3141**, not the `run-app` default 3040, per instruction to keep 3040 free for other concurrent work.
- Room created through the real UI at `/new` (never seeded directly into the store): venue name "Bar Ticket 103" → room `bar-ticket-103`, host code `rwzda6b5` (recorded here only because this is a disposable local/dev room; not a real venue).
- Song queued through the real patron UI at `/bar-ticket-103`: nickname `Tester103`, table `1`, "🎤 Cantar" mode, pasted YouTube link `https://www.youtube.com/watch?v=aqz-KE-bpKQ` ("Big Buck Bunny 60fps 4K — Official Blender Foundation Short Film", 10:35 long, Creative Commons/reliably embeddable).
- Browser automation: Playwright MCP, **headless**, own isolated browser context — never the Tech Lead's screen/mouse.
- Viewport: 1280×720 for every capture (desktop TV baseline).

## Friction (feeds skill-improvement — not part of the finding)

- **`https://www.youtube.com/watch?v=dQw4w9WgXcQ` (Rick Astley) failed fast** in this run — the TV's `onError`/watchdog fired `POST /api/queue/advance?...&reason=unplayable` within ~10s of queueing it, well before the 12s stall-ladder window could even complete one rung, so it reads as a genuine YT `onError` (fatal code) rather than a stall. Confirmed the environment has real internet egress (`youtube.com` and its oEmbed endpoint both resolve fine), so this looks like a property of that specific video/embed context, not a sandbox limitation. Switched to Big Buck Bunny (`aqz-KE-bpKQ`), which played reliably for every capture below. Filing as a minor note, not a ticket — not reproducible against a cause I could pin down in the time budget, and orthogonal to TICKET-103.
- **The documented memory-driver caveat in `playwright.config.ts`** ("singletons live in ONE Next dev process and reset on each route's first compile") is real and cost most of the session's time: the room + queue store got wiped mid-test twice, once by `/[room]/tv`'s first compile and once by `/apple-icon.png`'s first compile (an implicit `<head>` resource, not something I navigated to on purpose). Fix that worked: hit every route (including the implicit metadata routes — `/icon.png`, `/apple-icon.png`, `/robots.txt`, `/sitemap.xml`) once with `curl` before creating any real room/queue state, so no route compiles "fresh" mid-test. Worth a line in `run-app`/`capture-screenshots` for the next tester on this product — the existing note in `playwright.config.ts` only documents it for the Playwright *test* runner (which sidesteps it by running serially against one already-warm process), not for an interactively-driven capture session.

## Captures

All screenshots below are in `work/evidence/TICKET-103/`, 1280×720, PNG.

### 1. `tv-1-normal-playing-chrome-visible.png` — normal playing state, chrome visible

Captured immediately after navigating to `/bar-ticket-103/tv` with the song queued (video at 0:02/10:35). Shows: "Tocando agora" panel, mic-call countdown banner (30s "vá para o microfone" grace window — a real feature, TICKET-10, not part of this ticket), the bottom-rail join card (**`size={120}` QR**, `data-testid="tv-powered-by"`), and (per the accessibility snapshot taken at the same moment) the `tv-chrome` bar with "Pular ⏭" and "Tela cheia (F)" buttons, un-faded.

- **QR:** visible. Surface: bottom-rail join card, `size={120}`.
- **Video box measured** (`.video` element, via `getBoundingClientRect()`): **700.5 × 467.8 px** in a 1280×720 viewport → **54.7% of viewport width, 65.0% of viewport height, 35.6% of viewport area.**

### 2. `tv-2-chrome-hidden-4s-idle.png` — after the 4s chrome-hide timer, `chromeHidden` class confirmed

Captured only after polling `document.querySelector('[class*="chrome"]').className` and observing `chromeHidden` present (no `waitForTimeout` guess — per house rule and the ticket's own e2e convention). At the moment of capture the class was `tv_chrome__QCEHp tv_chromeHidden__hKPzw`.

- **QR:** still visible, same bottom-rail card, `size={120}`. Confirms the ticket's recon: `CHROME_HIDE_MS` fades **only** `.chrome` (the button bar) — it does not touch the QR and does not black the screen. The video content and layout are otherwise identical to capture 1.
- Nothing else changed size — this is a pure opacity fade on one small element, not a focus/immersive state.

### 3. `tv-3-app-fullscreen-button.png` / `tv-3b-app-fullscreen-fkey.png` — app's own (`documentElement`) fullscreen, both entry paths

Entered via `document.querySelector('[data-testid="tv-fullscreen"]').click()` (the `tv-fullscreen` button — Playwright's real pointer click was blocked by the bottom-rail intercepting the hit-test, so the button was invoked directly; this is a harness limitation, not a product defect) for capture 3, and via the `F` keyboard shortcut for capture 3b, after first exiting fullscreen and confirming `document.fullscreenElement` was `null` beforehand.

- Both confirmed via `document.fullscreenElement.tagName === "HTML"` — i.e., `document.documentElement` is the fullscreen element, exactly as the ticket's recon describes (`requestAppFullscreen`, `TvScreen.tsx:703-712`).
- **QR:** visible in both, same bottom-rail card. Everything the app renders keeps painting, because the whole document is the fullscreen element — this matches the ticket's own reasoning for why this path is buildable.
- **Video box measured: still 700.5 × 467.8 px, viewport still 1280×720 — byte-for-byte identical to capture 1.** In this headless harness the browser window is already borderless/full-viewport before fullscreen is requested, so `documentElement` fullscreen has **no visible effect on layout or video size** — it is a no-op for "make the video bigger" as currently implemented. This is the concrete, measured version of ticket item 2 ("the video should be bigger, the chrome is hidden, the reclaimed space should go to the video"): today, entering app-fullscreen reclaims **zero** space for the video. There is no CSS today that gives `.video` more room when `documentElement` is the fullscreen element — confirmed by reading `tv.module.css` (`.video` is a static `flex: 1.5` inside the always-present `.main` flex row; nothing keys off a fullscreen state).

### 4. `tv-4-youtube-native-fullscreen-fkey.png` — YouTube's own (iframe) fullscreen, reached via focus + `F`

**This is the decisive capture.** Despite the player being configured `fs: 0` (confirmed: the live embed URL carries `&fs=0`), YouTube's own fullscreen **is still reachable**: a real mouse click inside the `#movie_player` iframe (to give it focus) followed by a keypress of `F` flips `document.fullscreenElement` to the `<iframe>` itself (`tv_playerHost__l0POn`), confirmed both from the top document (`fsTop: "IFRAME"`) and from inside the YouTube frame (`fsFrame: "DIV"`, YouTube's own internal fullscreen wrapper).

- **Screenshot: the video fills the ENTIRE 1280×720 viewport. No Boraoke chrome, no "Tocando agora" panel, no QR, nothing — exactly "the screen goes black with only the video playing," matching the Tech Lead's description verbatim.**
- **Measured:** the fullscreen `<iframe>`'s box is **1280 × 720 — 100% of the viewport, 100% of the area.**
- **QR, checked in the DOM (not just visually):** the QR `<div>` **still exists in the layout tree** (`getBoundingClientRect()` returns a non-zero 70.4×70.4 box) but **is not painted** — nothing outside the fullscreen element renders. This is exact, first-hand confirmation of the ticket's own claim (`TvScreen.tsx:164-166` comment): "nothing outside the fullscreen element paints... a DOM QR overlay on top of it is not possible — not hard, impossible."
- **Double-click test (`tv-4b-youtube-doubleclick-no-fullscreen.png`):** a real `page.mouse.dblclick()` at the center of `#movie_player` was tried first and **did NOT** trigger fullscreen (`document.fullscreenElement` stayed `null` on both the top document and the YouTube frame, screenshot confirms normal playing state unchanged). So the reachable path in this product, today, is specifically **keyboard `F` with focus inside the iframe** — not a double-click on the video.

## The finding that answers the ticket's central question

**Both of the ticket's candidate states are real, and they are NOT the same state — and the Tech Lead's description matches (b), not (a):**

| | App fullscreen (a) | YouTube-native fullscreen (b) |
|---|---|---|
| Entry paths tested | `tv-fullscreen` button, `F` key (with focus outside the iframe) | `F` key **with focus inside the iframe** (double-click alone: not reachable) |
| `document.fullscreenElement` | `HTML` (documentElement) | `IFRAME` (the player's own iframe) |
| QR | Visible (bottom-rail, unchanged) | In the DOM, but **not painted** — invisible |
| Video size vs normal | Identical (700.5×467.8, no change) | Fills 100% of the viewport |
| Matches "screen goes black, only the video, QR gone"? | No | **Yes, exactly** |

So: **(b) is confirmed reachable, and it is the state the Tech Lead is describing.** This is not ambiguous — the screenshot in capture 4 reproduces his description pixel-for-pixel, and the DOM check proves the mechanism (fullscreen-element painting, not a timer or a bug that hides the QR).

**What this settles for the ticket's own sequencing:**

- **Step 1 must, per the ticket's own text, also treat YouTube-native fullscreen as a defect to close** — confirmed live, not hypothetical. `fs: 0` suppresses YouTube's own **button**, but does not block the `F`-key shortcut once the iframe has focus. The Dev building Step 1 needs to either suppress/intercept that keyboard path or redirect it into the app's own fullscreen request (the ticket already names this as the fallback plan if Step 0 found the state reachable — it did).
- **Item 2 ("video bigger") has a real, measured baseline now:** normal and app-fullscreen are both 700.5×467.8 in 1280×720 (35.6% of viewport area). Any Step-1 CSS change should be judged against that number, not an estimate.
- **Item 1 and 3 (QR always visible / QR-on-video) are only impossible in state (b).** In states 1, 2, and 3(a), the QR already survives today with no changes needed — the ticket's framing that the fix must happen inside `documentElement` fullscreen (with QR/queue overlay as siblings inside it) is the only way to satisfy 1 and 3 in the state the Tech Lead actually experiences, exactly as the ticket concludes.

No ambiguity to report — the evidence is clean and directly decisive in both directions the ticket asked about.

## Evidence index

| File | What it proves |
|---|---|
| `tv-1-normal-playing-chrome-visible.png` | Baseline: chrome visible, QR visible (bottom-rail, 120px), video = 35.6% of viewport area. |
| `tv-2-chrome-hidden-4s-idle.png` | Confirms recon: 4s idle only fades `.chrome`, QR/video untouched. |
| `tv-3-app-fullscreen-button.png` | App fullscreen via button: `documentElement` fullscreen, QR visible, **video size unchanged** from baseline. |
| `tv-3b-app-fullscreen-fkey.png` | Same state via `F` key — confirms both entry paths land in the same (safe) fullscreen mode. |
| `tv-4-youtube-native-fullscreen-fkey.png` | **The TL's state.** YouTube-native (iframe) fullscreen reached via focus+`F`; video fills 100% of viewport; QR exists in DOM but is not painted. Matches "black screen, only the video, QR gone" exactly. |
| `tv-4b-youtube-doubleclick-no-fullscreen.png` | Double-click alone does NOT reach YouTube-native fullscreen in this build — only the keyboard path does. |

## Friction summary (recap)

1. Rick Astley's video ID triggered a fast fatal player error in this environment; switched to a Creative-Commons test video that played reliably. Not investigated further — orthogonal to this ticket.
2. The Next dev in-memory store's "resets on first compile of any route" caveat bit twice, including via an implicit `<head>` metadata route (`/apple-icon.png`) I hadn't warmed. Worth a note in the product's `capture-screenshots`/`run-app` docs for the next interactive (non-Playwright-test-runner) tester.
