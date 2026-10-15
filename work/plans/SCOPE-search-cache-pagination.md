# SCOPE — boraoke search cache + search pagination

Read-only scoping for the boraoke Product TM. TL ask (verbatim): "For boraoke, lets also implement search cache and search pagination".

Code read: `origin/ticket/126-search-limits` (main + TICKET-125 + TICKET-126), exported via `git archive`. All `file:line` refs are to that tree. No YouTube calls, no fixtures run (the TICKET-108 oracle `work/measurements/ticket-108/production-search-results.json` is gitignored and absent from the main checkout, so no harness was re-run).

## Headline

Both things the TL asked for **already exist** in a first version. A cross-instance search cache (memory + Upstash Redis, 12h) and real paging (index rows, then an escape to live, then one more YouTube page, every page cached) shipped in TICKET-55 and TICKET-83 and were extended by 124 to 126. The gaps are about how far the cache reaches and a few paging dead ends. They are not missing features.

On today's traffic, the cache gaps barely move billed calls per song (estimate **0.89 to about 0.87–0.89**). Production use has been sparse: 7 active days in 3 months, and the two busy days were 29 days apart. Same-day song repeats were also close to zero (24 songs queued against roughly 24–28 distinct songs). The cache only pays back once usage gets dense: several nights or venues a week. See section 4.

## 1. Search cache today

| Property | Today | Evidence |
|---|---|---|
| Tiers | L1 per-instance in-memory LRU, plus L2 Upstash Redis (cross-instance) when `UPSTASH_REDIS_REST_URL`/`STORE_DRIVER=upstash` is set. Without Upstash it is memory-only. | `lib/search-cache.ts:77-103`, `:153-172` |
| L1 caps | 100 entries, 60 s TTL | `lib/youtube-search.ts:311-312` |
| L2 TTL | non-empty 12 h, empty 10 min. Errors are never cached. | `lib/search-cache.ts:64,67,193-195`; route only writes after success `app/api/search/route.ts:342-345` |
| L2 size cap | none. TTL-bounded only, namespace `sc:` | `lib/search-cache.ts:73,195` |
| Invalidation | none. No explicit purge. A legacy bare-array payload is still accepted (shape-tolerant read). | `lib/search-cache.ts:132-142` |
| Key | `<region>::[P:<pageToken>::]<q.trim().toLowerCase(), whitespace collapsed>` | `lib/youtube-search.ts:336-348` |
| Case / whitespace | folded | `lib/youtube-search.ts:337` |
| Accents / punctuation / Unicode NFC-vs-NFD | **not folded**: `maná` ≠ `mana`, `cerol na mão` ≠ `cerol na mao` (both pairs are real production keys, `work/measurements/ticket-108/queries.ts:47-49,40/52`). By contrast the index/prefix normaliser *does* fold (`lib/search-prefix.ts:92-97`). | |
| Region / locale | region fixed `BR` and part of the key. No language/locale component. | `lib/youtube-search.ts:86`, `route.ts:184` |
| Mode | carried in the key through the query text. Sing mode appends `karaoke` client-side. `karaoke evidencias` and `evidencias karaoke` are different keys. `karaokê` (accented) is not recognised, so it gets a second `karaoke` appended. | `lib/search-query.ts:29-44`, `lib/youtube-search.ts:321-330` |
| Pages | each Google page cached under its own `P:<token>::` key with the same TTLs. Page 2 is shared across patrons because everyone receives the same cached `nextPageToken`. | `lib/youtube-search.ts:331-347`, `lib/search-cache.ts:180-196` |
| Tier order | cache, then karaoke index, then (if `live` allowed) live. A cache hit is served even on a free index-only (as-you-type) request. | `route.ts:177-222` |
| Index ↔ cache | index answers are **not** written to the cache (retention reasons). A live page *is* cached, and from then on it shadows the index for that exact key for 12 h. The IDXLIVE escape caches under the **page-1** key (`livePageToken=""`). | `route.ts:174-216` |
| Single-flight (126) | Leader writes the cache (`route.ts:345`) then releases. Waiters poll the **same cache key** (`lib/search-single-flight.ts:216-235`). Lock key = `sf:lock:<cacheKey>` (`:14,160`). So any key-normalisation change also changes single-flight dedupe, automatically. | |
| Index load cache | in-process. Reloads hourly (`lib/karaoke-index/store.ts:44`). A failed load retries in 60 s (`:151`), but an **empty** load waits the full hour (TICKET-130, open). | `store.ts:198-216` |
| Telemetry | `search_performed` carries `source: cache/index/live` | `route.ts:187,208,286,347` |

