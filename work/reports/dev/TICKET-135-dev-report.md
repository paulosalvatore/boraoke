# TICKET-135 + TICKET-136 — Dev report (one PR)

## Status
Implemented and pushed (code head `c476597`). Targeted jest and one full jest green. **Owed, not run (lane constraint, host load ~146 on 10 cores with two e2e lanes on 3118/3140):** the full e2e suite and `next build`. The TM schedules them once the heavy lanes drain. No gate requested yet.

## Context
- Picking up from: fresh start, 2026-10-15. Dispatch brief from the boraoke Product TM.
- Tickets: `work/tickets/TICKET-135-fold-search-cache-key.md`, `work/tickets/TICKET-136-search-cache-ttl-7-days.md`. Scope: `work/plans/SCOPE-search-cache-pagination.md` sections 1, 3, 4. Retention rule: `work/tickets/TICKET-141-catalogue-legal-ruling-record.md`.
- Plan: `work/plans/TICKET-135-plan.md` (written with the implementation under the TM's pre-approved scope).
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t135-cache-key`, branch `ticket/135-cache-key`, cut from `origin/main` @ `d0b3301` (includes #90 `a0f2b59`).
- App/e2e port: **3135**.
- Patron-facing: no.

## Exploration (read directly; the files were named in the tickets)
- `cacheKey()` (`lib/youtube-search.ts`) folded only case and whitespace. Used by the route (`ck`) and by single-flight (`sf:lock:<ck>`, `sf:err:<ck>`).
- `normalizeQuery()` (`lib/search-prefix.ts`) is the index/prefix fold: lowercase, NFD strip, `[^a-z0-9\s]` to space. It **deletes every non-Latin letter**, which is harmless for a fuzzy matcher but would merge every Japanese/Cyrillic/Hangul query into one cache key (in sing mode, all of them into `BR::karaoke`). So the key fold reuses its pieces and agrees with it on Latin input, but keeps letters of every script.
- `containsKaraoke()` used `\bkaraoke\b`, so `karaokê` did not count and got a second `karaoke`. It is also the sing-mode test for the index tier (`lib/karaoke-index/tier.ts`) and the route.
- `PAGE_TOKEN_RE = /^[A-Za-z0-9_\-=]{1,128}$/`, so a cursor never contains `:`.
- In-memory layers: L1 LRU 60 s, single-flight lock 10 s / error marker 3 s, index load cache 1 h (index data has its own 30-day stop). Redis `sc:` writes always carry `px`.
- Stale video from a cached page: search picks skip the embeddability check (`lib/embed-cache.ts` is called from the paste path in `app/api/queue/route.ts` only). TV: `onError` → `isFatalPlayerError` (codes 2/5/100/101/150, `components/tv/watchdog.ts`) → `skipUnplayable()` → `advance("unplayable")` (`components/tv/TvScreen.tsx:438-460, 602-604`), which emits `song_skipped` (`app/api/queue/advance/route.ts`). Confirmed by reading; noted in the route header.

## Implementation log
- `c476597` — the whole change:
  - `lib/search-prefix.ts`: `foldTokens()` and `foldSearchKey()`. `karaoke`/`karaokê` tokens removed, one appended at the end.
  - `lib/youtube-search.ts`: `cacheKey()` folds only the query part; `P:<token>::` and the token are outside the fold and unchanged; a letterless query keeps the pre-135 form. L1 TTL exported as `MEMORY_CACHE_TTL_MS` for the guard.
  - `lib/search-query.ts`: `containsKaraoke()` compares on `foldTokens`.
  - `lib/search-cache.ts`: `SEARCH_CACHE_TTL_MS` 12 h → 7 d, header rewritten (30-day ceiling, footprint).
  - `app/api/search/route.ts`: header section "STALE CACHED PAGES"; comment 12h → 7-day.
  - Tests and `work/measurements/ticket-135/` (+ `npm run measure:t135`).

## Key design points
- **Google gets the original `q`.** Proven by the route test and by the variant single-flight probe (the one outbound `q` is one of the patrons' original strings).
- **Page marker outside the fold.** `cacheKey("maná karaokê","BR","CAoQAA") === "BR::P:CAoQAA::mana karaoke"`. Cursors differing only in case stay distinct. The fold output contains no `:` at all, so a typed `P:CURSOR::x` folds to `p cursor x` and cannot reach the deep-page namespace. The letterless fallback is lowercase, so it has no `P`.
- **Single-flight.** Lock and error keys are `sf:lock:` / `sf:err:` + the folded cache key. Variants of one query share one flight (probe below). The prefixes are fixed and distinct, and the fold only removes characters from the user-controlled tail, so the TICKET-126 namespace argument is unchanged; its regression test (`abc` vs `abc:err`) still passes (the latter now folds to `abc err`).
- **Retention.** Non-empty 7 d, empty 10 min, L1 60 s; a Redis hit re-warms the L1, so the longest any page lives is 7 d + 60 s. Guard test asserts each and the sum ≤ `INDEX_MAX_AGE_MS` (30 d). An entry is only rewritten by a fresh Google answer, so the TTL is never extended on old data.
- **Old keys.** Plain lowercase ASCII keys are byte-identical to before (test). Accented/punctuated/reordered keys simply age out within their old 12 h TTL.
- **Upstash footprint.** A 50-row page with long titles measures 11,838 bytes as JSON (`node -e` over a representative row); the scope's 9 KB is a fair average. At most 90 billed pages a day × 7 d: about 5-8 MB. Inside the Upstash free tier.

## Quality check (the first variant's answer is served to every variant)
The TICKET-124/125 replay inputs are absent: `work/measurements/ticket-108/production-search-results.json` and `work/measurements/ticket-124/index-fixture.json.gz` are gitignored YouTube API data, and `find` over the boraoke checkout and its worktrees found neither. So the replay was **not** re-run. What was run instead (`npm run measure:t135`, output committed as `work/measurements/ticket-135/RESULTS.txt`):

```
strings: 52 (graded 32, ungradable 20)
distinct cache keys: old 52 -> folded 50

MERGE "cerol na mao karaoke"
   "cerol na mao karaoke"       want=cerol+mao
   "cerol na mão karaoke"       want=cerol+mao
   same graded want: yes   same TICKET-125 trace (normalizeQuery equal): yes
MERGE "mana"
   "maná"                       want=mana
   "mana"                       want=mana
   same graded want: yes   same TICKET-125 trace (normalizeQuery equal): yes

merges: 2
```

Reading it:
- Over all 52 published production strings, the fold merges exactly two pairs, the two the scope predicted. No karaoke-position merge occurs in the published set.
- Every other graded query keeps its own key, so for 28 of the 32 graded queries **nothing changes**: same key, same page, same top-ranked video.
- For the two merged pairs, both members are graded against the same `want`. In the shipped TICKET-125 run all four are hits@10 (its misses are only `banderille karaoke`, `soda stete karaoke`, `banderilleros karaoke`, `work/measurements/ticket-125/RESULTS.txt`). Both pairs are also in one TICKET-125 trace, where the shipped client already serves the first member's held page to the second (`planSearch` filter, `work/measurements/ticket-108/RESULTS.txt` lines 99-100: `"mana" → "maná": planSearch = filter (50 rows, 0 calls)`, same for `cerol na mao` → `cerol na mão`). The fold makes cross-patron what the client already did within one patron's typing. So hit@10 is preserved by argument.
- **Where the top-ranked video CAN change:** exactly these two pairs. `maná` vs `mana` (and the cerol pair) are different Google queries, and when the other spelling misses first, its #1 is what this spelling sees for 7 days. Whether those #1s differ today is **UNVERIFIED**: it needs the oracle. Top-1 for every other graded query is unchanged by construction.
- Owed if the TM wants it: re-run `measure:t125` with the fold applied once the oracle and fixture are regenerated (read-only `sc:*` dump, TICKET-108 dev report).

## Self-verification

### Targeted jest (during development)
14 suites (fold, query, cache, pagination, youtube-search, single-flight, api-search, api-search-index-tier, search-prefix, all karaoke-index suites):
```
Test Suites: 14 passed, 14 total
Tests:       8 skipped, 327 passed, 335 total
```

### Full jest, once (load ~146)
```
Test Suites: 72 passed, 72 total
Tests:       21 skipped, 1312 passed, 1333 total
Snapshots:   0 total
Time:        34.412 s
```

### Typecheck
`npx tsc --noEmit -p .`: 0 errors under `lib/ app/ components/ work/ scripts/`. Errors remain only in `__tests__/` and `e2e/`, the pre-existing missing-`@types/jest` noise noted in the TICKET-126 report. No lint config exists in the repo (no `lint` script; `npx eslint` finds no config).

### Owed (not run, per the lane constraint)
- Full e2e (`npm run test:e2e`) on port 3135.
- `next build` (also checks the `u`-flag RegExp in client bundles against the ES2019 bundle target; it is built with `new RegExp(...)` so TypeScript's ES2017 target does not reject it, and all supported browsers handle `\p{...}`).

## Prove-your-test-can-fail

### (a) + (b) Reverse check: new tests against the pre-fix code
The five production files were replaced with their `HEAD` (pre-fix) versions, the new tests kept, then run (`search-cache-key-fold`, `search-query`, `search-cache`, `search-single-flight`): `Tests: 67 failed, 65 passed, 132 total`. Verbatim excerpts:

```
  ● cacheKey folds spelling variants into one key (acceptance) › ["maná","mana","Maná","MANA"] share one key
    Expected: 1
    Received: 2

  ● cacheKey folds spelling variants into one key (acceptance) › NFC and NFD spellings of the same text share one key
    Expected: "BR::evidências"
    Received: "BR::evidências"

  ● concurrent identical queries across instances › spelling variants of one folded query share ONE flight and ONE billed call (TICKET-135)
    Expected: 1
    Received: 4

  ● GET /api/search — Google gets the original query, the variant gets the cache › the first variant bills with its own text; the second is a free cache hit
    Expected: true
    Received: undefined

  ● augmentQuery (mode-aware karaoke keyword) › sing mode › does NOT append a second 'karaoke' after an accented 'karaokê' (TICKET-135)
    Expected: "evidências karaokê"
    Received: "evidências karaokê karaoke"

  ● search-cache (redis path) › set (non-empty): SET with the sc: key and the 7-day px TTL (TICKET-136)
    Expected: 604800000
    Received: 43200000
```

Also failing on the old code: the Cerol and karaoke-position acceptance groups, "moves karaoke to the end", the letterless-fallback test, the deep-page variant test, `containsKaraoke("karaokê")`, the TTL tests, and the 52 index-agreement cases (`foldSearchKey` does not exist there, so those fail as TypeErrors, not assertions).

Tests that pass on the old code **by design** (guards and characterisation, each killed by a mutant below): non-Latin queries stay distinct, digits kept, region kept, sing vs listen differ, cursor case kept, forged marker, `karaokestar`, and the TICKET-136 stale-cursor fail-soft test (the ticket asks that the route fail soft "as today").

### (c) Hollowing-out
`cacheKey()` is a primitive under existing assertions. Re-examined:
- `search-pagination.test.ts` "first-page key byte-identical" (`BR::foo bar`): still meaningful, plain ASCII is unchanged.
- "a crafted QUERY cannot forge a deep-page key": still passes, and is now stronger, since the fold strips the `:` (kept, plus a new forgery test with 4 forms).
- `search-single-flight.test.ts` "X:err never read as X's error marker": `abc:err` now folds to `abc err`, so the two keys still differ in the tail and the test still exercises distinct flights; the namespace guarantee comes from the fixed prefixes, which did not change. Not vacuous.
- `youtube-search.test.ts` case/whitespace tests: still meaningful (subset of the fold).
- `search-query.test.ts` `containsKaraoke("karaokê") === false` was the old contract and was **changed** to `true` (the ticket asks for it).

### (d) Triggered mutation pass: triggered
`foldSearchKey()` is a new normalisation function on a key path (identity of a cache entry). 22 mutants, each run against `search-cache-key-fold`, `search-query`, `search-cache`:

| # | Mutant | Result |
|---|---|---|
| M1 | no diacritic strip | KILLED (22 failed) |
| M2 | index alphabet `[a-z0-9]` only | KILLED (1) |
| M3 | drop `\p{M}` | KILLED (1) |
| M4 | drop `\p{N}` | KILLED (1) |
| M5 | no lowercase | KILLED (10) |
| M6 | karaoke not moved | KILLED (3) |
| M7 | karaoke dropped | KILLED (38) |
| M8 | karaoke always appended (`<` → `<=`) | KILLED (25) |
| M9 | one karaoke per occurrence | KILLED (1) |
| M10 | no empty-token filter | KILLED (4) |
| M11 | no letterless fallback | KILLED (1) |
| M12 | fold applied over the page marker | KILLED (5) |
| M13 | page token lowercased | KILLED (3) |
| M14 | old key (no fold) | KILLED (7) |
| M15 | `containsKaraoke` back to `\bkaraoke\b` | KILLED (2) |
| M16 | `containsKaraoke` as substring | KILLED (2) |
| M17 | TTL back to 12 h | KILLED (2) |
| M18 | TTL 31 d (past retention) | KILLED (3) |
| M19 | empty TTL = 7 d | KILLED (2) |
| M20 | route appends the raw `q` to the key for non-lowercase/non-NFC input (fold bypassed) | KILLED (1) |
| M21 | route sends the folded key text to Google | KILLED (1) |
| M22 | route caches a failed deep page as empty | KILLED (1) |

22/22 KILLED, 0 SURVIVED. Source restored after each mutant (`cmp` against the saved copies: all 5 files restored).

## Follow-ups / notes for the TM
- `normalizeQuery` (index matcher) still drops non-Latin letters. Harmless for matching, but TICKET-137 should use `foldTokens` if it ever keys stored rows by query.
- The `worktree_created` event emitted into the worktree's `work/events/by-branch/main.jsonl` rather than the main checkout's; I reverted it in the worktree to keep the branch diff clean. The ticket store row was moved to `in_progress` by `ticket-mark-workstart.sh` for both tickets.

## Friction
- None repeated twice.
