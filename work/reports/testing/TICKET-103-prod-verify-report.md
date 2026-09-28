# TICKET-103 — Production verification of the TV focus state

**Date:** 2026-09-27
**Scope:** Confidence check ONLY, against `https://boraoke.com` (production). No local server started, no branch checked out/modified. PR #83 already merged and deployed; this is the "does it actually work live" check the Tech Lead asked for before pointing his real television at it.

## Verdict: WORKS

Every acceptance item from `work/tickets/TICKET-103-tv-focus-state.md` was reproduced on production, headless, at the TL's real geometry (1920x1080), with no behavioral discrepancy from the intended design.

## What was done

1. Created a real room through the production UI: `https://boraoke.com/new` → "TV Focus Verify Prod" → room `tv-focus-verify-prod` (host code `c21jdkmt`).
2. Queued two Creative-Commons Blender Foundation videos through the real guest UI (`aqz-KE-bpKQ`, then `eRsGyueRtiY`) — a second song was needed so the "up next" overlay would have content to reveal (with only one song queued, there is nothing to peek at).
3. Opened `https://boraoke.com/tv-focus-verify-prod/tv` at a 1920x1080 viewport with the song playing.
4. Measured the focus state, the up-next timer cycle, and the keyboard wake — all via in-page `performance.now()`-timed polling (never a blind `sleep`), since this environment's own tool round-trips introduced enough latency to make wall-clock-mediated polling unreliable (see Friction below).

## Findings, mapped to acceptance

- **QR always visible while playing, including in focus:** confirmed. Same DOM node, `opacity: 1`, positioned over the video in every state observed.
- **Video occupies materially more of the screen in focus:** measured at **93.0%** of viewport area (1858×1038 of 1920×1080), vs. **35.2%** in the normal (woken) layout. Comfortably above the ticket's own "90%+" bar.
- **QR on video, not in a reserved strip:** confirmed — `qrOverVideo: true` (QR's bounding box fully inside the iframe's bounding box).
- **Up-next overlay appears on a timer and hides again:** confirmed. A precise in-page timed sample (1s cadence over 50s, `performance.now()`-based) shows a clean, repeating cycle: visible ~6s, hidden ~24s, period ~30s — matching the shipped constants exactly (`QUEUE_PEEK_VISIBLE_MS = 6000`, `QUEUE_PEEK_PERIOD_MS = 30_000`, `components/tv/focus-state.ts`).
- **Wakes on keyboard, full layout returns:** confirmed. `ArrowLeft` immediately exits focus (logo, room name, "TOCANDO AGORA" meta panel, permanent "A SEGUIR" queue list, QR, and the chrome buttons "Pular"/"Tela cheia" all reappear — `tv-05-woken-full-layout.png`). Focus re-engages again ~3-4s later with no further input, matching `CHROME_HIDE_MS = 4000`. Per the ticket's own note, a mouse/pointer event over the focus-state iframe would never reach the app (goes to the cross-origin iframe instead) — keyboard was used throughout for exactly this reason, and it worked as the only valid wake path.
- **No console errors** attributable to the app itself during the run (pre-existing third-party warnings only, e.g. from the YouTube iframe).

**No production-only discrepancy found.** Everything measured matches the ticket's acceptance criteria and the shipped constants in `components/tv/focus-state.ts` / `tv.module.css`.

## Evidence

All in `work/evidence/TICKET-103-prod-verify/`:

| File | What it proves |
|---|---|
| `tv-01-initial.png` | `/tv` immediately after load, before the idle/focus timer fires. |
| `tv-02-focus-engaged.png` | Focus state engaged (~93% video, QR visible) after idle. |
| `tv-03-upnext-visible.png` | First manual catch of the "A SEGUIR" overlay visible (later superseded by the precise timed sample below). |
| `tv-04-focus-with-upnext.png` | Focus state + up-next overlay visible simultaneously, at the exact moment measured: video 93.0%, QR over video confirmed by DOM rects. |
| `tv-05-woken-full-layout.png` | Immediately after `ArrowLeft`: full normal layout restored (logo, venue name, now-playing meta, permanent queue list, QR, chrome buttons). |

## Friction (for the framework note)

This environment's Playwright tool round-trips carried substantial and inconsistent latency (tens of seconds between a requested "wait N seconds" and the next tool call landing) — several early wall-clock-mediated polls of the up-next overlay were misleading because of this, not because of app behavior. Switched to in-page `performance.now()`-based sampling (a single `browser_evaluate` call looping and sleeping *inside* the page) for anything timing-sensitive, which is unaffected by outer tool latency and should be the default technique for future timer-cadence verification on this surface. Also: `capture-screenshots`'s Playwright screenshot tool writes relative to the framework repo root (`agentic-software-house/`), not the target product repo, when driven this way — screenshots had to be moved into `boraoke/work/evidence/...` by hand after each capture.

## Ticket carve-out still open (unrelated to this check)

The ticket itself flags that real webOS/TV hardware rest-mode behavior is a separate, validate-on-real-device follow-up, not provable headless. This check does not touch that — it only confirms the app-owned focus state itself, which is what shipped in PR #83.
