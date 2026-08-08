TICKET-75 — App Tester evidence

Room-language seeding from the creator's `NEXT_LOCALE` cookie, and `/[room]/tv` setting `<html lang>` to the room's own locale.

Method: a throwaway Playwright (chromium, headless) script driven from the worktree's `node_modules`, hitting the dev server on `http://127.0.0.1:3187`. For each case, a fresh browser context set (or omitted) a `NEXT_LOCALE` cookie, called `POST /api/rooms` via an in-page `fetch`, then navigated to `/<roomId>/tv`, waited for network-idle + 1.5s settle, read `document.documentElement.lang` and `document.body.innerText`, and took a full-page screenshot. Room names were made unique per case (timestamp suffix) to avoid room-id slug collisions overwriting each other (this bit me on the first run — see Note below).

Raw JSON of every API response and observed `lang`/body text: `raw-results.json` in this directory.

## Case A — cookie `NEXT_LOCALE=pt-BR`

- Room created: `t75-case-a-ptbr-1786230142010`
- Observed `document.documentElement.lang`: `pt-BR`
- Observed on-screen text: `Escaneia e canta! 🎤` / `Tela cheia (F)` (Portuguese)
- `GET /api/rooms?id=...` settings: `{"mode":"full-karaoke","language":"pt-BR"}`
- Screenshot: `tv-pt-BR.png`
- **PASS**

## Case B — cookie `NEXT_LOCALE=en`

- Room created: `t75-case-b-en-1786230142010`
- Observed `document.documentElement.lang`: `en`
- Observed on-screen text: `Scan and sing! 🎤` / `Fullscreen (F)` (English)
- Screenshot: `tv-en.png`
- **PASS**

## Case C — cookie `NEXT_LOCALE=es`

- Room created: `t75-case-c-es-1786230142010`
- Observed `document.documentElement.lang`: `es`
- Observed on-screen text: `¡Escanea y canta! 🎤` / `Pantalla completa (F)` (Spanish)
- Screenshot: `tv-es.png`
- **PASS**

## Case D — no cookie at all

- Room created: `t75-case-d-nocookie-1786230142010`
- Observed `document.documentElement.lang`: `pt-BR`
- Observed on-screen text: `Escaneia e canta! 🎤` / `Tela cheia (F)` (Portuguese — legacy default, unchanged)
- `GET /api/rooms?id=...` settings: `{"mode":"full-karaoke"}` — **no `language` key**, confirming nothing was stored and the room falls back to `pt-BR` on read.
- Screenshot: `tv-no-cookie.png`
- **PASS**

## Case E — CRITICAL cross-check: room=en, viewer cookie=es

- Room created with cookie `NEXT_LOCALE=en`: `t75-case-e-roomen-vieweres-1786230142010`
- `/tv` opened in a separate browser context whose `NEXT_LOCALE` cookie was `es`
- Observed `document.documentElement.lang`: `en`
- Observed on-screen text: `Scan and sing! 🎤` / `Fullscreen (F)` — **English**, not Spanish
- Screenshot: `tv-room-en-viewer-es.png`
- **PASS** — the TV followed the ROOM's stored language, not the viewer's cookie. This is the heart of the ticket and it held.

## GET /api/rooms settings snapshots

Seeded room (Case A, `pt-BR` cookie at creation):
```json
{"mode":"full-karaoke","language":"pt-BR"}
```

No-cookie room (Case D):
```json
{"mode":"full-karaoke"}
```
No `language` key present — confirms the "nothing stored on no/invalid cookie" behavior.

## Note on test methodology

First run of the script used the identical room name (`"Ticket75 Evidence Room"`) for cases A and B. The app derives room ids from a slug of the name, so both requests raced onto the same id and case B's write clobbered case A's room before I read its settings back — a test-script bug, not a product bug (rooms C/D/E got auto-suffixed ids because they collided with the by-then-existing base slug, which is how the collision surfaced). Fixed by giving every case a unique room name (timestamp-suffixed) and re-ran cleanly; all five cases above are from the clean re-run.

## Summary

| Case | Cookie | Expected lang | Observed lang | Verdict |
|---|---|---|---|---|
| A | pt-BR | pt-BR | pt-BR | PASS |
| B | en | en | en | PASS |
| C | es | es | es | PASS |
| D | (none) | pt-BR | pt-BR | PASS |
| E | room=en, viewer=es | en | en | PASS |

All five cases PASS. No failures observed.
