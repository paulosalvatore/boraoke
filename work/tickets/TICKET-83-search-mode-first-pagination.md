# TICKET-83 — Choose sing/vibe BEFORE searching, and paginate results without burning quota

**Status:** delivered (PR open, not merged)
**Branch:** `ticket/83-search-mode-first-pagination`
**Source:** Tech-Lead feedback after live use.

## Problem

Two things the Tech Lead hit while using boraoke at a real venue.

1. **The mode choice came after the search.** The patron typed a query, got results, and only then picked *to sing* / *to vibe*. Flipping that toggle re-ran the whole search (sing appends `karaoke` to the query, so the query text genuinely changes) — a second YouTube search for the same intent. The fix is the TL's own: move the choice **before** the query, so a change of mind costs nothing.
2. **Only the first page of results was reachable.** *"People might not find what they want on the first search."* Eight rows and a dead end.

## The quota constraint (the thing that shapes the whole design)

**The model changed on 2026-06-01**, verified by the TICKET-85 spike against Google's own docs. The repo — and the original brief for this ticket — described the pre-June model. Corrected here and in every code comment this ticket touches:

| Endpoint | Cost | Bucket |
|---|---|---|
| `search.list` | **1 of 100 CALLS per day** | its **own** hard-capped bucket |
| `videos.list`, `playlistItems.list`, `playlists.list`, `channels.list` | 1 unit each | a **separate** 10,000/day pool boraoke barely touches |

So search and metadata are **decoupled**, and a search is not "101 of 10,000 units" — it is **1% of everything the platform gets that day, across every venue combined**. Caching cannot raise that ceiling; it can only stop us re-spending it. Pagination therefore has to be treated as a scarce budget, not a UX nicety.

## Design

### 1. Mode before query, and a mode change never fires a search

- The sing/vibe chooser moved from the bottom of the form (a `<select>` next to "table") into `SongSearch`, **above** the query input, as two thumb-sized radio chips.
- **`sing` is pre-selected**, so the input is never gated behind a required choice — a patron can open the form and type immediately.
- The live mode is read through a **ref** inside `SongSearch`, so `runSearch` keeps a stable identity across mode changes. The debounce effect depends on `runSearch`, so a mode flip re-renders the chooser and **nothing else** — it cannot re-trigger a debounce or a fetch. This is the mechanism, and it is asserted by counting outbound calls in e2e.
- Results are labelled with the mode they were fetched under (`Resultados para: 🎤 Cantar`). If the patron changes mode *after* results are on screen we do **not** silently re-run; we say so and offer an explicit **"Buscar de novo"** button. Re-searching is then a deliberate act, not an accident.

### 2. Cache key already reflects the mode — deliberately NOT double-keyed

