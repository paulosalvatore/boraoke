---
name: run-app
description: Start the Boraoke app locally on port 3040.
---

# run-app

## Quick start

```bash
cd /Users/paulosalvatore/Documents/GitHub/boraoke  # or the active worktree path
npm install
npm run dev
```

The app starts on **http://127.0.0.1:3040**.

- Patron page: http://127.0.0.1:3040/
- Venue screen: http://127.0.0.1:3040/tv

## Worktree path (any ticket branch)

Worktrees live inside the repo as `<repo>/.worktrees/<slug>` (D-033), e.g. `ticket-1`:

```bash
cd /Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/<slug>
npm install
npm run dev
```

## Port

**3040** — chosen to avoid conflicts with other house products (3000/3020/5434/5435 are taken).

## Warm every route BEFORE you create any state (read this before hand-testing)

Under `next dev` with the in-memory store, a route's **first compile** re-evaluates the shared store/rooms modules and **resets their singletons** — silently wiping any room or queue you seeded before that compile. So state created early in a session disappears the first time you visit a page you have not visited yet.

The trap is that this includes routes **nobody navigates to on purpose**. `app/` ships `icon.png`, `apple-icon.png`, `robots.ts` and `sitemap.ts`, which the browser requests from `<head>` on its own schedule. During TICKET-103's Step 0 the room + queue were wiped mid-test twice, once by `/apple-icon.png` compiling several seconds after the page loaded.

Warm everything first, then create state:

```bash
BASE=http://127.0.0.1:3040
ROOM=<your-room-slug>
for r in / "/$ROOM" "/$ROOM/tv" "/$ROOM/admin" "/api/queue?room=$ROOM" \
         /icon.png /apple-icon.png /robots.txt /sitemap.xml /favicon.ico; do
  curl -s -o /dev/null -w "%{http_code} $r\n" "$BASE$r"
done
# only now create the room / seed the queue
```

The Playwright suite already handles this for itself (`warmTvRoutes` / `warmModerationRoutes` in `e2e/helpers.ts`, plus serial `workers: 1`), so this note is for **interactive** testing and for ad-hoc capture scripts — the paths that have no such helper. Production uses the durable Upstash driver and has no equivalent behaviour.

## Notes

- Queue is in-memory; it resets on server restart (prototype limitation — persistence is a later ticket).
- The venue screen (`/tv`) uses the official YouTube IFrame Player API. No API key is required.
- Run unit tests: `npm test`
- Run Playwright e2e: `npm run test:e2e` (starts dev server automatically if not already running). Parallel worktrees: `PORT=<3000+ticket#> npm run test:e2e` runs the whole suite on its own port (TICKET-18).
- `/tv` extras (TICKET-18): `F` or the on-screen affordance enters fullscreen (Esc exits); the "powered by Boraoke" + join footer is on by default — start with `POWERED_BY_FOOTER=0` to hide it (read at request time, no rebuild needed).
- `/tv` **focus state** (TICKET-103): while a song is playing, ~4s without input collapses the meta panel and top bar, grows the video to ~94% of the viewport, floats the join QR over the video, and reveals the up-next queue on a timer. Any input brings the full layout back — but use the **keyboard** (any key) to wake it, not the mouse: in the focus state the player iframe covers almost the whole screen, and a pointer event over a cross-origin iframe is delivered to that iframe, never to the app. This catches out hand-testers and automated captures alike.
