# TICKET-124 — Dev report

## Status
Fix batch for Reviewer REQUEST-CHANGES (B1–B3) and Security PASS-WITH-NOTES (S1, S2) has been pushed to draft PR #88, with the nits and the fixture decision done too. hit@10 is still 89% (floor 79%) and calls per song are still 1.22. Not merged. Gates still need re-running: App Tester first, per D-007.

## Context
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t124-index-primary`
- Branch: `ticket/124-index-primary` (base `af080ca`)
- App/e2e port: 3124
- PR: #88 https://github.com/paulosalvatore/boraoke/pull/88 (draft)
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

### 2026-10-14 draft PR opened
#88 (draft) carries the measurement tables, the retention section, the seeding-bias caveat and the Testing Handoff. Implementation commit: `a680764`. Not merged. Open items for the TM:
- Set `CRON_SECRET` in production.
- Do the first population after deploy.
- Decide what to do with the committed fixture's retention: it will be older than 30 days on 2026-11-13.

### 2026-10-14 fix batch (Reviewer issuecomment-6181463773, Security issuecomment-6181443158)

**B1. Index titles only** (`34ab73f`)
- Postings are now built from `queryTokens(title)`. The channel title is kept for display only.
- New unit test: "channel names never satisfy a query word (the 'brasil karaoke' collision)". It fails when channel words are indexed again (MB1).
- The replay now grades on the TITLE only, for both arms; `--legacy-predicate` restores title+channel. It also has a CHANNEL-COLLISION PROBE covering 10 channel words.
- With channel matching re-enabled, the probe reports `"brasil karaoke": index 16 rows, 16 without "brasil" in the title`.
- I confirm the Reviewer's numbers with title-only postings: 1.22/song, hit@10 25/28, long-tail 3/18.
- Honest note: the 28-query grade alone still does not move under channel matching (it stays 1.22 / 25/28). The probe is what catches it.

**B2. Two hollow tests fixed; each fails when its guard is deleted**
- (a) "a warm instance rebuilds the MOMENT its oldest shard expires, not at the hourly reload". The shard is 10 min inside the limit and the clock steps 20 min, well under the 1 h reload. MA (expiry check → `false`) fails it.
- (b) "never writes a channel cut short by the TIME budget". It uses a 3-page channel at 20 ms per call with a 30 ms hard deadline; page 1 is really harvested (2 units) before the cut. MD (`r.shard && r.complete` → `r.shard`) fails it, and also fails "never writes a channel cut short by an HTTP error mid-channel".

**B3. Refresh throughput** (`9a61d42`)
- Workers run 6 channels at once. No channel starts after 34 s and no page starts after 50 s, inside the 60 s Hobby limit.
- Each channel's full unit budget is reserved up front and the unused part is refunded, so the unit cap can never cut a channel short. The run cap is 600 units.
- `refresh-sim.ts` runs the real code and clock against a fake API at the measured latency (`REFRESH-SIM.txt`). Each line below is a single run:
  - 0.543 s/call: 18 channels/run, 504 units, 45.8 s, so 71 channels take 4 daily runs.
  - 0.8 s/call: 12 channels/run, 6 runs.
  - 0.3 s/call: 21 channels/run, 4 runs.
- The Vercel cron stays daily; Hobby allows one run/day per job. That gives a full cycle and first fill of about 4–6 days, against the 30-day limit.
- Latency measured from inside a Vercel function: UNVERIFIED.

**S1. Hostile queries**
- More than 8 distinct discriminating words gives no index answer (`query-too-long`). At most 2 fuzzy vocabulary scans per query.
- Tests: the crafted 18-word query is refused with 0 scans in under 25 ms (MS1a kills it), and 8 near-miss words cost exactly 2 scans (MS1b kills it; the test was strengthened after the first version survived MS1b).
- Measured on the real fixture: normal query 0.5 ms, 18 typo words 0.0 ms, worst case of 8 near-miss words 18 ms. Security measured about 220 ms before the fix.

**S2. Cron auth tests** (`2c49bcb`)
- Unset/empty secret gives 503. Eight wrong or near-miss bearers give 401, with the secret never in the body. The correct bearer gives 200 with exactly one refresh. A missing key gives 503. Refresh is never called on any rejection.
- MS2a (bearer check removed) and MS2b (fail-closed removed) are both killed.
- The test secret is generated at runtime. The first version used a literal, and the commit secret-scan correctly refused it.

**Nits** (`5d32ad0`, plus `34ab73f` for the answer cap and `9a61d42` for the partial-write guard)
- Sing-mode is checked before the index loads. MN1 is killed by "…without even loading the index".
- A failed Redis load now retries after 60 s (MN2 killed).
- Hourly reloads read `ki:stamps` first and skip the ~1.46 MB MGET when nothing changed (MN3 killed). A warm instance therefore downloads the index about once a day plus once per cold start.
- Index answers are capped at 16 rows. The sweep at 10/16/24/50 gives identical billed calls and hit@1/5/10, so the cap only changes how many taps it takes to reach live: 2 versus 7 (MN4 killed).
- A partial shard after an HTTP error mid-channel is never written.
- `ki:stamps` has no TTL; that is documented, along with why.
- Upstash free-tier bandwidth limit: UNVERIFIED. The arithmetic: a full load is about 1.46 MB, so 1 GB covers about 680 full loads.

**Fixture (TM decision)** (`b899360`)
- `index-fixture.json.gz` is removed from the branch tip and gitignored. It is kept local only and regenerated with `npm run index:harvest -- --channels lib/karaoke-index/channels.json --out … --max-units 1600 --max-pages 14`.
- The replay exits 2 with that command when the fixture is absent; I verified this.
- `seeds.json` (titles + videoIds) is removed. `--seeds-from-oracle` re-derives the identical 316 seeds from the committed oracle (verified as the same order and ids).
- `HARVEST-LOG.txt` now has channel ids instead of titles. `channels.json` (ids only) is kept.
- No force-push. The fixture stays in branch history; squash-merge keeps it off main.

**Verification**
- jest: 61 suites, **1,049 passed**, 5 skipped, 0 failed. Run at load 12.5 → 13.2 on 10 cores, with no other suite running. The t125 lane had been building just before; I waited until it was idle.
- e2e: **127/127 passed (4.0 min)**, `workers: 1`, `PORT=3124`. WARM: `.next-e2e` was from the previous run and `next build` rebuilt it. Load was 8.9 at the start and 19.7 at the end; another lane's processes started during the run. `_canary` passed, and so did `tv.spec.ts:740`.
- `tsc --noEmit`: zero errors in app/lib/scripts/measurements.
- `npm run measure:t124 -- --controls`: see `RESULTS.txt`. It reports 2.25 → 1.22 and 79% → 89%. C1 is identical, C2 rises 3 → 4, C3 drops to 12, C4 is 0, and the collision probe shows 0 channel-only rows.

## Friction
- The spike's harvested data was kept only in a scratchpad and is gone, which cost a full re-harvest. Measurement inputs need to be committed with the code that produced the numbers; this ticket commits its seeds and fixture for that reason.
- The `jest` CLI with two quoted paths in one argument silently matched nothing (no "Tests:" line). Re-ran with separate patterns. A mutation pass must check that a suite actually ran, not only that nothing failed.
