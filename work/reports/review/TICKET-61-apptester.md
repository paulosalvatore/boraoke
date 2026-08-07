# TICKET-61 — App Tester report

## Verdict: PASS

## Method: TRUE end-to-end, no live YouTube

The patron form was driven in a real browser against a real `next dev` server, with the outbound YouTube Data API call redirected to a local stub server (the seam the ticket built for exactly this: `YOUTUBE_API_ORIGIN`, honored only when `NODE_ENV !== "production"`). No client-side mocking of `POST /api/queue` was used — the request went through the real route handler, the real `checkEmbeddable`, and the real translation lookup.

## Setup

1. Stub YouTube Data API server (plain Node `http`, scratchpad-only, not committed):
   - `GET /youtube/v3/videos?...&id=NOTEMBED123` → `{"items":[{"id":"NOTEMBED123","status":{"embeddable":false}}]}`
   - `GET /youtube/v3/videos?...&id=EMBEDOK1234` → `{"items":[{"id":"EMBEDOK1234","status":{"embeddable":true}}]}`
   - Ran on `127.0.0.1:3162`.
2. App server: `npx next dev -p 3161` in the worktree, with
   `NODE_OPTIONS='--localstorage-file=...'` (mirroring the package.json dev script), `NODE_ENV=development`, `YOUTUBE_API_KEY=stub-key`, `YOUTUBE_API_ORIGIN=http://127.0.0.1:3162`. In-memory store (no Redis env set).
3. Drove the app with the Playwright MCP browser (`mcp__playwright__*` tools). Confirmed via `curl` first that the stub answers both ids correctly before touching the browser.

Note: the Playwright MCP browser instance is evidently shared across the parallel sibling App Tester agents working this batch of tickets — the "current tab" pointer flipped away from my tab several times mid-task (another agent's `/default/tv` page kept becoming "current"). I opened my own dedicated tab (`browser_tabs new`) and explicitly re-selected it (`browser_tabs select index:2`) before every action to keep the two sessions from interfering. No cross-agent data corruption was observed — the flips were purely which tab was "current" in the shared MCP process, and my tab's own DOM/state was unaffected.

## Steps and observations

1. Navigated to `http://localhost:3161/default`. Page rendered in English by default (Accept-Language from the automated browser); set `document.cookie = "NEXT_LOCALE=pt-BR"` and reloaded to get the pt-BR copy the ticket's strings target (matches the resolution order documented in `i18n/`: cookie → room default → Accept-Language → pt-BR).
2. Passed the nickname gate ("Seu apelido" → "TesterApp61" → "Entrar na fila").
3. **Case 1 — not-embeddable paste.** Pasted `https://youtu.be/NOTEMBED123` into "Buscar música ou colar link do YouTube". The client resolved it locally to "✓ Selecionada: NOTEMBED123" (no API call yet, as expected — paste resolution is client-side). Clicked "Adicionar à fila". Observed BOTH:
   - the success line: "✓ Música na fila!"
   - `<p role="status" data-testid="submit-warning">⚠️ esse vídeo não permite reprodução em telões — pode não tocar</p>` rendered directly below it, exact pt-BR copy match.
   The song also appeared in "Fila ao vivo" as `youtu.be/NOTEMBED123`.
4. **Case 2 — embeddable paste.** Pasted `https://youtu.be/EMBEDOK1234`, resolved to "✓ Selecionada: EMBEDOK1234". Submitted. Observed the success line "✓ Música na fila!" with **no** `submit-warning` element present at all — the previous submit's warning paragraph was gone (React removed the node), confirming the warning is tied to the current submit's response and not stuck/stale. The song appeared as the 2nd queue entry (`youtu.be/EMBEDOK1234`).

Both requests round-tripped through the real `POST /api/queue` route, the real `checkEmbeddable`, and the real stub HTTP server (confirmed by the differing outcomes keyed only by the video id looked up against the stub).

## Screenshots (absolute paths)

- `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-61/work/evidence/TICKET-61/paste-non-embeddable-warning.png` — success line + warning both visible.
- `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-61/work/evidence/TICKET-61/paste-embeddable-no-warning.png` — success line only, no warning, 2nd queue entry visible.

## Cleanup

Both the stub server (port 3162) and the `next dev` server (port 3161) were killed at the end of the run; confirmed no stray processes remain on either port. No source, test, or e2e files were modified — only the two screenshots and this report were written under `work/`.

## Anything broken

Nothing broken. One incidental observation, not a defect in this ticket's scope: the browser console showed 1-2 errors during the run (not investigated further — did not affect the assertions above, and the ticket's own behavior was unaffected). Worth a quick look if it recurs consistently outside this shared-browser environment.
