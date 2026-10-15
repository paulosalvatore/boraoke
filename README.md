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
2. **Karaoke index** (`lib/karaoke-index/`) — the uploads of 71 karaoke channels, harvested with `playlistItems.list` + `videos.list` (the separate 10,000-unit/day pool, never `search.list`) and searched in process memory over **song titles only** (channel names are not indexed: a channel called "… Karaokê Brasil" would otherwise match every one of its videos for `brasil`). It answers only a sing-mode first page with a confident match (`GOOD_MATCH_THRESHOLD` in `lib/karaoke-index/tier.ts`), at most 16 rows (two "load more" taps); "load more" past an index answer escapes to live search. Queries with more than 8 distinct words, and fuzzy typo scans beyond 2 per query, are bounded (hostile-input cost).
3. **Live `search.list`** — the fallback, behind the fail-closed daily budget (`lib/search-budget.ts`).

**Storage.** One Upstash key per channel (`ki:shard:<channelId>`, gzip+base64 JSON, ~1.46 MB total) plus `ki:stamps` (channelId → harvestedAt). Each row stores only videoId, title and duration; the channel title is stored once per shard (for display only). `ki:stamps` has **no TTL** on purpose: it holds only channel ids and timestamps (no API data beyond ids), and it must outlive an expired shard so the cron re-harvests that channel first.

**Loading and bandwidth.** Each instance loads the shards once and reloads hourly, but a reload first reads the tiny `ki:stamps` hash and skips the ~1.46 MB `MGET` when nothing changed — so a warm instance re-downloads the index about once a day (after the cron) plus once per cold start. A failed load is retried after 60 s, not an hour.

**Refresh and retention.** A Vercel Cron (`vercel.json`, daily 09:00 UTC; Hobby allows one run per day) calls `GET /api/cron/karaoke-index`, which re-harvests the oldest channels 6 at a time, starting no channel after 34 s and no page after 50 s (≤600 units/run, 60 s function limit). Simulated at the measured 0.54 s per Data API call: 18 channels per run, so all 71 channels — and the first fill — take about 4 daily runs (6 at 0.8 s/call), far inside the 30-day limit. Only complete channel harvests are written; a channel cut short by the deadline or an HTTP error never replaces a stored shard. Shards are written with a Redis TTL of 30 days and are never served once older than that (`INDEX_MAX_AGE_MS`), even by a warm instance — an expired or missing index means live search, never stale rows. The route is fail-closed: it needs `CRON_SECRET` (Vercel sends it as a bearer token), `YOUTUBE_API_KEY` and Upstash; without `CRON_SECRET` it refuses every call. The channel list is `lib/karaoke-index/channels.json` (channel ids only).

**Local / test-gate use.** Outside production, `KARAOKE_INDEX_FILE=<path to a .json.gz>` loads shards from a file when Upstash is not configured. The index needs no API key, so this exercises the index tier with zero quota. The harvested file is YouTube API data: it is **gitignored and never committed** — regenerate it locally and delete or regenerate it within 30 days:

```bash
YOUTUBE_API_KEY=… npm run index:harvest -- --channels lib/karaoke-index/channels.json \
  --out work/measurements/ticket-124/index-fixture.json.gz --max-units 1600 --max-pages 14
```

(~1,600 units of the 10k/day pool, zero `search.list`; never writes Redis. `--seeds-from-oracle work/measurements/ticket-108/production-search-results.json --channels-out …` re-derives the channel list from scratch.)

**Measurement.** `npm run measure:t124 -- --controls` (needs the local fixture above; it refuses to run without it) replays the real production traces through cache → index → live and prints calls per queued song and hit@10 across the threshold curve, the long-tail simulation, the answer-size sweep and the channel-collision probe. `work/measurements/ticket-124/refresh-sim.ts` simulates one cron run at a given per-call latency.

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
