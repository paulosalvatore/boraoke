# EPIC — Song catalogue (map main songs to YouTube video IDs; live search only as fallback)

Read-only research + plan for the boraoke Product TM, 2026-10-15. Code read from the `main` checkout (no `.worktrees/`). No commits, no YouTube Data API calls. Web sources fetched 2026-10-15. Three read-only Wikidata SPARQL counts were run (public endpoint, no key, no quota).

TL idea (verbatim): "if we cant find the song on the list, we can search yt automatically. This just raised me an idea that we can start to map all the main songs, get all karaoke lists we have available public, and start to map the youtube video ID, thumb, youtube title, song name, etc, so we build a very good catalogue and overcome this search problem, only falling back to youtube search when needed, caching the song if we find something. Working for both karaoke and no-karaoke songs."

## Headline

1. **About half of this already exists.** The TICKET-124 index is a karaoke-only catalogue: 71 channels, 38,275 rows, refreshed daily, 30-day expiry. What is missing: song/artist fields (rows hold only the raw YouTube title), original (non-karaoke) versions, and growth from patron picks (137).
2. **The quota premise needs correcting.** Since 2026-06-01 `search.list` has its **own bucket**: 100 calls/day, 1 unit per call. It does **not** consume the 10,000-unit pool. Boraoke uses 90/day of it (`lib/search-budget.ts:98,114`). So "90 searches = 9,000 units" no longer holds, and the whole 10k pool is available for harvesting apart from the ≤600-unit daily refresh and the embed checks. Source: https://developers.google.com/youtube/v3/determine_quota_cost (last updated 2026-10-08): "The `search.list` and `videos.insert` methods have their own quota buckets."
3. **Biggest remaining win: originals, not more karaoke.** In the 124 replay, 14 of the 26 billed calls were `not-sing-mode` (listen/dance always go live, `lib/karaoke-index/tier.ts:117`). The other 12 were `weak-match` (`work/measurements/ticket-124/RESULTS.txt`, "why AFTER still billed").
4. **Legal shape.** Anything that comes from YouTube is API Data and must be refreshed or deleted within 30 days. That includes title, duration, playability and probably the videoId mapping itself. The *song list* (title/artist) can come from CC0 sources (MusicBrainz core, Wikidata, ListenBrainz) and kept permanently. So the design splits into **songs = our data, permanent** and **links = YouTube data, refreshed ≤30 d**. Refreshing is cheap (`videos.list` costs 1 unit per 50 IDs).

## (a) What the current index covers

| Property | Today | Evidence |
|---|---|---|
| Channels | 71 karaoke/playback channel IDs, ranked by how often production search surfaced them | `lib/karaoke-index/channels.json:1-73`; seed method `scripts/karaoke-index-harvest.ts:16-25,69-89` (channel name must match `/karaok\|playback/i`, `:77`) |
| Rows | **38,275** measured (the brief's "~38,825" doesn't match any figure in the repo). 1,599 units, 868 s, 0 `search.list` | `work/measurements/ticket-124/HARVEST-LOG.txt` (end); `lib/karaoke-index/store.ts:6` |
| Per-channel cap | 14 pages × 50 = 700 newest uploads. Many channels hit exactly 700, so their back catalogues are truncated | `lib/karaoke-index/refresh.ts:46`; HARVEST-LOG (most channels "700 rows in 28 units") |
| Fields stored | `[videoId, title, duration]` per row, plus `channelTitle` and `harvestedAt` once per shard. **No thumbnail** (built from the ID at read time, `i.ytimg.com/vi/<id>/mqdefault.jpg`). No description or stats | `lib/karaoke-index/types.ts:10-26`; `lib/karaoke-index/tier.ts:99-102` |
| Song/artist parsing | **None.** The matcher tokenises the raw title only. Channel names are deliberately not indexed (channel-collision fix). `artist` appears nowhere in `lib/` or `app/` | `lib/karaoke-index/matcher.ts:9-28,117-140` |
| Playability filter | public, processed, embeddable, not blocked in BR, real duration | `lib/karaoke-index/harvest.ts:148-166` |
| Language/genre skew | **UNVERIFIED (not measurable here).** The fixture `work/measurements/ticket-124/index-fixture.json.gz` is gitignored and absent, and channel titles aren't in the repo. Qualitatively: channels are the ones YouTube surfaced for real Brazilian bar queries, so PT-BR heavy. The 106 spike found gaps in the funk/reggaeton/party long tail ("Bandoleros", "Cerol na Mão", "Na Boca da Garrafa" absent) | `work/reports/TICKET-106-spike.md:201`; current misses `banderille(ros)`, `soda stete` in RESULTS.txt |
| Matching | AND over discriminating tokens. Exact 1.0 / prefix 0.8 / bounded typo 0.5. Serves only at confidence ≥ 0.8 with ≥ 4 chars. 16 rows, `IDXLIVE` escape | `matcher.ts:43-60,180-232`; `tier.ts:42,49,59,71,104-135` |
| Quality | hit@10 79% → **89%**, billed/song 2.25 → 1.22 (124). 125 later brought billed/song to 0.89 | `ticket-124/RESULTS.txt` "SHIPPED VALUES"; `SCOPE-search-cache-pagination.md` §4 |
| Storage | Upstash Redis, one key per channel `ki:shard:<id>` = base64(gzip(JSON)), ~20 KB/key, ~1.46 MB total; `ki:stamps` hash (no TTL, IDs + timestamps only) | `store.ts:4-17,46-54,77-79,102-107` |
| Read path | Per-instance in-memory build. Reload hourly, but only re-download when stamps change. Fail-open to live | `store.ts:19-29,44,158-219` |
| Refresh | Vercel cron daily 09:00 UTC → `GET /api/cron/karaoke-index`. Fail-closed on `CRON_SECRET` (503 if unset, constant-time bearer compare). ≤600 units/run, 6-way concurrency, start cutoff 34 s, hard deadline 50 s, `maxDuration` 60. ~18 channels/run, so a ~4-6 day cycle. Only complete harvests are written | `vercel.json` crons; `app/api/cron/karaoke-index/route.ts:22-60`; `refresh.ts:17-46,82-131` |
| Retention | `INDEX_MAX_AGE_MS` = 30 d hard stop (never served past it) + Redis TTL = 30 d from `harvestedAt` (auto-delete if the cron dies) + refresh target 7 d | `types.ts:28-53`; `store.ts:102-107,204-219` |
| Search guard | Every harvest URL goes through `assertNoSearchList()` | `harvest.ts:30-36,87` |
| Cache interplay | Index answers are not written to the search cache. A cached live page for the same key shadows the index for 12 h | `app/api/search/route.ts:177-198`; SCOPE doc §1 |