The TM asked for the mode to be folded into the cache key. It already is, via the query: `augmentQuery()` appends `karaoke` in sing mode **client-side, before** `/api/search` (TICKET-40's documented design decision), so `sing "evidencias"` → `BR::evidencias karaoke` and `vibe "evidencias"` → `BR::evidencias`. Distinct entries, no cross-mode poisoning.

Adding a separate `mode` component to the key on top of that would be **actively worse**: when a raw query already contains "karaoke", both modes produce the identical search, and today they correctly **share** one cache entry. Splitting them would spend a second daily search on a question already answered. Flagging this as a reasoned deviation on that one sub-point.

### 3. Pagination: one big page, revealed client-side

`search.list` bills **per call**, completely independent of `maxResults` (1..50). So:

- `SEARCH_DEFAULTS.maxResults` **8 → 50** (the API maximum). Same cost — 1 of 100 — for ~6× the candidates. `videos.list` takes all 50 ids in one request and bills 1 unit of the separate, ample pool.
- The client renders **8 rows at a time** and a **"Ver mais resultados"** button. The first ~6 taps are pure client-side reveals of rows we already paid for: **zero network, zero quota**.
- Only when those 50 run out does a tap fetch a real second Google page (`pageToken`).
- **Payload tradeoff:** a mapped `SearchResult` is ~180 bytes of JSON, so 50 rows is ~9 KB uncompressed / ~2-3 KB gzipped — negligible on a phone, and it buys back up to five of the day's 100 searches. Thumbnails are only fetched by the browser for rendered rows, so the unrevealed tail costs no images.
- **"Load more", not numbered pages.** One big thumb target at the end of the list beats a pager on a phone in a dark, noisy bar, and it keeps the patron's place instead of repainting the list.

### 4. Hard depth cap — `MAX_SEARCH_PAGES = 2`

Page depth is rationed:

- Page 1 (50 rows, ~6 client pages) costs 1 of 100 and covers the overwhelming majority of "I didn't find it".
- **One** deep page is allowed — up to 100 rows — because "people might not find it on the first search" is a real observed failure, and it only fires on a deliberate tap *after* the patron has already looked at 50 candidates.
- **Page 3+ is refused.** A patron who has rejected 100 karaoke videos will not be rescued by another 50, and each further page is another 1% of the platform's day. At the cap the UI switches to *"Não achou? Tenta buscar com outras palavras."*
- **Nothing is ever prefetched.** A page is fetched only after a tap, so we never spend a daily search on results nobody scrolls to.

Enforced on **both** sides: the client stops offering the affordance, and the route rejects `page > MAX_SEARCH_PAGES` with a 400 before any outbound call. (Google's cursors are opaque, so the client declares its depth; this is a budget guard against a client bug or a naive scripted loop, not a security boundary — the dual uuid/IP rate limiter is what bounds a hostile caller.)

### 5. Caching, including paged results

`cacheKey(q, regionCode, pageToken)` folds the cursor in, so **every** page — not just the first — is its own entry. Paging forward then back over an evening costs zero. The cached value became a `SearchPage` (`{ results, nextPageToken? }`) so a page's forward cursor is cached with its rows.

Back-compat is deliberate:
- The **first-page key is byte-identical** to the pre-ticket key, so live Redis entries aren't orphaned.
- The reader still accepts a **legacy bare array**, so entries written by the previous deploy stay valid for their 12h TTL instead of being read as corrupt and re-spending a daily search each.
- Fail-open is unchanged throughout: any Redis error is a cache miss, never a broken search.

### 6. Degraded path

No API key / quota exhausted → the route still returns `{ degraded: true, results: [] }` and the client still shows the paste-a-link fallback. With no results there is nothing to page, so pagination is **absent, not broken**: no load-more, no mode badge. A pasted link resolves locally as a single mode-irrelevant row — no pagination, no stale-mode notice, no API call. `pageToken` on the degraded path is simply ignored.

## Quota cost per patron interaction — before / after

Costs are in **daily `search.list` calls** (the scarce bucket, 100/day platform-wide). The separate metadata pool is noted where it applies but is not the constraint.

| Interaction | Before | After |
|---|---|---|
| One search, cold cache | 1 (+1 metadata unit), returns **8** rows | 1 (+1 metadata unit), returns **50** rows |
| One search, warm cache (any venue, 12h TTL) | 0 | 0 |
| **Change sing/vibe after searching** | **1** (silent automatic re-search) | **0** |
| Change sing/vibe before typing | n/a (impossible) | **0** |
| "Load more" ×1–5 (rows 9–50) | n/a (unreachable) | **0** |
| "Load more" past row 50 (deep page), cold | n/a | **1** (+1 metadata unit) |
| Same deep page revisited / another patron, warm | n/a | **0** |
| Explicit "search again" in the other mode, cold | 1 | 1 |
| Deep page 3+ | n/a | **refused** (400, no call) |

**Common path** (one search, maybe a mode change): **2 → 1** daily searches. Strictly better, which is the acceptance criterion. **Worst case** for a single query is **2** (page 1 + one deep page), reached only by a patron who deliberately taps past 50 results — and it is capped there.

Net effect on a busy bar night: the old flow spent a daily search on every mode flip and still could not show a ninth result. The new flow spends one on the search, nothing on mode changes, nothing on the first ~6 pages, and at most one more if the patron really digs.

## Files changed

- `components/SongSearch.tsx` — mode chooser above the input, mode-ref decoupling, load-more, mode badge/stale notice.
- `app/(patron)/[room]/PatronRoom.tsx` — mode `<select>` removed (state still owned here; it rides on submit); table field now full width.
- `lib/youtube-search.ts` — `SearchPage`, `searchYouTubePage()`, `maxResults` 8→50, `MAX_SEARCH_PAGES`, `CLIENT_PAGE_SIZE`, page-scoped `cacheKey`, page-aware LRU. Corrected quota model in the header.
- `lib/search-cache.ts` — page-shaped payloads + legacy-array back-compat. Corrected quota model in the header.
- `app/api/search/route.ts` — `pageToken` + `page` params, validation, depth cap, page-scoped cache, `nextPageToken` in the response.
- `messages/{pt-BR,en,es}.json` — 11 new `Search` keys, all three catalogs.
- `__tests__/search-pagination.test.ts` (new), `__tests__/search-cache.test.ts`, `e2e/search.spec.ts`.

## Reviewer-gate fixes (opus, clean context)

The first review returned CHANGES REQUESTED with two MEDIUM blockers, both real and both fixed:

1. **Cache-key collision → page-2 poisoning.** The page marker was lowercase `p:` while the query is lowercased into the same namespace, so a crafted first-page query `p:<token>::<query>` could occupy the legitimate page-2 entry — and `nextPageToken` is handed to every client, so the cursor is not secret. Impact: attacker-chosen videos served as page 2 to every venue for the 12h TTL, on a product that feeds a bar's TV queue. Fixed by making the marker **uppercase `P:`**, which is unforgeable from the query side because the query is lowercased. The first-page key stays byte-identical. Regression test added.
2. **"Load more" could spend a daily search on the wrong query.** `loadMore` used the live `input` with the *previous* query's cursor — during the 400ms debounce the old results and button are still painted, so a tap sent new-query + old-cursor: a guaranteed cache miss, one of the day's 100 searches wasted and junk cached for 12h. Fixed by pinning `resultsQuery` alongside `resultsMode` and paging against that; additionally the load-more affordance now **withdraws** (`queryDirty`) while the input has moved off the query the cursor belongs to. Revealing already-fetched rows stays available throughout, since that is free. E2E regression test added.

Non-blocking items also addressed:
- **Depth cap was sidesteppable** via `page=1&pageToken=<deep cursor>`. The route now requires `page` and `pageToken` to **agree** (page 1 ⟺ no cursor), so the declared depth cannot lie in that direction. Two tests added.
- A leftover comment still cited the **old "~101 quota units"** model — the exact figure this ticket corrects. Fixed.
- The visually-hidden radios left the mode chips with **no visible focus ring**; keyboard focus now paints an outline on the chip.

Accepted and left as-is: a legacy (pre-deploy) bare-array cache entry has no `nextPageToken`, so for up to 12h after deploy a patron on such an entry sees "that's everything" rather than a load-more. Self-heals on TTL expiry and costs nothing; forcing a re-fetch would spend daily searches to fix a cosmetic transient.

## Out of scope / follow-ups

- The TICKET-85 spike's own follow-ups touch these files; the TM is sequencing them after this PR merges.
- Board rows and the quota form still describe the pre-June model. Corrected here only in the files this ticket owns.
