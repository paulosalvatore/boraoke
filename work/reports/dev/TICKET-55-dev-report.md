# TICKET-55 — Dev report

Status: IMPLEMENTED — full suite green, build green, ready for gates.
Branch: `ticket/55-upstash-search-cache` (worktree `.worktrees/ticket-55`, base `origin/main` @ 1f24e33).

## Exploration summary

- `lib/youtube-search.ts` held the per-instance query cache (`cacheKey`/`getCached`/`setCached`, 60s TTL, 100-entry LRU) AND the dual-bucket rate limiter (out of scope — untouched).
- `app/api/search/route.ts` is the sole cache consumer; hit path returns `{ results, cached: true }`, write happens only after a successful `searchYouTube()` (errors throw first — so "never cache errors" was already structurally guaranteed and is preserved).
- Driver pattern to mirror: `lib/rate-limit-counter.ts` (STORE_DRIVER override → auto-Upstash on `UPSTASH_REDIS_REST_URL` → memory fallback; lazy `Redis.fromEnv()`; fail-open try/catch on every Redis call; `rl:` key namespace). Its test file shows the sanctioned `jest.mock("@upstash/redis")` + `jest.resetModules()` technique.
- `lib/search-query.ts` (TICKET-40) documents that mode augmentation happens client-side precisely so the query-string cache key stays coherent — no mode dimension needed in the key.
- Existing normalization: trim + lowercase + regionCode scope. Ticket asked for whitespace collapse too → added.

## Implementation log

- `lib/search-cache.ts` (new): `getCachedSearch`/`setCachedSearch`, `sc:` Redis namespace, two-tier (memory L1 → Redis), TTLs `SEARCH_CACHE_TTL_MS` = 12h (non-empty) / `SEARCH_CACHE_EMPTY_TTL_MS` = 10min (empty), shape-guard on Redis payloads, fail-open on every Redis error.
- `lib/youtube-search.ts`: `cacheKey()` now also collapses internal whitespace runs; comment updates only otherwise. Rate limiter byte-identical.
- `app/api/search/route.ts`: swapped `getCached`/`setCached` for `await getCachedSearch`/`await setCachedSearch`; response shapes unchanged.
- `__tests__/search-cache.test.ts` (new, 13 tests) + 1 normalization test in `__tests__/youtube-search.test.ts`.
- Ticket doc: `work/tickets/TICKET-55-upstash-search-cache.md`.
- Commit: see branch head (single commit, explicit file list, no lockfile change).

## Self-verification

- `npx jest`: **43 suites passed, 608/608 tests passed** (pre-ticket baseline on this base: 594; +14 new).
- `npm run build`: **exit 0**, compile + lint + type-check clean.
- No new dependency; `package-lock.json` untouched (`@upstash/redis` pre-existing).

## Friction

- None notable. (Main checkout has no `node_modules`, so the pre-change baseline count is derived arithmetically, not re-run.)
