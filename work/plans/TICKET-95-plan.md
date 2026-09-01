# TICKET-95 — plan (MEDIUM-1 + MEDIUM-3 from TICKET-67)

## Scope
- MEDIUM-1: cross-instance cache for `checkEmbeddable` (`lib/youtube.ts`), keyed on `videoId`,
  following `lib/search-cache.ts`'s established Upstash shape (L1 in-process + Redis, fail-open).
- MEDIUM-3: reassess `EMBEDDABLE_CHECK_TIMEOUT_MS` now that the cache removes the common case.
- OUT OF SCOPE: MEDIUM-2 (cross-instance rate limiting / quota-budget on `videos.list`) — report a
  recommendation only, per dispatch instructions.

## Stale-premise corrections to make in code comments + report
- `checkEmbeddable` calls `videos.list`, which since TICKET-83/87 draws from the SEPARATE
  ~10,000/day pool, NOT the 100/day `search.list` bucket the original ticket assumed.
- TICKET-87 already added `lib/search-budget.ts`, a cross-instance daily counter — but it covers
  `search.list` only. Extending it to `videos.list` is MEDIUM-2, a TM-level design call.
- LOW-1 (spoofable XFF) already fixed by TICKET-78/86 — not touched here.

## Approach
1. New module `lib/embed-cache.ts` mirroring `lib/search-cache.ts`:
   - Own in-process L1 Map (LRU-ish, capped, short TTL) since embeddability status has a
     different shape/keyspace than the SearchPage L1 in `lib/youtube-search.ts`.
   - Redis-backed cross-instance layer, `ec:` key prefix, `Redis.fromEnv()`/`STORE_DRIVER` driver
     resolution duplicated per house convention (each cache module owns its own copy).
   - `getCachedEmbeddable(videoId)` → `EmbeddableStatus | null` (null = miss/fail-open).
   - `setCachedEmbeddable(videoId, status)` → TTL split: long for `embeddable`/`not-embeddable`,
     short for `unknown` (transient failures must not pin).
   - Every Redis call try/caught; on error behaves as a miss (get) or no-op (set).
2. Wire into `app/api/queue/route.ts`'s existing TICKET-61 paste-path block: consult the cache
   before calling `checkEmbeddable`; write the result after a real API answer. `checkEmbeddable`
   itself stays UNCHANGED (uncached) — its existing unit tests call it directly and assert
   `fetchImpl` call counts per invocation; baking caching into the function itself would break
   those tests on any repeated videoId across test cases. Caching lives at the call site, same
   separation `lib/search-cache.ts` has from `searchYouTubePage`.
3. MEDIUM-3: tighten `EMBEDDABLE_CHECK_TIMEOUT_MS` 1500 → 800, argued in the PR body (only matters
   on a cache miss now; Google's API is normally sub-200ms; a timeout fails open to "unknown" —
   never blocks the submit — so tightening only trades a few accurate warnings for less held
   concurrency on an unauthenticated route during a slow-upstream/miss-burst).

## Files touched
- `lib/embed-cache.ts` (new)
- `app/api/queue/route.ts` (wire cache read/write around the existing paste-path block)
- `lib/youtube.ts` (timeout constant + comment)
- `__tests__/embed-cache.test.ts` (new — mirrors `__tests__/search-cache.test.ts`)
- `__tests__/api-queue.test.ts` (append: cache-hit skips the outbound call, TTL-split behavior at
  the route level)

## Test strategy
- Unit: embed-cache memory path + mocked-Redis path (hit/miss, TTL split, L1 warming, fail-open on
  thrown Redis errors) — mirrors `__tests__/search-cache.test.ts` structure.
- Integration: `__tests__/api-queue.test.ts` — two paste submits of the SAME videoId (different
  patronUuid so no duplicate-refusal) spend exactly ONE outbound call.
- Negative control: confirm the new tests fail without the source change (revert, run, restore).
- Full gate: `npm test`, `rotation-engine node --test` (59 pass expected), `npm run build`,
  `npx playwright test` (known `e2e/feedback.spec.ts` flake per TICKET-94 — re-run once to confirm
  before reporting any other Playwright failure as a regression).

## Risks
- Cache correctness must never mask a genuinely fresh "not-embeddable" flip for longer than the
  TTL — acceptable, documented, matches the search-cache precedent for a slower-changing signal.
- Must not let a cache write happen when no API key is configured (that "unknown" is a config
  fact, not a real API answer) — gate the whole cache-read/write path on `key` being present,
  same as `checkEmbeddable`'s own no-key short-circuit.
