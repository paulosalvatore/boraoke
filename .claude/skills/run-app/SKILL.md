---
name: run-app
description: Start the cantai app locally on port 3040.
---

# run-app

## Quick start

```bash
cd /Users/paulosalvatore/Documents/GitHub/cantai  # or the active worktree path
npm install
npm run dev
```

The app starts on **http://127.0.0.1:3040**.

- Patron page: http://127.0.0.1:3040/
- Venue screen: http://127.0.0.1:3040/tv

## Worktree path (TICKET-1 branch)

```bash
cd /Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-1
npm install
npm run dev
```

## Port

**3040** — chosen to avoid conflicts with other house products (3000/3020/5434/5435 are taken).

## Notes

- Queue is in-memory; it resets on server restart (prototype limitation — persistence is a later ticket).
- The venue screen (`/tv`) uses the official YouTube IFrame Player API. No API key is required.
- Run unit tests: `npm test`
- Run Playwright e2e: `npm run test:e2e` (starts dev server automatically if not already running). Parallel worktrees: `PORT=<3000+ticket#> npm run test:e2e` runs the whole suite on its own port (TICKET-18).
- `/tv` extras (TICKET-18): `F` or the on-screen affordance enters fullscreen (Esc exits); the "powered by cantai" + join footer is on by default — start with `POWERED_BY_FOOTER=0` to hide it (read at request time, no rebuild needed).
