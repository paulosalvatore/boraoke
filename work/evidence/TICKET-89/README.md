# TICKET-89 — App Tester evidence: fullscreen -> idle -> refill

Captured by `apptester-ticket-89.mjs` against the live dev server (`http://127.0.0.1:3197`, `ADVANCE_AUTH=enforce`) at 1920x1080, chromium headless.

The YouTube IFrame API is stubbed via `page.addInitScript` (adapted from `e2e/tv.spec.ts`'s `stubYouTubeReplacingNode`): the stub REPLACES the target `<div>` with a real `<iframe>` (matching the real API's DOM-swap behaviour, which is exactly what made TICKET-82's `display:none` fix collapse the fullscreen element to a 0x0 box), and tracks audio state via `window.__ytPlaying` (true from `loadVideoById`/`playVideo` until `stopVideo`) and `window.__ytStopped` (count of `stopVideo()` calls — the only thing that actually silences a parked player, per the component's own doc comment).

Full machine-readable detail is in `diagnostics.json` (one entry per step: `fullscreenElement`, its bounding box, whether the player iframe is the same DOM node throughout, `tv-idle` visibility + box, and audio state).

## Sequence A — the app's own fullscreen (supported venue path)

Room: `t89-apptester-a`. Fullscreen entered via a genuine Playwright click on the real `[data-testid="tv-fullscreen"]` chrome button (a trusted gesture, calling `document.documentElement.requestFullscreen()`).

- **`01-playing.png`** — windowed, a song playing ("Garota de Ipanema", Ana/Mesa 1), the "Tela cheia (F)" fullscreen button visible. Expected. **PASS**.
- **`02-fullscreen-playing.png`** — after clicking fullscreen: `fullscreenElement = HTML`, box 1920x1080, "Esc para sair" hint shown in the chrome. Expected. **PASS**.
- **`03-fullscreen-idle.png`** — **MONEY SHOT**. Queue drained to empty. `fullscreenElement` is still `HTML` at a full 1920x1080 box (not 0x0), and the idle recruitment poster + QR render on top of it, fully visible. This is the exact case TICKET-82's `display:none` fix would otherwise leave as a black fullscreen box. Audio: `ytPlaying=false`, `ytStopped=1` (the parked player was told to stop). Expected. **PASS**.
- **`04-fullscreen-refilled.png`** — new song submitted ("Baile de Favela", Bruno/Mesa 2). Still fullscreen (`HTML`, 1920x1080), the new song is loaded (`ytLoaded=["oHg5SJYRHA0"]`) and playing (`ytPlaying=true`). Expected. **PASS**.

## Sequence B — YouTube's own fullscreen (the broken path the fix defends)

Room: `t89-apptester-b`. Fresh page/context. YouTube's own fullscreen button is removed from the real embed by the fix (`fs: 0`), so this simulates a client that still reaches it (double-click, cached old client, etc): a throwaway on-page button calls `iframe.requestFullscreen()` on the tracked player iframe, clicked with a genuine Playwright click (the same gesture-backed technique the ticket's own `activation-probe.mjs` validated).

- **`05-iframe-fullscreen.png`** — solid black. This is expected and NOT a bug: the stubbed iframe's content is `about:blank`, so a real browser fullscreening an empty iframe paints black regardless of the fix — this is the "playing" precondition, not the failure state. `fullscreenElement = IFRAME[data-yt-instance=1]`, box 1920x1080, confirming the iframe (not documentElement) really is the fullscreen element here, matching the reported bug's precondition. **PASS** (precondition established correctly).
- **`06-iframe-fullscreen-idle.png`** — **MONEY SHOT**. Queue drained to empty. `fullscreenElement` is now `null` — the fix's `exitFullscreenIfPlayerIsFullscreen` correctly detected the player's iframe was the fullscreen element (`host.contains(fsEl)`) and called `document.exitFullscreen()`. The idle poster renders in normal (non-fullscreen) layout, NOT a black screen. Audio: `ytPlaying=false`, `ytStopped=1`. Expected. **PASS**.

  Contrast with `05`: if the fix were absent (the pre-TICKET-89 `display:none`-only behaviour), this screenshot would look identical to `05` — solid black, still reporting `fullscreenElement = IFRAME`, forever. It doesn't.

## Acceptance criteria verdicts

| Criterion | Verdict | Evidence |
|---|---|---|
| Fullscreen survives queue emptying and refilling (app's own fullscreen) | **PASS** | `02`→`03`→`04`: `fullscreenElement` stays `HTML` at 1920x1080 through the whole idle+refill cycle (`diagnostics.json` A2/A3/A4) |
| No audio while idle | **PASS** | Both money shots: `ytPlaying=false`, `ytStopped=1` at idle (A3 and B2 in `diagnostics.json`). No `loadVideoById`/`playVideo` calls after `stopVideo()` until the deliberate refill in sequence A |
| No black 0x0 fullscreen state | **PASS** | A-path: fullscreen box stays 1920x1080 through idle (never 0x0). B-path: the player's own fullscreen is explicitly EXITED at idle (`fullscreenElement: null`) rather than left as a collapsed box — `isZeroBox` is `false` at every captured step, and there is no step where `fullscreenElement` is non-null with a 0x0 box |

## Files in this directory

- `apptester-ticket-89.mjs` — the capture script (run: `node apptester-ticket-89.mjs`, from this worktree)
- `diagnostics.json` — full per-step machine-readable state
- `01-playing.png` .. `06-iframe-fullscreen-idle.png` — the 6 captured screenshots
- `fullscreen-probe*.{mjs,json}`, `activation-probe*.{mjs,json}` — pre-existing TICKET-89 investigation probes (not authored by this App Tester pass; left in place, referenced above for the gesture-backed-click technique)

## Honesty note

`05-iframe-fullscreen.png` is a solid black frame. This was double-checked and is expected given the stub (`about:blank` iframe content) — it is not being passed off as evidence of a working video render, only as evidence of the iframe-fullscreen precondition (`fullscreenElement = IFRAME`, box 1920x1080), which `diagnostics.json` confirms independently of the screenshot's pixels.
