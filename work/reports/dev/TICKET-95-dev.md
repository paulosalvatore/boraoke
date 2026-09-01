# TICKET-95 — Dev report

## Status
Implementation complete (MEDIUM-1 + MEDIUM-3). All unit/integration tests, rotation-engine tests,
and the build are green. Playwright is running (background, expected 6-9 min) — this report will
be appended with its result before requesting any gate.

## Context
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t67-embed-cache`
- Branch: `ticket/95-embeddability-cache`
- Ticket: TICKET-95, implementing MEDIUM-1 + MEDIUM-3 from
  `work/tickets/TICKET-67-embeddability-check-cyber-followups.md`. MEDIUM-2 explicitly out of
  scope — recommendation only, see below.
- No PR opened yet (per dispatch instructions — Tech Manager opens/merges).

## Stale premises in TICKET-67 — verified and corrected
1. **Wrong quota bucket named.** TICKET-67 (filed 2026-08-06) frames MEDIUM-1 as a `search.list`
   quota-drain fix ("up to ~86,400 units/day/IP against a default 10,000-unit daily quota"). That
   predates the 2026-06-01 quota-model change, already documented and corrected in
   `lib/search-cache.ts`'s header (TICKET-83/85): `search.list` is now its own 100-CALLS/DAY
   bucket; `videos.list` (what `checkEmbeddable` calls) costs 1 unit against a SEPARATE
   ~10,000/day pool boraoke barely touches. So this ticket is a latency/held-concurrency and
   general-hygiene fix, not a `search.list`-quota fix. I documented this correction directly in
   `lib/embed-cache.ts`'s header so a future reader doesn't reinherit the stale framing.
2. **MEDIUM-2 partly shipped, but only for the other bucket.** `lib/search-budget.ts` (TICKET-87)
   is a cross-instance daily counter, but it only reserves `search.list` calls — nothing in this
   codebase bounds the platform-wide `videos.list` pool the same way. Confirmed by reading
   `lib/search-budget.ts` in full: it's `search.list`-specific end to end (key prefix `sb:`, the
   `reserveSearchCall()` API, the header's own framing). I did NOT extend it to `videos.list` —
   see recommendation below.
3. **LOW-1 (spoofable `x-forwarded-for`) already fixed.** Confirmed `lib/host-auth.ts`'s
   `clientIpFrom` is what `app/api/queue/route.ts` now uses (not a raw XFF read) — consistent with
   the TICKET-78/86 fix cited in the dispatch. Not touched here.

## Implementation (MEDIUM-1)

New module `lib/embed-cache.ts`, deliberately mirroring `lib/search-cache.ts`'s established shape
(explicitly required by the dispatch — "do not invent a new pattern"):
- In-process L1 Map (own copy — the cached shape here, a single `EmbeddableStatus` string per
  `videoId`, is unrelated to the `SearchPage` L1 in `lib/youtube-search.ts` that `search-cache.ts`
  reuses), bounded at 500 entries, LRU-evicted.
- Redis-backed cross-instance layer (`ec:` key prefix — collision-free with `sc:`/`sb:`), same
  driver resolution as `search-cache.ts`/`search-budget.ts` (each module keeps its own copy per
  existing house convention — verified `search-cache.ts` and `search-budget.ts` do NOT share this
  logic either).
- `getCachedEmbeddable(videoId)` → `EmbeddableStatus | null` (null = miss, fail-open on any Redis
  error).
- `setCachedEmbeddable(videoId, status)` → TTL split: **24h** for `embeddable`/`not-embeddable`
  (a channel-owner setting that essentially never flips within a day), **10min** for `unknown`
  (matches `search-cache.ts`'s empty-result TTL reasoning — `unknown` conflates a permanent state
  with a transient failure, so it must not be pinned).
- Every Redis call try/caught — fail-open preserved throughout.

`checkEmbeddable` itself (`lib/youtube.ts`) is **unchanged and still uncached** — deliberate. Its
existing unit tests (`__tests__/youtube.test.ts`) call it directly and assert exact `fetchImpl`
call counts on a reused `VALID_ID` across many test cases; baking caching into the function itself
would have broken those tests on any repeated videoId. Caching lives at the call site instead —
the same separation `lib/search-cache.ts` has from `searchYouTubePage` (the route wires the cache
around the raw call, not inside it).

Wired into `app/api/queue/route.ts`'s existing TICKET-61 paste-path block: cache consulted before
any outbound call (only when a key is configured — matching `checkEmbeddable`'s own no-key
short-circuit, so a no-key "unknown" is never written to the cache as if it were a real answer),
only a REAL `checkEmbeddable` answer is written back.

## Implementation (MEDIUM-3)

`EMBEDDABLE_CHECK_TIMEOUT_MS`: **1500ms → 800ms**. Argument (also in the code comment):
- The cache now answers the common case (a repeat videoId) with zero network calls, so this budget
  only bites on a genuine miss.
- Google's `videos.list` is normally well under 800ms end-to-end; a timeout fails OPEN to
  "unknown" (never blocks the submit), so tightening only trades a few accurate not-embeddable
  warnings under real upstream slowness for materially less held concurrency on this
  unauthenticated, most-hit mutation route during a slow-upstream or miss-burst window.
- Chose 800ms (the ticket's suggestion) rather than lower: Data API p99s occasionally land in the
  400-700ms range from some regions, and cutting closer would start trading real warnings for
  negligible additional hold-time savings. The existing test only asserts `<= 3000`, so this is
  compatible.

## MEDIUM-2 — recommendation (NOT implemented, per dispatch)

`lib/search-budget.ts` (TICKET-87) is `search.list`-specific. Whether to extend an equivalent
cross-instance daily-budget counter to the `videos.list` pool is a genuine design call, not
something I should slip into this PR. My recommendation: **low priority, defer.**
- `videos.list`'s pool is ~10,000/day vs. `search.list`'s 100/day — two orders of magnitude more
  headroom, and it's shared with every other metadata endpoint in the codebase, not just this
  check.
- With MEDIUM-1 landed, the actual outbound `videos.list` call rate drops sharply (one call per
  distinct videoId per 24h, platform-wide, on the happy path) — the attack surface this would
  protect against is now much smaller: an attacker would need to submit many DISTINCT (never
  previously seen) videoIds to force repeated real calls, and `submitRateLimitOk` already bounds
  submit velocity per uuid/IP.
- If it's ever wanted, the shape would mirror `reserveSearchCall()` closely (atomic Lua EVAL,
  fail-closed since an unaccounted spend has the same "no self-healing until reset" property) —
  but I'd want the TM/TL to decide whether the current per-uuid/IP submit rate limit is judged
  sufficient before spending the implementation cost.

## Tests added

- `__tests__/embed-cache.test.ts` (new, 20 tests) — mirrors `__tests__/search-cache.test.ts`:
  memory-only L1 path (miss/hit round-trip for all 3 statuses, distinct-key isolation, invalid-id
  handling, TTL expiry for both the 24h and 10min windows, never touches Redis), and the mocked-
  Redis path (prefixed keys, TTL split verified in the actual `set()` call args, L1-before-Redis
  ordering, L1 warming on a Redis hit, corrupt-payload rejection, fail-open on thrown GET and SET
  errors).
- `__tests__/api-queue.test.ts` — new `describe("POST /api/queue — embeddability cache (TICKET-95)")`
  block (3 tests): a hit spends zero outbound calls across two distinct patrons submitting the
  same videoId; a cached `not-embeddable` verdict still carries the warning on the cached submit;
  no-key submits never write a cache entry (so restoring the key later still triggers a genuine
  live call, not a stale poisoned "unknown").

## Negative control (mandatory — actual numbers)

1. **Route wiring removed** (`app/api/queue/route.ts` reverted to pre-change via `git checkout`,
   `lib/embed-cache.ts` left in place unused): ran only the new TICKET-95 describe block —
   **2 failed / 1 passed** (the "no API key" test still passes because it exercises
   `checkEmbeddable`'s own pre-existing no-key short-circuit, unrelated to the cache wiring). Both
   failures were exactly the "hit spends zero calls" assertions, `fetchMock` called once instead
   of zero — proving the tests catch the missing wiring. Restored the real route.ts, re-ran full
   target suite: 92/92 pass again.
2. **`getCachedEmbeddable` neutered** (temporarily made it `return null` unconditionally, i.e.
   always-miss, before its real body): ran `__tests__/embed-cache.test.ts` alone — **11 failed / 9
   passed**. The 9 that still passed are the ones that don't depend on a successful get (TTL
   constant checks, the "never touches Redis" test, `getMock`-not-called SET-only checks, and the
   `set()` call-arg assertions that don't round-trip through get). Restored the real file, re-ran:
   20/20 pass.

Both negative controls confirm the new tests are load-bearing, not decorative.

## Gate results (exact numbers)

- `npx jest` (full suite): **52 suites passed / 52 total, 917 passed / 5 skipped / 922 total**, 11.656s.
  (The 5 skipped are pre-existing, unrelated to this ticket.)
- `cd packages/rotation-engine && node --test`: **59 pass / 0 fail** (exactly the expected 59).
- `npm run build`: **compiled successfully**, all 33 routes generated, no type errors.
- `npx playwright test`: **[appended below once the background run completes — see Status]**.

## Friction
None worth flagging as a systemic issue. The one thing worth naming for a future Dev touching this
file: `lib/search-cache.ts` and `lib/search-budget.ts` both duplicate their own `useUpstash()` /
`getRedis()` driver-resolution block rather than sharing one — I followed that same duplication in
`lib/embed-cache.ts` for consistency, but a 4th cache module (if one shows up) might be the trigger
to finally extract that into a shared helper.