## (b) Public song-list sources and ToS

"Main songs" = which songs to have. The catalogue needs (1) a song/artist list and (2) a YouTube ID per song. Sources rarely give (2).

| Source | What it gives | Licence / ToS for storing + commercial use | Access | Verdict |
|---|---|---|---|---|
| **MusicBrainz core** | Artists, recordings, works, ISRCs, aliases, artist country. Also URL relationships (artist → official YouTube channel; some recordings → YouTube video URL) | Core data **CC0**. Supplementary (tags, ratings, stats) **CC BY-NC-SA 3.0**: non-commercial, don't use for a commercial product. https://musicbrainz.org/doc/About/Data_License | Full Postgres dump (`mbdump.tar.bz2` is core). https://musicbrainz.org/doc/MusicBrainz_Database/Download. API limit 1 req/s/IP plus a contactable User-Agent: https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting | **Use (primary song/artist spine).** **UNVERIFIED:** whether URL-relationship tables are in the CC0 core dump (likely, not confirmed on the page); how many BR recordings carry a YouTube link |
| **Wikidata** | Songs/singles with `P1651` YouTube video ID; artists with `P2397` YouTube channel ID; genres, languages, aliases | **CC0** (https://www.wikidata.org/wiki/Property:P1651) | SPARQL or dumps | **Use for artist → channel ID** (zero YouTube quota). Measured today: ~40,556 song/single/composition items with `P1651` worldwide, but only **~307** items by Brazilian-citizen performers and **30** in pt-BR. **476** Brazilian-citizen musicians have `P2397`. So it is thin for BR song→video IDs and useful for BR artist→channel |
| **ListenBrainz** | Listen-based popularity/stats ("main songs" ranking) keyed by MusicBrainz IDs | Listen data stated **CC0** (secondary sources: https://alternativeto.net/software/listenbrainz/about; dumps https://listenbrainz.readthedocs.io/en/latest/users/listenbrainz-dumps.html) | Dumps (full twice a month) + API (Statistics/Popularity) | **Use for intl popularity. UNVERIFIED:** licence wording from a primary page; BR user base probably small, so BR popularity is weak |
| **Discogs** | Releases/artists/tracklists | Monthly dumps **CC0**. API data partly "restricted" under the API ToS (secondary copies of the Discogs dev page; the primary returned 403) | XML dumps | Optional (genre/discography backfill). **UNVERIFIED** from the primary page |
| **Spotify charts / Web API** | Charts, track metadata | Developer Terms (v10, 2025-05-15) forbid it outright: "may not store, aggregate or create compilations or databases of Spotify Content", no indexing of playlist data, licence is "private personal use". https://developer.spotify.com/terms | API | **Exclude** |
| **Deezer API** | Charts incl. BR | "strictly limited for a non-commercial purpose"; content "strictly private use". https://developers.deezer.com/termsofuse | API | **Exclude** |
| **Last.fm API** | Top tracks/charts by country | Non-commercial only without a commercial agreement; 100 MB cap; attribution required. https://www.last.fm/api/tos | API | **Exclude** (unless the TL negotiates a commercial deal) |
| **KaraFun catalogue** | Full karaoke catalogue + "1,000 most popular" as PDF/CSV, publicly downloadable | Redistribution/commercial ToS **not found → UNVERIFIED**. https://karafun.com/blog/777-tip-of-the-month-printing-and-editing-the-song-catalog.html | Public CSV | **Ask before use.** Could serve as a "which songs are karaoke-worthy" seed (titles/artists only, no IDs). Risk: compilation/database rights (Brazil Lei 9.610/98 art. 7 XIII protects compilations; EU sui-generis database right), **UNVERIFIED legal** |
| **Videokê / RAF / Musicbox machine lists** | Song codes + title + artist (PT-BR heavy) | No official public list found. What exists is reseller/Scribd PDFs (e.g. https://pt.scribd.com/document/904904439/41H). **UNVERIFIED** ownership/ToS | Scraping third-party uploads | **Exclude** (provenance unclear, would be scraping) |
| **Boraoke's own patron picks** | Exactly what bar patrons queue (the real "main songs" for this product) | Our own usage data. The videoId came from `search.list`, so the *link* is API Data (30 d). The fact "a patron in room X queued song S" is ours | 137 + telemetry (`song_queued` has no videoId today, `lib/telemetry-types.ts:27`) | **Use: the best BR-bar popularity signal there is** |

### YouTube API Services rules on storing data (verified 2026-10-15)

Developer Policies, https://developers.google.com/youtube/terms/developer-policies (last updated 2026-09-14):

- **III.E.4 (non-authorized data, which covers everything boraoke reads with an API key):** stored API Data must be refreshed or deleted after **30 calendar days**. III.E.4.d allows only "limited amounts" of Non-Authorized Data, temporarily, for no longer than 30 days.
- **III.E.4.e:** must use reasonable efforts to keep stored API Data consistent with current data.
- **III.E.4.h:** must not "replace API Data with similar, independently calculated data" or "use API Data to create new or derived data or metrics".
- **III.E.1.a:** no caching or storing of audiovisual content (not relevant: we store no media).
- **"Video IDs may be stored indefinitely": NOT in the current text.** The page has no clause naming video IDs or identifiers (searched for "identifier", "video ID", "ID", "indefinitely"). So the premise in the brief is **UNVERIFIED and should be treated as false**. Default: a videoId *obtained from the API* is API Data and falls under the 30-day rule. A videoId from a non-API source (CC0 Wikidata `P1651`, MusicBrainz URL rel, a patron's pasted link) is not API Data by origin. **UNVERIFIED legal:** whether re-validating such an ID with `videos.list` makes it API Data.
- **Song/artist parsed from YouTube titles** is arguably "derived data" from API Data (III.E.4.h). **UNVERIFIED legal.** Conservative rule: a parsed song entity becomes permanent only when a non-YouTube source (MusicBrainz/Wikidata) or a patron's own typing corroborates it. Otherwise it expires with its link.
- **III.E.4.h "independently calculated data":** replacing YouTube's search with our own ranking over stored API data is the 124 design already in production. **UNVERIFIED** whether a reviewer would read the catalogue as "replacing API data". It is worth a line in the quota form's compliance description (`work/youtube-quota-form.md`).
- API ToS (https://developers.google.com/youtube/terms/api-services-terms-of-service, last updated 2026-09-14) §15: no circumventing quota. Harvesting with the official API inside the 10k pool doesn't circumvent anything. Creating extra GCP projects to multiply the pool would (secondary source); don't.
- **Thumbnails:** not stored. Built from the ID at read time (`tier.ts:99-102`). Keep it that way.

**How today's code handles retention:** shards carry `harvestedAt` and are never served past 30 d (`types.ts:38,47-53`). The Redis TTL deletes them at 30 d even if the cron dies (`store.ts:102-107`). The refresh targets 7 d (`types.ts:44`). The `ki:stamps` hash keeps only channel IDs + timestamps, with no TTL (`store.ts:47-54`). **Gap:** the `ki:stamps` choice relies on "IDs are fine to keep", which is the same unverified premise. Low risk (channel IDs only), but it belongs in the ToS memo (ticket 141).

## (c) Mapping song → videoId without `search.list`

| Method | Units | Gives | Notes |
|---|---|---|---|
| `playlistItems.list` on a channel's uploads playlist (`UC…`→`UU…`, `harvest.ts:143-146`) + `videos.list` for playability | 2 units per 50 rows (measured 1,599 units / 38,275 rows = **~24 rows/unit**) | id, title, channel, duration, playability | The workhorse. Today's path |
| Same, on **official artist channels** (originals for listen/dance) | same | official videos | Channel IDs come from Wikidata `P2397` / MusicBrainz URL rels = **0 YouTube units**. `channels.list` by handle = 1 unit when needed |
| Same, on **"Artist – Topic"** auto-generated channels | same | audio "art tracks" | **UNVERIFIED:** whether Topic channels expose a usable `UU` uploads playlist and whether art tracks are embeddable. The 106 spike saw `Zé Ramalho - Topic` in production results. Spike before relying on it |
| `videos.list` refresh by ID | 1 unit per 50 IDs | refresh title/duration/playability; drop dead IDs | For links not tied to a harvested channel (patron picks, Wikidata IDs). 30-day upkeep |
| oEmbed `youtube.com/oembed?url=…` | 0 units (not a Data API method) | title, author, thumbnail | Already used as an independent verifier in the 106 spike (`TICKET-106-spike.md:266`). It doesn't give embeddability/region/duration, so it can't replace `videos.list`. **UNVERIFIED:** whether oEmbed falls under "YouTube API Services" (the ToS definition doesn't mention it) and its rate limits. Don't use it as a bulk path |
| Patron picks (**TICKET-137**, promoted) | 0 extra (the search already happened) | exactly the songs bars want, incl. long tail | Cache every queued live result as a link (kind from the parser). Data comes from `search.list`, so 30-day rule, renewable via `videos.list` refresh while still being queued |
| `search.list` | own bucket, 100/day (90 budgeted) | anything | **Never for bulk.** 10k songs would take 111 days of the whole daily budget. On-demand fallback only (TL: automatic fallback is fine, see 138) |

**Cost per 10,000 songs (links):**
- First harvest from channels: ~420 units (≈ 10,000 / 24).
- 30-day upkeep: re-harvest ≈ 420 units per cycle (~14/day), or by-ID refresh ≈ 200 per cycle (~7/day).
- Via `search.list`: 10,000 calls, not viable.

**Daily budget split (proposal).** The 10k pool is separate from the 90/day search bucket:

| Use | Units/day |
|---|---|
| Existing karaoke refresh (`REFRESH_MAX_UNITS`, `refresh.ts:44`) | ≤ 600 |
| Embed checks on paste/queue (`lib/embed-cache.ts`, cached) | ~≤ 100 (UNVERIFIED, from production spend) |
| New: catalogue harvest/backfill (artist + extra karaoke channels) | ≤ 3,000 |
| New: by-ID refresh of non-channel links (137, Wikidata IDs) | ≤ 500 |
| **Headroom kept unspent** | **≥ 5,800** |

At 3,000 units/day of backfill, ~70k new links/day are possible. Units are not the binding constraint. **Wall-clock is:** 0.54 s/call and a 60 s Hobby function give ~18 channels/run (`refresh.ts:17-39`). 71 karaoke channels + ~500 BR artist channels at 18/run is a ~32-day cycle, **over the 30-day limit**. The fix: Vercel Hobby allows up to **100 cron jobs per project, each daily** (https://vercel.com/docs/cron-jobs/usage-and-pricing, per search summary; **UNVERIFIED** on the primary page). So add N slot crons over disjoint channel slices, plus a shared Redis daily unit counter across slots. Also **UNVERIFIED:** Vercel Hobby's fair-use terms are for non-commercial use, which matters once venues pay. That's a TL business item, not part of this epic.

## (d) Storage and size

- **Today:** 38,275 rows = 1.09 MB gzip (~28.6 B/row), ~1.46 MB base64, 71 keys (`store.ts:6-9`). The 106 spike measured 83 B/row raw for `{videoId,title}` (`TICKET-106-spike.md:204`). Matcher: 1.80 ms/query warm (RESULTS.txt).
- **Projected epic:** ~150k links (karaoke + originals + patron picks) at ~+15 B/row gz for `kind`/`songId`, so ~6.5 MB gz / ~9 MB base64. Plus ~50k songs (our data: title, artist, aliases, lang, popularity, source) at ~60 B raw, ~1-1.5 MB gz.
- **Where:**
  - **Links (YouTube data):** stay in Upstash, sharded per source channel plus `ki:obs:<day>` shards for patron picks. Each shard has a TTL ≤ 30 d. Free tier: 250 MB data, 10 MB max request, 500K commands/month (https://upstash.com/docs/redis/overall/pricing). **Split the single MGET** (`store.ts:119`) into batches, because ~9 MB would sit near the 10 MB request limit.
  - **Songs (our CC0-derived data):** can ship as a static JSON in the build (no YouTube data in it, so no retention clock) or a Redis key without TTL. Build-bundling is simplest: refresh by a script PR. Vercel Blob is not needed.
- **Search method:** keep the current posting-list matcher. Index `title` plus parsed `song` + `artist` + aliases. Return link rows grouped per song (karaoke first in sing mode, original first in listen/dance). **UNVERIFIED:** heap and build time at ~150k rows. The 106 naive scan was 91 ms at 36k, and the posting lists are 1.8 ms; measure in ticket 143.
- **Cost:** $0 incremental on today's free tiers (Upstash, Vercel Hobby cron), at the projected sizes.

## (e) Tickets (start at 141; 131-140 are taken)

Order: 141 → 142 → 143 → 144 → 137 → 145 → 146 → 147 → 148 → 149. 141 and 142 can run in parallel.

| # | Title | Size | Scope + acceptance |
|---|---|---|---|
| **141** | ToS/legal decision memo for the catalogue | XS (TM + TL) | One page. Six items: (1) are API-sourced videoIds API Data (30 d)?, (2) are parsed song/artist fields "derived data"?, (3) KaraFun CSV use, (4) oEmbed status, (5) `ki:stamps` no-TTL, (6) Vercel Hobby commercial use. Default is the conservative reading above. TL decides; nothing here blocks 142 |
| **142** | Measurement harness v2 | S | Extend `work/measurements/ticket-124/replay.ts`: (a) grade **listen/dance** queries (today 14 of 26 billed are `not-sing-mode` and ungraded); (b) split each miss into coverage vs ranking (port `work/spikes/ticket-106/diagnose.mjs`); (c) report hit@1/5/10 + billed/song per tier and per kind. Baseline must reproduce 89% / 0.89. Prove-can-fail controls kept (C1-C4). **Gate for all later tickets:** hit@10 may not drop below 89%, and the long-tail false-confident count may not exceed 3/18 |
| **143** | Title parser: song / artist / kind | S-M | Pure function over (title, channelTitle). Extracts song + artist + `kind ∈ {karaoke, playback, original, lyric, live, cover, unknown}`. Per-channel templates allowed. Acceptance: hand-labelled sample of 300 index rows; kind precision ≥ 95%, song+artist exact ≥ 85%; mutation-proof tests. No storage change |
| **144** | Catalogue schema v2: songs (ours) + links (YouTube, ≤30 d) | M | `ChannelShard` v2 rows gain `songId`/`kind`. Songs table as build-bundled JSON. Matcher indexes song/artist/aliases and groups links per song. `decideTier` serves `kind=original` links in non-sing modes. Batched MGET. Retention guard test (no link served past `INDEX_MAX_AGE_MS`; parsed-only songs expire with their links per 141). 142 harness: no regression, plus heap/build-time numbers |
| **137** (existing, promoted) | Cache every patron-queued live result into the catalogue | M | Rewired onto 144: on `song_queued` from a live result, write the link (kind via 143) into `ki:obs:<day>` with TTL 30 d from fetch. Daily row cap; listen-mode picks stored as `original`. Uses the **135 folded key** normaliser (`normalizeQuery`, `lib/search-prefix.ts:92`) so cache, single-flight and catalogue share one fold. Acceptance as in the SCOPE doc (§137): replay "yesterday folded", false-confident ≤ 3/18 |
| **145** | Seed song spine from MusicBrainz + Wikidata (+ ListenBrainz popularity) | M | Offline script (no YouTube calls). BR-skewed list: artists with country BR + intl top-N by ListenBrainz popularity. Writes the songs JSON + artist→YouTube channel-ID map (`P2397` / MB URL rels). CC0 attribution note in README. Excludes all supplementary (NC) data. Coverage report: % of the 28 graded replay songs present in the spine |
| **146** | Refresh scale-out + 30-day-safe by-ID refresh | S-M | N daily cron slots over disjoint shard slices (Vercel Hobby, daily each). Shared Redis daily unit counter (cap per the budget table). `videos.list` by-ID refresh for `ki:obs` links queued again within 30 d (renews them); others expire. Test: simulated 600-channel set cycles in < 21 d at 0.8 s/call |
| **147** | Originals: harvest official artist channels | M | Use the 145 channel map, ranked by popularity and patron picks. Run a "Topic" channel spike first (embeddable? `UU` playlist works?). Acceptance on the 142 harness: listen/dance billed/song drops, measured; hit@10 for listen/dance reported vs live alone |
| **148** | Karaoke channel discovery without search | S | From 137 picks, resolve unseen channel IDs with `videos.list` (1 unit / 50). Promote karaoke/playback-named channels into `channels.json` via PR. Gap audit for the 106 long-tail misses (reggaeton/funk). Lift `REFRESH_MAX_PAGES` (14) for channels truncated at 700 if 146 allows |
| **149** | Ranking: popularity + kind preference + alias/typo help | S | Order grouped results by mode-preferred kind, then our queue popularity (own data), then specificity. Artist-name aliases for typo classes ("soda stete"). Acceptance: hit@1 up on the harness, no false-confident increase |

**Interactions:**
- **135** (key fold): the catalogue matcher already folds the same way. Make 135's `cacheKey` reuse `normalizeQuery` so cache, single-flight and catalogue agree.
- **136** (cache TTL to 7 d): its `TTL ≤ INDEX_MAX_AGE_MS` guard stays the single source for the 30-day ceiling. Catalogue links use the same constant.
- **Cache shadowing:** a cached live page still shadows the catalogue for that exact key (`route.ts:177-198`). Once 144 lands, consider asking the catalogue before the cache on sing/listen first pages. **Open, decide in 144.**
- **138** (TL: automatic YouTube fallback, no separate button): this is the "search YouTube automatically if not on the list" half of the TL idea. 137 then caches whatever the patron picks from it.
- **134** (repeat-rate telemetry): adding a hashed videoId to `song_queued` also gives 149 its popularity signal. Keep hashes only.

## UNVERIFIED register (all must go to 141 or be measured, not assumed)

1. "Video IDs may be stored indefinitely": not in the current Developer Policies text.
2. Whether parsed song/artist from YouTube titles is "derived data" (III.E.4.h).
3. Whether re-validating a non-API-sourced videoId with `videos.list` turns it into API Data.
4. oEmbed: whether it is covered by YouTube API Services, plus its rate limits.
5. KaraFun CSV redistribution/commercial terms, and database/compilation rights (BR Lei 9.610/98 art. 7 XIII; EU sui-generis right).
6. MusicBrainz URL-relationship tables in the CC0 core dump; ListenBrainz CC0 wording (primary page); Discogs dump licence (primary page returned 403).
7. Vercel Hobby: 100 daily crons/project (secondary summary of the primary doc), and Hobby non-commercial fair use.
8. Topic channels: uploads playlist + embeddability.
9. Language/genre skew of the 71 channels (fixture absent here). Matcher heap at ~150k rows.
10. The brief's "~38,825 rows" vs the repo's measured 38,275.

## Independent verification (2026-10-15)

Clean-context verifier. Code read from `main` only; web pages fetched 2026-10-15; no YouTube Data API calls. The plan body above is unchanged; corrections live only in this table.

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Since 2026-06-01 `search.list` has its own bucket, 100 calls/day, 1 unit/call | CONFIRMED | https://developers.google.com/youtube/v3/revision_history (June 1, 2026 entry): "API calls to the videos.insert and search.list methods will be charged to their own respective quota buckets." https://developers.google.com/youtube/v3/determine_quota_cost ("Last updated 2026-10-08 UTC"): "Each of these methods has a default daily limit of 100 per day." / "The quota cost is 1 per call." (The 100 figure is on the quota page, not in the changelog entry.) |
| 2 | Boraoke budgets 90/day, `lib/search-budget.ts:98,114` | CONFIRMED | `:98` `export const SEARCH_DAILY_CAP = 100;` `:114` `export const SEARCH_DAILY_BUDGET = SEARCH_DAILY_CAP - RESERVE_MARGIN;` (RESERVE_MARGIN = 10) |
| 3 | 10k pool covers everything else; `playlistItems.list` and `videos.list` cost 1 unit | CONFIRMED | determine_quota_cost: "10,000 units per day combined for all other endpoints"; playlistItems.list, videos.list, channels.list = 1 each |
| 4 | Developer Policies last updated 2026-09-14 | CONFIRMED | https://developers.google.com/youtube/terms/developer-policies "Last updated 2026-09-14 UTC" |
| 5 | III.E.4.d: "limited amounts" of Non-Authorized Data, temporarily, ≤30 days, then refresh/delete | CONFIRMED | III.E.4.d: "API Clients may temporarily store limited amounts of Non-Authorized Data for as long as is necessary…", not beyond 30 calendar days, then delete or refresh |
| 6 | III.E.4.e consistency; III.E.4.h no "replace API Data with similar, independently calculated data" / no "new or derived data or metrics"; III.E.1.a no storing audiovisual content | CONFIRMED | III.E.4.e: "must use reasonable efforts to ensure that their stored API Data is consistent with the current data"; III.E.4.h: "must not (i) replace API Data with similar, independently calculated data" … "access or use API Data to create new or derived data or metrics"; III.E.1.a: "download, import, backup, cache, or store copies of YouTube audiovisual content without YouTube's prior written approval" |
| 7 | "Video IDs may be stored indefinitely" is not in the current text | CONFIRMED | Neither "identifier" nor "video ID" appears in the page. "indefinitely" appears only in Principle II.4 ("store user data indefinitely", as a prohibition). No ID exemption exists |
| 8 | No explicit catalogue/index rule in the policies (implied by the plan) | CONFIRMED, with two clauses the plan does not cite | No clause on building a catalogue/index/database. But **III.E.2** (aggregation): "Do not aggregate API Data except that you may only aggregate API Data relating to YouTube channels…" owned by the same content owner, and **III.C.5**: "must not modify or replace the text, images, information, or other content of, the search results". Neither is in the plan; both belong in the 141 memo. Whether III.E.2 applies to a cross-channel index is UNVERIFIABLE (legal reading) |
| 9 | API ToS 2026-09-14, §15 no circumventing quota | CONFIRMED | https://developers.google.com/youtube/terms/api-services-terms-of-service "Last updated 2026-09-14 UTC"; §15: "You and your API Client(s) will not, and will not attempt to, exceed or circumvent use or quota restrictions." The multiple-GCP-projects point is only from secondary sources |
| 10 | oEmbed: 0 Data API units; ToS coverage and rate limits unknown | UNVERIFIABLE (as the plan says) | Neither the Developer Policies nor the API ToS mention oEmbed. The ToS defines YouTube API Services as "e.g., YouTube Data API service and YouTube Reporting API service" (non-exhaustive). No primary page found on oEmbed quota/rate limits |
| 11 | MusicBrainz core CC0, supplementary CC BY-NC-SA | CONFIRMED | https://musicbrainz.org/doc/About/Data_License: "The core data of the database is licensed under the CC0" |
| 12 | MusicBrainz URL relationships in CC0 core: UNVERIFIED in plan | **WRONG (resolvable): they ARE core/CC0** | https://musicbrainz.org/doc/MusicBrainz_Database lists "Relationships & URLs" under core data. Supplementary includes "derived statistics" and "search indexes" (not used) |
| 13 | MusicBrainz API 1 req/s/IP + contactable User-Agent | CONFIRMED | https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting: "(on average) 1 request per second"; "Each request sent to MusicBrainz needs to include a User-Agent header" |
| 14 | Wikidata CC0 | CONFIRMED | https://www.wikidata.org/wiki/Property:P1651 (label "YouTube video ID"): structured data "is available under the Creative Commons CC0 License" |
| 15 | Wikidata SPARQL counts (~40,556 / ~307 / 30 / 476) | UNVERIFIABLE (not re-run) | Not re-run by the verifier |
| 16 | ListenBrainz data CC0 | UNVERIFIABLE (as the plan says) | No primary statement found: the ListenBrainz dumps page and https://metabrainz.org/datasets carry no licence text. Only secondary sources (alternativeto, ecosyste.ms) say CC0. The dumps page also contradicts itself on frequency ("incremental … twice a week" vs "daily") |
| 17 | Spotify Developer Terms v10 (2025-05-15): no storing/compiling databases, no indexing playlist data, "private personal use" | CONFIRMED | https://developer.spotify.com/terms §IV.3.1 "may not store, aggregate or create compilations or databases of Spotify Content"; §IV.2.4.1 "index any portion of the Spotify Service or Spotify Content (which includes playlist data)"; §III.1.a "for private personal use" |
| 18 | Deezer non-commercial, private use | CONFIRMED | https://developers.deezer.com/termsofuse §IV: "the use of the Services is strictly limited for a non-commercial purpose"; "limited to a strictly private use within a family scope" |
| 19 | Last.fm non-commercial, 100 MB cap, attribution | CONFIRMED | https://www.last.fm/api/tos 3.1 "solely for non-commercial purposes"; 4.3.4 "maximum of 100 MB"; 4.2.2 crediting Last.fm |
| 20 | KaraFun: full catalogue + "1,000 most popular" as PDF/CSV; ToS "not found" | **PARTLY WRONG** | https://karafun.com/blog/777-tip-of-the-month-printing-and-editing-the-song-catalog.html: CSV is offered for the **full catalogue** only; "Most popular (1,000 top songs)" is confirmed as PDF only. A terms statement **does** exist: the site footer says "Without permission, all uses other than home and private use are forbidden." So the default is "forbidden without permission", not "unknown". The verdict "ask before use" stands |
| 21 | 71 channels in `channels.json` | CONFIRMED | `lib/karaoke-index/channels.json` is a JSON array of 71 entries (73 lines) |
| 22 | Row shape `[videoId, title, duration]`, `types.ts:16-26` | CONFIRMED | `types.ts:16` `export type IndexRow = [videoId: string, title: string, duration: string];` `:18-26` ChannelShard {v, channelId, channelTitle, harvestedAt, rows} |
| 23 | 38,275 rows, 1,599 units, 868 s, 0 search.list | CONFIRMED | `HARVEST-LOG.txt` end: "channels: 71   rows: 38275" / "UNITS CONSUMED: 1599 (10k pool)   search.list calls: 0" / "gzipped size: 1093956 bytes   elapsed: 868s". 21 log lines read "700 rows" |
| 24 | 700-newest cap (14 pages × 50) | CONFIRMED | `refresh.ts:46` `export const REFRESH_MAX_PAGES = 14;` ("Pages (50 videos each) … newest uploads first") |
| 25 | ~1.46 MB in Upstash, ~20 KB/key | CONFIRMED | `store.ts:6-7` "38,275 rows / 71 channels = 1.09 MB gzipped, ~1.46 MB as base64 — ~20 KB per key" |
| 26 | Daily cron 09:00 UTC, fail-closed CRON_SECRET (503), constant-time compare, `maxDuration` 60, cutoffs 34 s / 50 s, ≤600 units, 6-way | CONFIRMED | `vercel.json` `"schedule": "0 9 * * *"`; `route.ts` `:24 maxDuration = 60`, `:35 … { status: 503 }` when no secret, `timingSafeEqual`; `refresh.ts:40-46` (CONCURRENCY 6, 34_000, 50_000, 600) |
| 27 | 30-day hard stop (`types.ts:38`) + Redis TTL (`store.ts:102-107`); `ki:stamps` no TTL | CONFIRMED | `types.ts:38` `INDEX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000`; `store.ts:104-105` `ttl = … INDEX_MAX_AGE_MS - (Date.now() - shard.harvestedAt)` / `redis.set(…, { px: ttl })`; `store.ts:47-54` stamps "has NO TTL, deliberately" |
| 28 | "14 of 26 billed calls were listen/dance (not-sing-mode)" | CONFIRMED, with a nuance | `work/measurements/ticket-124/RESULTS.txt:83` `why AFTER still billed: {"not-sing-mode":14,"weak-match":12}`; `:79` "48 → 26 calls". `tier.ts:117` sets `not-sing-mode` when the query lacks "karaoke" (sing mode appends it), so it is a proxy for listen/dance, not a mode flag |
| 29 | Upstash free: 10 MB max request, 250 MB data, 500K commands/month | CONFIRMED (minor inconsistency on the source) | https://upstash.com/docs/redis/overall/pricing: max request "10MB", "500K commands per month", FAQ "250MB data size" (the comparison table says 256MB) |
| 30 | Vercel Hobby: 100 cron jobs/project, once per day (plan: UNVERIFIED) | **CONFIRMED (now verified on the primary page)** | https://vercel.com/docs/cron-jobs/usage-and-pricing (last_updated 2026-07-15): Hobby "100 cron jobs", minimum interval "Once per day", precision "Per-hour (±59 min)" |
| 31 | "60 s Hobby function" limit (plan §c wall-clock math; also `refresh.ts:25` comment) | **WRONG as a platform limit** | https://vercel.com/docs/functions/configuring-functions/duration (last_updated 2026-08-24): with fluid compute (enabled by default) Hobby is "300s (5 minutes)" default and maximum. 60 s is boraoke's own `maxDuration` export (`route.ts:24`). The ~18 channels/run and "~32-day cycle over the 30-day limit" follow from that self-imposed 60 s; at up to 300 s per run the cycle could be roughly 5× shorter, which weakens the case for 146's N-slot crons. Whether the boraoke Vercel project has fluid compute on is UNVERIFIABLE from the repo (no setting in `vercel.json`) |
| 32 | Vercel Hobby non-commercial (plan: UNVERIFIED) | **CONFIRMED (now verified)** | https://vercel.com/docs/limits/fair-use-guidelines (last_updated 2026-09-14): "Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan." Examples include "Any method of requesting or processing payment from visitors of the site" |

**UNVERIFIED register updates:** items 6 (MusicBrainz URL rels: resolved, CC0 core) and 7 (Vercel 100 daily crons + Hobby non-commercial: both confirmed) can close. Items 4 (oEmbed) and the ListenBrainz half of 6 remain open. New for 141: III.E.2 aggregation and III.C.5 search-results clauses; the Vercel 60 s vs 300 s premise.
