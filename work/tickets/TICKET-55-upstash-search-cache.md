# TICKET-55 — Upstash-backed YouTube search cache (cross-instance)

Type: operational debt / quota economy · Backend-only · Priority: P0
Filed by: PR #8 opus reviewer ("biggest quota lever")
Branch: `ticket/55-upstash-search-cache` (worktree `.worktrees/ticket-55`)

## Problem

A YouTube Data API search costs ~101 quota units (search.list 100 + videos.list 1) against a 10,000/day default quota — ~99 searches/day TOTAL. The existing query cache in `lib/youtube-search.ts` is a per-lambda in-memory Map with a 60s TTL, so on Vercel every cold/parallel instance re-burns quota for the same query. The cache must be shared across instances.

## What changed

- **New `lib/search-cache.ts`** — cross-instance search-results cache backed by Upstash Redis, following the exact driver-resolution pattern of `lib/rate-limit-counter.ts` / `lib/store.ts` (`STORE_DRIVER` override, auto-Upstash when `UPSTASH_REDIS_REST_URL` is present, lazy `Redis.fromEnv()`, memory fallback otherwise). Redis keys are namespaced `sc:` (collision-free with the store keys and the `rl:` counter namespace).
- **Two-tier on the Redis path**: the pre-existing in-memory LRU stays as an L1 in front of Redis — a warm lambda answering the same hot query within 60s skips even the Redis round-trip, and a Redis hit warms the L1.
- **`app/api/search/route.ts`** now reads through `getCachedSearch()` BEFORE any Data API call and writes through `setCachedSearch()` only after a successful `searchYouTube()`. Response shape unchanged (hit still returns `{ results, cached: true }`).
- **`cacheKey()` normalization extended** (in `lib/youtube-search.ts`): trim + lowercase (pre-existing) **+ collapse internal whitespace runs** to one space — `"foo  bar"` and `"foo bar"` now share one cross-instance entry.

## Decisions (documented per ticket scope)

- **TTL, non-empty results: 12 hours** (`SEARCH_CACHE_TTL_MS`). Karaoke search results are highly static day-over-day; 12h is the midpoint of the ticket's 6–24h guidance — one ~101-unit burn per query per day-part instead of one per instance per minute, while still surfacing fresh uploads within a day.
- **TTL, empty results: 10 minutes** (`SEARCH_CACHE_EMPTY_TTL_MS`). Empties ARE cached (they are successful API answers; repeated typo/miss queries would otherwise re-burn 100 units each) but only briefly, so a transient empty (typo, regional hiccup, brand-new upload) never pins "no results" for 12h.
- **API errors are never cached**: the route only writes to the cache after `searchYouTube()` resolves; quota/upstream errors throw before the write.
- **Fail-open everywhere**: any Redis error → `get` behaves as a miss, `set` no-ops; worst case is exactly the pre-ticket behavior (a quota-charged live call). Search never breaks on a Redis blip.
- **Memory fallback unchanged**: without Upstash env, behavior is byte-identical to before (same 60s TTL / 100-entry LRU in `lib/youtube-search.ts` — local dev, CI, zero-secret boot).

## Explicitly OUT of scope (guardrail honored)

- The dual-bucket sliding-window search **rate limiter** in `lib/youtube-search.ts` is untouched (byte-identical). Making it cross-instance is deferred follow-up **FU-2b**.
- No public API shape, response format, or UI change.
- No new dependency (`@upstash/redis` already in the repo; `package-lock.json` unchanged).

## Test / build results

- New `__tests__/search-cache.test.ts` (13 tests): memory-fallback round-trip + 60s TTL + Redis-never-touched; Redis path — `sc:` key + 12h px TTL (non-empty), 10min px TTL (empty), L1-before-Redis ordering, L1 warming on a Redis hit, corrupt-payload rejection, fail-open on thrown GET and SET. Plus 1 new `cacheKey` whitespace-normalization test in `__tests__/youtube-search.test.ts`.
- `npm test` (jest): **608/608 passed, 43/43 suites** (594 pre-existing + 14 new).
- `npm run build` (next build): **exit 0** — compiled, lint + type-check pass.
