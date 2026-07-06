# cantai

Cantai is a free, embeddable karaoke-queue platform any bar can run with zero setup: patrons join with a nickname, paste a YouTube URL for a song, and submit it to a shared queue; the venue screen plays the queue through the YouTube IFrame Player. Supports table numbers, sing vs listen/dance entries, and venue rotation modes (full karaoke, 2 per table, one per person). Free early access; professional paid plan later. Built-in feedback loop drives progressive development.

- **Stack:** Next.js (single app, App Router, TypeScript)
- **Deploy:** Vercel — live URL: **https://cantai-snowy.vercel.app**
- Built by the [agentic software house](https://github.com/paulosalvatore/agentic-software-house).

## Running locally

Requires Node.js 22 or later.

```bash
npm install
npm run dev
```

App runs on **http://127.0.0.1:3040**.

| Page | URL | Purpose |
|---|---|---|
| Patron | http://127.0.0.1:3040/ | Join with a nickname, submit YouTube songs, see the live queue |
| Venue screen | http://127.0.0.1:3040/tv | Full-screen YouTube player with auto-advance and now-playing info |

## Tests

```bash
# Unit tests (YouTube URL parser + queue ordering)
npm test

# Playwright end-to-end (submit a song → appears in queue)
npm run test:e2e
```

The Playwright e2e test automatically starts the dev server on port 3040 if not already running.

## Prototype limitations

- **Queue state is in-memory only — it can reset AND diverge.** Locally, the queue resets on server restart. On the hosted (Vercel) version, each serverless instance holds its own copy of the queue, so concurrent users may see *different* queues, and any queue can vanish when an instance is recycled. Persistent shared storage (database) is a later-ticket item; until it ships, treat hosted queues as best-effort.
- **Single room** — one shared queue for the whole venue. Multi-room / venue codes are scope-out.
- **No YouTube search** — patrons paste a YouTube URL (full, short, shorts, embed formats all supported). YouTube Data API text search requires an API key (needs-user item for a future ticket).
- **No auth / persistence / payments** — prototype phase.

## Tech notes

- YouTube playback uses the **official YouTube IFrame Player API** only (ToS-compliant). Media is never downloaded or proxied.
- No API keys or secrets required for this prototype.
- Port 3040 is dedicated to cantai in the agentic software house fleet.
