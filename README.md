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

## Persistence

Queue state lives behind a single store interface (`lib/store.ts`) with two interchangeable drivers, selected by environment:

| Driver | When | Durable / shared? |
|---|---|---|
| `memory` (default) | local dev & CI — no credentials needed | No — per-process, resets on restart, diverges across serverless instances |
| `upstash` | production — set when Upstash Redis credentials are present | Yes — shared across all lambda instances, survives redeploys |

Driver resolution:

- `STORE_DRIVER=upstash` or `STORE_DRIVER=memory` forces a driver.
- Unset: `upstash` when `UPSTASH_REDIS_REST_URL` is configured, otherwise `memory`.

The Upstash driver uses [Upstash Redis](https://upstash.com/) via the Vercel Marketplace integration (HTTP-based, serverless-safe). Provision the database on the Vercel project, which sets `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` in the deployment env. Copy `.env.example` to `.env` to run the Upstash driver locally. All keys are room-scoped (`room:<roomId>:*`), ready for multi-room without a schema change.

**Atomic writes (no lost submits).** The queue is a Redis LIST: submits are an atomic `RPUSH` and playback advance is an atomic `LPOP`. The ordering ops that must read the whole queue, re-order it, and write it back — the rotation re-lay (`rewrite`) plus the host `removeEntry`/`reorder` — run their read-modify-write **atomically server-side via a single Lua `EVAL`** (`MERGE_SCRIPT` in `lib/store/upstash.ts`). This closes a lost-update window where a concurrent submit landing between a re-lay's read and its write-back could be silently dropped. The script re-lays the desired order while **preserving any entry appended after the caller's read** and dropping any entry removed under it, so a racing submit can never vanish. (Upstash's REST transport has no `WATCH`/optimistic-locking and its `MULTI` only pipelines a fixed command list, so Lua is the atomic primitive.) The in-memory driver is single-process and implements the same merge contract, so both drivers pass one shared conformance + concurrency-regression suite (`__tests__/store.test.ts`).

## Prototype limitations

- **Single room** — one shared queue for the whole venue. Multi-room / venue codes are scope-out.
- **No YouTube search** — patrons paste a YouTube URL (full, short, shorts, embed formats all supported). YouTube Data API text search requires an API key (needs-user item for a future ticket).
- **No auth / payments** — prototype phase. (Durable queue persistence is available via the `upstash` driver — see [Persistence](#persistence).)

## Telemetry & privacy

Cantai collects a small set of **anonymous** product events (song queued, song played, host actions, searches) to understand how venues actually use the product during free early access. In plain language:

- **Anonymous by design.** Events carry only a random patron id (the same one the queue uses), a room id, and a timestamp. No names, no free text, no IP addresses, no cookies, no ad/tracking SDKs — there is nothing here a consent banner would need to gate, and the design is LGPD-friendly.
- **No ads.** This data is never sold and never feeds an ad network; it only informs which features venues find valuable.
- **Never in your way.** Telemetry is fire-and-forget: if it fails, the queue and playback carry on untouched. Operators can disable it entirely with `TELEMETRY_DISABLED=1`.
- **Not kept forever.** Raw events expire after 90 days; only aggregated weekly numbers (per-venue tables, no individual behavior) outlive them.

The full schema and event list are documented in [`work/telemetry/README.md`](work/telemetry/README.md); a weekly human-readable rollup lives in `work/telemetry/rollups/`.

## Tech notes

- YouTube playback uses the **official YouTube IFrame Player API** only (ToS-compliant). Media is never downloaded or proxied.
- No secrets are required to run the default (memory) driver locally or in CI. Durable persistence (the `upstash` driver) needs Upstash Redis credentials — see [Persistence](#persistence).
- Port 3040 is dedicated to cantai in the agentic software house fleet.