## 2. Pagination today

- **Live page:** one `search.list` returns 50 rows (`lib/youtube-search.ts:85`). The client reveals 8 per "load more" tap (`components/SongSearch.tsx:46`, `:393-396`), so the first ~6 taps are free.
- **Deep page:** once those rows run out, a tap sends `pageToken=<google token>&page=2` (`SongSearch.tsx:399-414`). The server enforces `MAX_SEARCH_PAGES = 2` and requires `page` and `pageToken` to agree (`lib/youtube-search.ts:112`, `route.ts:109-125`). Page 3+ is refused, and the client shows "refine" (`SongSearch.tsx:643-646`). Nothing is prefetched.
- **Index answer:** 16 rows (`lib/karaoke-index/tier.ts:71`) with `nextPageToken: "IDXLIVE"` (`route.ts:209-214`). That is 2 reveal taps, and the 3rd tap sends `IDXLIVE` as page 2. The server answers with the **live first page** of the same query (`route.ts:174-175`), cache-first and then billed. The client merges and dedupes the new rows into the held pool (`SongSearch.tsx:432-441`).
- **The index does not page.** It returns at most 16 rows and has no offset or cursor (`tier.ts:119`, `matcher.ts:180`). After 16 rows the only "more" is a billed live call.
- **Dead end after escape:** the IDXLIVE escape uses up `page=2`, so `pagesFetched` hits `MAX_SEARCH_PAGES`. The live page's real `nextPageToken` (Google page 2) can **never** be reached after an index answer (`SongSearch.tsx:399,443,643`).
- **Cached page 2+:** yes, see section 1.
- **Failure UX:** a non-`daily-limit` degraded load-more fails silently (TICKET-128, open).

## 3. Gaps, as candidate tickets (next free: 134)

Already filed and relevant, not re-ticketed: **TICKET-128** (silent load-more failure), **TICKET-130** (empty index cached 1 h; should land before 137), **TICKET-133** (legacy fallback).

### TICKET-134 — Measure cache reach before tuning it (S)
- **Problem:** we can't say how many billed calls repeat a query or song already answered across patrons or days. The replay oracle is one day of keys that the cache has already deduped by construction, and query text is deliberately not in telemetry.
- **Change:** add a salted/HMAC hash of the *folded* key (see 135) and, on queue, the `videoId`'s hash, to `search_performed{source:live}` / `song_queued`. Add a read-only report script: daily cache/index/live split, cross-day repeat rate of billed key-hashes at windows of 12 h / 7 d / 30 d, and the song repeat rate.
- **Acceptance:** the script prints those numbers from production telemetry. No raw query text is stored. A test proves the hash is stable across accent/case variants.
- **Patron-facing:** no. **Risk:** none on budget. Privacy: hashes only. Keep it under the same retention as telemetry.

### TICKET-135 — Fold the cache key harder (S)
- **Problem:** the key folds only case and whitespace, so accent, punctuation, NFC/NFD and "karaoke"-position variants of one question each spend a call.
- **Change:** in `cacheKey()`, fold the query part with the same normaliser as `normalizeQuery` (NFD-strip diacritics, punctuation to space, collapse), and canonicalise a `karaoke`/`karaokê` token to the end. Google still receives the patron's original `q`. Only the key changes. Keep the uppercase `P:` marker *outside* the folded part (the collision argument at `youtube-search.ts:338-346` must still hold; folding `:` to space only strengthens it). Single-flight inherits the change through `ck`.
- **Acceptance:** `maná`/`mana`, `Cerol na Mão`/`cerol na mao`, `karaoke evidencias`/`evidencias karaoke`/`evidências karaokê` each map to one key. A mutation-proof test that fails on today's `cacheKey`. The graded accent queries (`queries.ts:46-51`) keep their hit@10 in the 125 harness. Old keys simply age out within 12 h.
- **Patron-facing:** no (fewer "search unavailable" moments at scale). **Risk:** quality. The first variant's Google answer is served for the folded variant (`mana` vs `maná` can be different songs on YouTube). Mitigated by the harness check. Abuse: none new.

