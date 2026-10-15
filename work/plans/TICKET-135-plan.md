# TICKET-135 + TICKET-136 — plan (one PR)

**Approval:** scope pre-approved by the boraoke Product TM in the dispatch brief of 2026-10-15 (both tickets filed from `work/plans/SCOPE-search-cache-pagination.md` section 3, "may ship in one PR"). This file records the approach for the Reviewer; it was written alongside the implementation, not ahead of a separate plan gate.

## Approach

### TICKET-135 — fold the cache key
- New `foldSearchKey()` / `foldTokens()` in `lib/search-prefix.ts`, next to `normalizeQuery` and built on the same `stripDiacritics`, so the key fold and the karaoke index fold have one home (TICKET-137 can import it).
- Fold = lowercase, NFD + strip U+0300–036F, anything that is not `\p{L}\p{M}\p{N}` becomes a space, collapse. Every `karaoke` token is removed and one is appended at the end.
- Deliberate difference from `normalizeQuery`: other scripts keep their letters. `normalizeQuery` keeps only `[a-z0-9]`, which would fold every Japanese/Cyrillic/Hangul query to "" and, in sing mode, every one of them to `BR::karaoke`. For Latin input the two agree exactly (tested over every published production string).
- `cacheKey()` folds only the query part. The uppercase `P:<token>::` marker and the token stay outside, unfolded. A query with no letter or digit keeps the pre-135 form (it can never equal a fold result, which always has one).
- `containsKaraoke()` (`lib/search-query.ts`) compares on `foldTokens`, so `karaokê` is not followed by a second `karaoke`, and the index tier treats a `karaokê` query as sing mode.
- Google still receives the original `q`. Single-flight keys (`sf:lock:` / `sf:err:` + cache key) inherit the fold.

### TICKET-136 — TTL
- `SEARCH_CACHE_TTL_MS` 12 h → 7 d. Empty stays 10 min. Errors stay uncached.
- Guard: every TTL (non-empty, empty, memory L1, and non-empty + L1 re-warm) ≤ `INDEX_MAX_AGE_MS` (30 d).
- Route header notes the stale-page paths: deleted/non-embeddable video picked from a stale page (TV watchdog backstop, TICKET-41) and an expired cached cursor (fails soft, not cached).

## Files
`lib/search-prefix.ts`, `lib/youtube-search.ts`, `lib/search-query.ts`, `lib/search-cache.ts`, `app/api/search/route.ts`; tests `__tests__/search-cache-key-fold.test.ts` (new), `search-single-flight.test.ts`, `search-query.test.ts`, `search-cache.test.ts`, `search-pagination.test.ts` (comment only); `work/measurements/ticket-135/` + `measure:t135` script.

## Risks
- Quality: the first variant's Google page is served to every variant for 7 d. Checked in `work/measurements/ticket-135/RESULTS.txt` and the dev report.
- Old keys are not migrated. Plain lowercase ASCII keys are byte-identical to before; accented/punctuated ones age out within their old 12 h TTL.
- A cached page-2 cursor may now come from a differently spelled variant. Google either answers it (cached under the folded key) or rejects it (fails soft).

## Test strategy
Unit + route tests, reverse-checked against the pre-fix code, plus a triggered mutation pass on the fold (key path). Targeted jest while developing, one full jest. e2e and `next build` owed, scheduled by the TM.
