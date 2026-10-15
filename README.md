# Boraoke

Boraoke is a free, embeddable karaoke-queue platform any bar can run with zero setup: patrons join with a nickname, paste a YouTube URL for a song, and submit it to a shared queue; the venue screen plays the queue through the YouTube IFrame Player. Supports table numbers, sing vs listen/dance entries, and venue rotation modes (full karaoke, 2 per table, one per person). Free early access; professional paid plan later. Built-in feedback loop drives progressive development.

- **Stack:** Next.js (single app, App Router, TypeScript)
- **Deploy:** Vercel — live URL: **https://boraoke.com** (also reachable at https://cantai-snowy.vercel.app, which 308-redirects to the canonical domain)
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

## Song search tiers (karaoke index)

YouTube `search.list` is capped at 100 calls/day platform-wide, so `/api/search` answers in three tiers, cheapest first:

1. **Search cache** (`lib/search-cache.ts`) — 12h Redis + memory cache of live answers. Free.
2. **Karaoke index** (`lib/karaoke-index/`) — the uploads of ~60 karaoke channels, harvested with `playlistItems.list` + `videos.list` (the separate 10,000-unit/day pool, never `search.list`) and searched in process memory. It answers only a sing-mode first page with a confident match (`GOOD_MATCH_THRESHOLD` in `lib/karaoke-index/tier.ts`). "Load more" past an index answer escapes to live search.
3. **Live `search.list`** — the fallback, behind the fail-closed daily budget (`lib/search-budget.ts`).

**When live search may run (Enter / idle).** As the patron types, the client sends index-only lookups: tiers 1-2 only, never billed. The current client marks every request `v=2`; a v2 first-page request reaches tier 3 only when it also carries `live=1`, which the client sends on Enter (the phone keyboard's search key), once after `IDLE_SEARCH_MS` (4 s, `lib/search-trigger.ts`) of no typing when tiers 1-2 missed, or on "search again". A `pageToken` request ("load more") is a deliberate tap and may also bill. Without `live=1` the route answers `{ results: [], liveRequired: true }`, and the client shows a "press Enter to search YouTube" hint. A request without `v=2` is a legacy client (a page loaded before this shipped; venues keep pages open all night) and keeps the old cache → index → live fallback, still behind the cooldown, rate limits and daily budget. Residual: a client that omits the marker on purpose gets live fallback on every request, but the cooldown still holds it to one billed call per 2 s per uuid. The server enforces this (`lib/live-search-gate.ts`): index-only is the default, and a per-uuid cooldown (one billed attempt per 2 s, answered with `deferred` + `retryAfterMs`) stops a modified client from billing per keystroke. Index-only lookups have their own, more generous rate bucket. `npm run measure:t125 -- --controls` replays the traces with a stated pause model.

**Storage.** One Upstash key per channel (`ki:shard:<channelId>`, gzip+base64 JSON) plus `ki:stamps` (channelId → harvestedAt). Each row stores only videoId, title and duration; the channel title is stored once per shard.

**Refresh and retention.** A Vercel Cron (`vercel.json`, daily 09:00 UTC) calls `GET /api/cron/karaoke-index`, which re-harvests the oldest channels (≤400 units, ≤40s per run), so every channel is refreshed about weekly. Shards are written with a Redis TTL of 30 days and are never served once older than that (`INDEX_MAX_AGE_MS`) — an expired or missing index means live search, never stale rows. The route is fail-closed: it needs `CRON_SECRET` (Vercel sends it as a bearer token), `YOUTUBE_API_KEY` and Upstash; without `CRON_SECRET` it refuses every call. The channel list is `lib/karaoke-index/channels.json`.

**Local / test-gate use.** Outside production, `KARAOKE_INDEX_FILE=<path to a .json.gz>` loads shards from a file when Upstash is not configured (e.g. the test fixture `work/measurements/ticket-124/index-fixture.json.gz`). The index needs no API key, so this exercises the index tier with zero quota.

**One-off harvest.** `YOUTUBE_API_KEY=… npm run index:harvest -- --seeds … --out … --channels-out … --max-units N` (see `scripts/karaoke-index-harvest.ts`). It never writes Redis.

**Measurement.** `npm run measure:t124 -- --controls` replays the real production traces through cache → index → live and prints calls per queued song and hit@10 across the threshold curve.

## Prototype limitations

- **Single room** — one shared queue for the whole venue. Multi-room / venue codes are scope-out.
- **No YouTube search** — patrons paste a YouTube URL (full, short, shorts, embed formats all supported). YouTube Data API text search requires an API key (needs-user item for a future ticket).
- **No auth / payments** — prototype phase. (Durable queue persistence is available via the `upstash` driver — see [Persistence](#persistence).)

## Telemetry & privacy

Boraoke collects a small set of **anonymous** product events (song queued, song played, host actions, searches) to understand how venues actually use the product during free early access. In plain language:

- **Anonymous by design.** Events carry only a random patron id (the same one the queue uses), a room id, and a timestamp. No names, no free text, no IP addresses, no cookies, no ad/tracking SDKs — there is nothing here a consent banner would need to gate, and the design is LGPD-friendly.
- **No ads.** This data is never sold and never feeds an ad network; it only informs which features venues find valuable.
- **Never in your way.** Telemetry is fire-and-forget: if it fails, the queue and playback carry on untouched. Operators can disable it entirely with `TELEMETRY_DISABLED=1`.
- **Not kept forever.** Raw events expire after 90 days; only aggregated weekly numbers (per-venue tables, no individual behavior) outlive them.

The full schema and event list are documented in [`work/telemetry/README.md`](work/telemetry/README.md); a weekly human-readable rollup lives in `work/telemetry/rollups/`.

## Tech notes

- YouTube playback uses the **official YouTube IFrame Player API** only (ToS-compliant). Media is never downloaded or proxied.
- No secrets are required to run the default (memory) driver locally or in CI. Durable persistence (the `upstash` driver) needs Upstash Redis credentials — see [Persistence](#persistence).
- Port 3040 is dedicated to Boraoke in the agentic software house fleet.