### TICKET-136 — Longer cache TTL for non-empty pages (XS–S)
- **Problem:** 12 h only covers one evening. Busy days so far have been weeks apart.
- **Change:** raise `SEARCH_CACHE_TTL_MS` to a value picked from TICKET-134's repeat curve (default proposal: 7 d). Hard ceiling: the 30-day API-data retention the index already enforces (`lib/karaoke-index/types.ts:38`). Empty stays at 10 min. Check how a video deleted after caching behaves when picked from a stale page. The embeddability check (`lib/embed-cache.ts`) is on the paste path, so this is UNVERIFIED for search picks, and the Dev should confirm the player's error path. Note it in the route header.
- **Acceptance:** the TTL constant is changed and covered by a test, and a guard test asserts TTL ≤ `INDEX_MAX_AGE_MS`. Upstash footprint is stated (about 9 KB/page × ≤90 pages/day × 7 d ≈ 5–6 MB, inside the free tier).
- **Patron-facing:** no. **Risk:** staleness (new uploads missed for up to 7 d on a cached query, which is low for karaoke). A cached page-2 cursor may age past Google's validity. On error the route already fails soft, and a one-line test should cover it. Budget/abuse: none. Can ship in the same PR as 135.

### TICKET-137 — Fold live karaoke results into the index (M–L; after 130 and 134)
- **What "folding" means here:** the index is one shard per harvested channel (`playlistItems`, `ki:shard:<channelId>`, TTL = 30 d from `harvestedAt`, `store.ts:102-106`). Folding = after each successful **sing-mode** live page, append its rows whose title contains karaoke (dedupe by `videoId` against the index) to an "observed" shard. Each row is stamped with its fetch time and dropped at 30 d. Instances pick it up through the stamps hash on the next reload. The effect beyond the exact-key cache is that a later *different* phrasing, prefix, or typo of the same song gets a confident free index answer.
- **Cheaper option A (could be phase 1):** a server-side "extension answer". If a cached sing-mode page's key is a prefix of the new query, narrow those rows the way `planSearch` does for the patron's own held page (`lib/search-prefix.ts`). Cross-patron, no new storage.
- **Acceptance:** under the 124/125 replay with a "yesterday's live pages folded" scenario, billed/song and hit@10 are reported, and the long-tail false-confident count does not rise over 3/18 at threshold 0.8. A row cap (e.g. 20k observed rows), retention test, and listen-mode pages are never folded.
- **Patron-facing:** no directly (more free answers). **Risk:** quality (more rows mean more chances of a confident wrong answer. Thresholds already tuned at `tier.ts:42`). Abuse: an attacker chooses queries and so chooses which Google rows (safeSearch moderate) enter a shared index. Same exposure class as the shared cache, but longer-lived. Cap per day and require a karaoke title. Policy: storing `search.list` data ≤30 d is the same retention rule the index follows. Hot-path write is one Redis append. Memory: in-process scan cost grows linearly (91 ms at 36k rows per the 106 spike).

### TICKET-138 — Real index paging, separated from the billed escape (S–M; has a TL UX fork)
- **Problem:** the index stops at 16 rows, and "load more" silently turns into a billed live search. The patron can't tell a free "more" from a paid one, and can't see further free index rows.
- **Change:** page the index with a cursor (e.g. `IDX:<offset>`, answered from the free tier, never billed) up to a cap (e.g. 48 rows). Expose the live escape as its own explicit control ("Not here? Search YouTube") rather than the Nth "load more". Server: `decideTier` gets an offset, and the index-cursor page is free and allowed on `live=0`.
- **TL fork:** whether "load more" should ever bill implicitly. The 124 sweep shows the wanted song sits in the top rows when the index has it, so deeper index pages mostly add *alternatives* (versions/keys), and an explicit escape is the honest UI.
- **Acceptance:** index cursor pages cost 0 billed calls (test). The escape control appears after the first index page. Copy in pt-BR/en/es. The 125 replay shows no billed increase.
- **Patron-facing:** yes. **Risk:** budget-neutral or better. Abuse: index paging goes in the free-tier rate bucket (`indexRateLimitOk`).

