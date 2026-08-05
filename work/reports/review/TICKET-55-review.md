# TICKET-55 — Reviewer report (D-022 opus merge-counting review)

Branch: `ticket/55-upstash-search-cache` · worktree `.worktrees/ticket-55` · base `origin/main` @ 1f24e33 · reviewed commit `f48c62b`.

## Verdict: APPROVE

Upstash-backed cross-instance search cache is correct, cleanly scoped, well-tested, and fail-open. Rate limiter is untouched. No security regressions on the public search endpoint. Reproduced green.

## Independent verification (ran, did not trust)

- **Jest:** `npx jest` → **43 suites passed, 608/608 tests passed** (matches dev claim of 594 baseline + 14 new). Time 8.1s.
- **Build:** `npm run build` → **exit 0**, "Compiled successfully". Only warning is the pre-existing benign Next.js workspace-root inference warning (multiple lockfiles) — unrelated to this change.
- **Diff discipline:** `git diff origin/main...HEAD --name-only` = exactly the 7 claimed files (2 source, 1 route, 1 new lib, 2 tests, 2 docs). No `package-lock.json` change (confirmed absent from diff; `@upstash/redis ^1.38.0` already a dependency). No events/heartbeat/telemetry files staged.

## Findings

### Correctness — PASS
- **Cache-hit avoids the API call:** route.ts:98 `getCachedSearch` runs before the `searchYouTube()` try-block (line 105); a hit returns at line 101. Verified quota-zero hit path.
- **Miss populates with correct TTLs:** `setCachedSearch` writes `redis.set(sc:<key>, results, { px })` with `SEARCH_CACHE_TTL_MS`=12h for non-empty, `SEARCH_CACHE_EMPTY_TTL_MS`=10min for empty (search-cache.ts:156-158). Asserted in tests with exact `px` args. `{ px: number }` is a valid `@upstash/redis` SetCommandOptions variant (confirmed in installed type defs) — build type-check passes, corroborating.
- **Write only after success:** route writes inside the try after `searchYouTube()` resolves; quota/upstream errors throw before the write (lines 105-116). Errors are structurally never cached.
- **L1 warming + ordering:** memory L1 checked first (free), Redis hit warms L1 via `memSet` (search-cache.ts:124-132). Tested: second get skips Redis; a local set serves follow-ups with zero Redis GET.
- **Memory fallback byte-equivalent:** without Upstash env, `getRedis()` returns null and the module delegates to the unchanged `memGet`/`memSet` (60s TTL / 100-entry LRU). `useUpstash()` mirrors rate-limit-counter.ts exactly (STORE_DRIVER override → auto-Upstash on REST_URL → memory).
- **Fail-open on every Redis call:** GET and SET each wrapped in try/catch returning miss / no-op. Tested for both thrown-GET and thrown-SET (L1 still warmed on SET failure). `Redis.fromEnv()` failure also degrades to memory (getRedis catch).
- **Corrupt/adversarial payload:** `isSearchResultArray` shape-guard rejects non-arrays and arrays whose elements lack a string `videoId` → treated as miss. Tested with `{nonsense:true}` and `[{notAVideoId:1}]`. Cannot crash the route or inject an unexpected response shape.
- **Empty-array handling:** empty cached results (`[]`) are truthy, so both `if (local)` and route `if (cached)` correctly serve a cached empty as `{ results: [], cached: true }`. No bug.

### Rate limiter — UNTOUCHED (guardrail honored)
The only non-comment change in `lib/youtube-search.ts` is the single `cacheKey` line (added `.replace(/\s+/g, " ")`). The dual-bucket sliding-window limiter is byte-identical (verified by filtering the diff to non-comment lines).

### Rate-limit ordering (item 5) — SAFE
`rateLimitOk(uuid, clientIp)` is charged at route.ts:79, **before** the cache read at line 98. Cached hits still consume a rate-limit token, so there is **no bypass / griefing vector** — cached traffic cannot flow unlimited past the limiter. (Cached hits cost zero YouTube quota, which is the intended win; they still cost a limiter token, which is conservative and correct.)

### Security (folded Cyber gate) — PASS
- **Cache-key injection / poisoning:** key = `sc:${regionCode}::${normalized-query}`. `regionCode` is a fixed server constant (`SEARCH_DEFAULTS.regionCode`), query is validated to 3–100 chars upstream. The `sc:` prefix is collision-free with `rl:` (counter) and the store namespace. Two distinct queries cannot collide except via the intended case/whitespace normalization. An attacker can only populate the cache for the exact query they themselves search (writes happen only after that query's own successful API response) — same trust boundary as any user; no cross-tenant/cross-query poisoning.
- **Empty-response poisoning:** empties are cached but capped at 10min, so a transient empty cannot pin "no results". Errors are never cached.
- **Quota abuse:** the cache strictly reduces quota burn; the pre-cache limiter bounds abuse. No new amplification.
- **Secrets:** no credential values logged; Redis client built via `Redis.fromEnv()`; catch blocks swallow silently without printing tokens.
- **New attack surface:** none beyond a Redis key namespace the attacker cannot address outside their own queries.

### @upstash/redis interface (item 6) — SATISFIED
`Redis.fromEnv()`, `redis.get<T>(key)`, `redis.set(key, value, { px })` all match the installed `@upstash/redis@^1.38.0` surface (and the sibling usage in rate-limit-counter.ts). Type-check (build exit 0) confirms structural fit.

### Tests — PASS (meaningful coverage)
14 new tests (13 in `__tests__/search-cache.test.ts` + 1 whitespace-normalization test in `youtube-search.test.ts`). Both driver paths covered; all claimed adversarial cases (corrupt payload, fail-open GET/SET, TTL boundaries, L1 ordering/warming, Redis-never-touched on memory path) are explicitly asserted. Mocking mirrors the sanctioned `jest.mock("@upstash/redis")` + `jest.resetModules()` technique.

### Coherence — PASS
Dev report and ticket doc match the diff exactly (file list, TTLs, test counts, scope guardrails). Reported 608/608 + build 0 reproduced.

## Follow-ups (non-blocking, already documented as out-of-scope)
- **FU-2b:** making the dual-bucket search rate limiter cross-instance (Upstash-backed) — explicitly deferred in the ticket; not required here.

No blocking items. Recommend merge once the local-Docker CI GREEN verdict is recorded per D-051 (framework gate; this product review verifies product tests + build, both green).
