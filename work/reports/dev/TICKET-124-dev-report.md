# TICKET-124 — Dev report

## Status
Implemented, measured, and self-verified. Draft PR open and awaiting the TM. Quality floor holds: hit@10 went from 79% to 89%. Not merged.

## Context
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t124-index-primary`
- Branch: `ticket/124-index-primary` (base `af080ca`)
- App/e2e port: 3124
- PR: see the Log below once opened.
- Plan: `work/plans/TICKET-124-plan.md` (approved via the TM's dispatch brief plus its two addenda).

## Log

### 2026-10-14 first pass: stopped, the spike's index was never committed
The 36,372-row index from TICKET-106 does not exist anywhere: not on any branch, not in any scratchpad. No boraoke or YouTube key is in the vault either. Without a live harvest there was nothing to measure, so I stopped and reported per the brief. The TM approved option 1: re-harvest once with the production key.

### 2026-10-14 harvest (production key, zero search.list)
- **Key handling (`handle-secret`):** `vercel env pull --environment=production` went into `<scratchpad>/t124/prod.env`. Only `YOUTUBE_API_KEY` was exported into the harvest process, via `env -i`. The values were never printed. The file was deleted by an EXIT trap (`rm -P`) and its absence was verified: "env file deleted: …/prod.env absent". The key was not enrolled in the framework vault.
- **10k-pool usage before harvesting**, probed read-only with the KV read-only token. Positive control: PING→PONG, DBSIZE 101. Readings: `sb:2026-10-14 = 1` (1 search.list today), `sb:2026-10-13` absent, live `ec:` (embeddability checks, 24h TTL) = 0, live `sc:` = 1. The app's own non-search use of the 10k pool comes from two places: one `videos.list` unit per live search, plus embeddability checks. Today that was about 1-2 units. That is an upper bound derived from the app's code paths. The Google Cloud console figure is UNVERIFIED because I have no console access.
- **Seeds:** 316 karaoke-named channels from the production oracle, ranked by the number of production result rows each supplied (`work/measurements/ticket-124/seeds.json`). They resolved to 315 channels for 7 units.
- **Harvest:** 71 channels, 38,275 videos (all distinct), **1,599 units** (7 for seed resolution, about 796 `playlistItems.list` pages, about 796 `videos.list` calls for duration and playability), **0 search.list**. Took 868 s. The output is 1,093,956 bytes gzipped. The full per-channel log is `work/measurements/ticket-124/HARVEST-LOG.txt`. The 71st channel ("Palco Karaoke") was cut by the unit cap at 150 rows.
- Why 1,599 and not 741: the Global TM addendum requires a stored duration per row. Getting it costs one `videos.list` unit per 50-row page, which doubles the spike's 741. The same call also filters out non-embeddable, non-public, BR-blocked and P0D (live/upcoming) videos. 1,599 is 16% of one day's 10k pool, which the app otherwise uses at about 1-2 units/day.

### 2026-10-14 build
- `lib/karaoke-index/`:
  - `harvest.ts`: guarded harvest that refuses any search URL before the fetch; has a unit ledger.
  - `matcher.ts`: posting lists plus a sorted vocabulary, matching exact (1.0), prefix (0.8) and bounded typo (0.5). Confidence is the mean token quality of the best full-coverage row.
  - `tier.ts`: routing plus the threshold and its justification.
  - `store.ts`: Upstash shards and in-memory load with retention filtering.
  - `refresh.ts`: picks the oldest channels and works within a budget.
  - `types.ts`: shard shape, `harvestedAt`, `INDEX_MAX_AGE_MS` = 30 days.
- `app/api/search/route.ts`: now cache → index → live. The index answer carries `nextPageToken: "IDXLIVE"`, so "load more" escapes to a live first page with no client change. Telemetry `search_performed` gains `source: cache|index|live`. The no-key degraded check moved below the cache and index, since neither needs a key.
- `app/api/cron/karaoke-index/route.ts` plus `vercel.json` `crons` (daily 09:00 UTC). Fail-closed on `CRON_SECRET`, constant-time bearer compare, at most 400 units and 40 s per run, `maxDuration` 60.
- `scripts/karaoke-index-harvest.ts`, `npm run index:harvest`, `npm run measure:t124`.
- `lib/search-prefix.ts`: exports `discriminatingTokens` (a refactor; `filterResults` behaviour is unchanged).
- README "Song search tiers" section; `.env.example` documents `CRON_SECRET` and `KARAOKE_INDEX_FILE`.

### 2026-10-14 measurement (`npm run measure:t124 -- --controls` → `work/measurements/ticket-124/RESULTS.txt`)
Same oracle, traces, 28 gradable queries and hit predicate as TICKET-108. The client runs the shipped policy (MIN_CHARS 4, MIN_LOCAL_MATCHES 3).
- **Calls per queued song: BEFORE 2.25 (re-measured: 48 billed over the traces) → AFTER 1.22 (26 billed; 20 fetches answered by the index).** Why AFTER still bills: 14 fetches are listen-mode (no "karaoke"; the index never answers them) and 12 are weak matches.
- **hit@10: 79% (22/28) → 89% (25/28).** hit@1 went from 68% to 86%. Nothing is newly missed. Newly hit: `escu`, `escurinho do cin`, `borb` (partial words where the index's prefix match beats live search).
- Index alone with no fallback: hit@10 82% (the spike measured 66% with a different matcher and index).
- Latency: 1.8 ms/query in-process (the spike's naive scan took 91 ms). Index build takes about 315 ms per cold instance.
- **Threshold curve** (minChars 3-6 × threshold 0.5-1.0) and a **long-tail simulation** (the wanted song is removed from the index, so a confident index answer is a false answer): 0.5 gives 4/18 false answers; 0.6-0.8 give 3/18; 0.9-1.0 give 0/18 but bill 1.45-1.59/song and hit@10 falls to 82%/79%. **Chosen: 0.8, minChars 4.** The justification is in `tier.ts`.
- Controls:
  - C1 (empty index) reproduces BEFORE exactly (48 billed, 22 hits).
  - C2 (threshold removed) raises long-tail false answers from 3 to 4. On the in-index replay a lax threshold is nearly free, which I'm disclosing rather than hiding.
  - C3 (scrambled titles) drops hit@10 to 12.
  - C4 (empty rows) gives 0.

### 2026-10-14 tests + prove-can-fail
New suites: `karaoke-index-harvest`, `karaoke-index-matcher`, `karaoke-index-store-refresh`, `api-search-index-tier` (37 tests). The store test caught a real bug: `load()` filtered freshness on `Date.now()` instead of the `now` passed in. Fixed by threading `now` through.

Mutation pass (each mutation was restored after the run):

| Mutant | Caught by |
|---|---|
| M1 threshold removed (`< 0`) | matcher: "goes live below the threshold", "boundary is inclusive" |
| M2 boundary `<` → `<=` | "boundary is inclusive" |
| M3 sing-mode gate removed | "never answers listen/dance mode" |
| M4 retention check → `true` | "freshShards drops expired", "never serves an expired shard… warm instance", "fresh until INDEX_MAX_AGE_MS" |
| M5 search guard removed | "refuses any search endpoint" |
| M6 index placed before the cache | "the cache stays in front of the index" (+ escape test) |
| M7 reverse-check: index tier removed (pre-ticket routing) | "answers … with ZERO search.list calls", "works without an API key" |
| M8 escape sends the sentinel to Google | "'load more' past an index answer runs the LIVE first page" |

Triggered mutation pass: not triggered. There is no new parsing/normalisation function on a money/quantity/identity path; the matcher normalises song titles and reuses the existing `normalizeQuery`.

### 2026-10-14 self-verification
- jest: **59 suites / 1,033 passed, 5 skipped, 0 failed** (1,038 total). Load average about 8-10 on 10 cores; the harvest had finished.
- `npm run build`: OK. `bundle-es-target: OK`, `css-target: OK` (TV surface). The CSS findings are advisory only and pre-existing. `/api/cron/karaoke-index` is in the app-paths manifest.
- e2e: **127/127 passed in 3.9 min**, `workers: 1`, `PORT=3124`. COLD: the worktree was new, so the `.next-e2e` build was fresh. Load average was 7.2 at the start and 5.2 at the end on 10 cores, with no other suite running. `e2e/_canary` passed, and so did the known load-dependent flake `e2e/tv.spec.ts:740`. Note that `e2e/search.spec.ts` mocks `/api/search`, so e2e proves the client is unaffected; the server-side tier is covered by jest.
- Live smoke (`next dev -p 3124`, `KARAOKE_INDEX_FILE` = fixture, no API key, memory store):
  - `evidencias karaoke` → `source:index`, 25 rows, `next:IDXLIVE`, durations present.
  - `escurinho do cin karaoke` → index, Rita Lee "Flagra (No Escurinho do Cinema)".
  - `soda stete karaoke` → weak match, so live, so `degraded:no-api-key` (correct, since no key).
  - `evidencias` (listen mode) → live, so degraded.
  - `GET /api/cron/karaoke-index` with no `CRON_SECRET` → 503 (fail-closed).
  - Server stopped by PID; port freed.

## Friction
- The spike's harvested data was kept only in a scratchpad and is gone, which cost a full re-harvest. Measurement inputs need to be committed with the code that produced the numbers; this ticket commits its seeds and fixture for that reason.
- The `jest` CLI with two quoted paths in one argument silently matched nothing (no "Tests:" line). Re-ran with separate patterns. A mutation pass must check that a suite actually ran, not only that nothing failed.