### TICKET-139 — Google page 2 unreachable after an index escape (XS–S)
- **Problem:** IDXLIVE takes `page=2`, so the live page's `nextPageToken` is dead (`SongSearch.tsx:399,443,643`, `route.ts:109-125`).
- **Change:** count *live* depth, not taps. The escape is live page 1, so its cursor is allowed as live page 2. The server keeps `MAX_SEARCH_PAGES=2` billed live pages per query. Fold into 138 if it ships first.
- **Acceptance:** index answer, escape, then a deep page all work, and live page 3 is still refused. A test fails on today's code.
- **Patron-facing:** yes. **Risk:** at most one extra billed call per escaped query, which matches the non-index path's cap.

Not a gap (do not ticket): caching page 2+ (done, TICKET-83), cross-instance cache (done, TICKET-55), single-flight writing the cache (done, 126), prefetch (deliberately never).

## 4. Billed calls per queued song vs 0.89

**How 0.89 is built:** `perSong = 3.75 × billed / 80` (`work/measurements/ticket-125/replay.ts:304`). It is 18.91 mean billed calls over the 80 production keys / 32 families. 18 of those are Enter/idle settle points (the floor, 0.84) and about 0.91 are mid-title idle pauses (`ticket-125/RESULTS.txt`). The oracle is the production cache dump, so **every key in it is already unique within the 12 h TTL**. The replay models one day and no cross-day traffic. It cannot show cross-day cache gains by construction.

**What can be computed from the evidence:**
- **Within the replayed day, normalisation (135):** the only fold-merges visible among the published production strings are `maná`/`mana` and `cerol na mão`/`cerol na mao` (`queries.ts`). The replay already puts each pair in one trace (it groups by `normalizeQuery`, `replay.ts:120-140`). The second element bills again only if the first, a mid-title pause, also billed: p ≈ S(4 s) = 0.10. And `cerol…karaoke` is likely index-answered anyway. Saving ≤ 2 × 0.10 = 0.2 of 18.91 calls, so **≤1%: 0.89 to ≥0.88**. Confirming the exact number needs the oracle (gitignored, local only, absent here).
- **Within the day, TTL (136):** 0 by construction. Production also showed 89 keys created against 90 reservations (`work/reports/TICKET-106-spike.md:115`), so the 12 h cache already lost at most 1 same-day repeat.
- **Cross-day, on real usage so far:** 7 active days in ~3 months, busy days 2026-08-28 and 2026-09-26, **29 days apart** (`TICKET-106-spike.md:93-101`). A 7-day TTL would have caught **zero** of those, and even a 30-day TTL/fold barely spans them. Same-day song repeats were also ≈0 (24 queued ≈ 24–28 distinct songs, `TICKET-106-spike.md:76`).

**Bounded estimate:**

| Usage regime | 135+136 (key reach) | +137 (song-level fold) |
|---|---|---|
| Today's (sparse, weeks between busy nights) | 0.89 → **0.87–0.89** | → **0.85–0.89** |
| Dense (several nights/venues a week), assumed cross-day key repeat r_key 5–15%, song repeat r_song 20–40% on sing-mode settles | 0.89 × (1−r_key) → **0.76–0.85** | 0.89 × (1−r_song) → **~0.53–0.71** |

The dense-row rates are **assumptions**, not measurements. TICKET-134 pins them. After a week of dense use, its report gives the cross-day repeat rate of billed key-hashes at 12 h/7 d/30 d, and the song-hash repeat rate. Those plug straight into 0.89 × (1−r). Note that budget is not binding today: at 0.89/song, the ~25 songs/day peak costs ≈ 22 of 90 patron calls. The case for the cache is scale headroom, not current pain.

**138/139** are paging fixes and don't lower billed calls per song. 138 is budget-neutral or slightly lower, because free index pages defer some escapes. 139 adds at most 1 billed call per escaped query, only on a deliberate tap.

## Suggested order

134 (measure) → 135+136 (one PR) → 139 (or folded into 138) → 138 (after TL answers the UX fork) → 130 → 137 (only if 134 shows dense repeats).
