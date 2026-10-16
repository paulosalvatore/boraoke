# Security Report — TICKET-135/136: folded search cache key + 7-day TTL

**Verdict: PASS-WITH-NOTES**
**Date:** 2026-10-15
**Auditor:** Cyber Security agent (light D-011 gate)
**PR:** #97 (`ticket/135-cache-key`), head 829099e

## Scope audited

`git diff origin/main...HEAD`: `lib/youtube-search.ts` (`cacheKey`), `lib/search-prefix.ts` (`foldSearchKey`, `foldTokens`), `lib/search-query.ts`, `lib/search-cache.ts` (TTL), `app/api/search/route.ts` (comments only), single-flight key use. Targeted jest (search-cache-key-fold, search-single-flight, search-cache, search-query): 4 suites, 132 tests, all pass. Probes were run through a throwaway jest file (removed, tree clean).

## Findings

### 1. MEDIUM — cache-key collision with different Google semantics (poisoning amplified by the 7 d TTL)

Google receives the original `q`, but the key now drops every non-alphanumeric character and any extra `karaoke` token. YouTube `q` supports operators (`-term`, `|`, `"phrase"`). Probe against the key of `"evidencias karaoke"` (`BR::evidencias karaoke`):

- COLLIDE: `evidências!!! karaokê`, `Karaoke  EVIDENCIAS`, `evidencias_karaoke`, `evidencias.karaoke`, `evidencias (karaoke)`, `evidencias karaoke karaoke` (benign, same intent).
- COLLIDE with a DIFFERENT Google result set: `evidencias -karaoke` (the excluded token is dropped and one `karaoke` is re-added, so the page of non-karaoke videos is served), `evidencias | karaoke` (OR, broad results), `"evidencias" karaoke` (phrase), `evidencias +karaoke`.
- Distinct (safe): `evidencias karaoke -oficial` (extra token stays in the key), Cyrillic `е`, fullwidth `ｅ` (fold is NFD + lowercase, not NFKD, so homoglyphs do not merge).

Impact: any caller of `/api/search` (v2 + `live=1`, subject to the per-uuid/IP rate limit) who is first to miss on a popular key can pin a non-karaoke or off-intent page for that key for 7 days for every venue. The attacker cannot choose arbitrary videos, only which real YouTube result set for related text is stored, so this is relevance/integrity degradation with a quota-neutral cost, not content injection. It already existed in a narrower form (case/whitespace) and the TTL (12 h to 7 d) multiplies it by 14. Not a BLOCKER/HIGH, so the gate passes.

Remediation direction (ticket it, ideally before or with this merge): either (a) strip or neutralise operator characters (`-`, `|`, `"`, `+`) from the `q` sent to Google so the key and the upstream query agree, or (b) send Google the folded query (the same string the key is built from), or (c) keep a leading `-` / `|` / `"` as a distinguishing marker in the key. Option (b) makes the key and the upstream call identical and closes the whole class. Add a test that `evidencias -karaoke` does not share a key with `evidencias karaoke`.

### 2. INFO — key injection: clean

The folded part contains only `[\p{L}\p{M}\p{N}]` and spaces, so no `:`. Probe: `a:b` -> `BR::a b`; `P:x::a` -> `BR::p x a`; a real page key is `BR::P:tok:en::a` (uppercase marker outside the fold, cursor unfolded). The no-letter fallback keeps the old form and cannot equal a fold result. Single-flight keys use `sf:lock:` / `sf:err:` as prefixes ahead of the cache key, so no suffix forgery. No collision found.

### 3. INFO — ReDoS: none

Regexes are linear character classes (`[^\p{L}\p{M}\p{N}]+` with `gu`, `[̀-ͯ]`), no nesting or backtracking. The route caps `q` at 100 characters before the fold (route.ts). Probes: 100-char adversarial strings 0.02-0.14 ms; 1M chars of `!` plus 1M combining marks 481 ms total even without the cap.

### 4. INFO — 30-day retention: holds

Redis non-empty 7 d, empty 10 min, memory L1 60 s (`MEMORY_CACHE_TTL_MS`), index `INDEX_MAX_AGE_MS` 30 d. Guard test asserts each TTL and the sum of Redis TTL + L1 are at most 30 d. Redis writes always carry `px`. Old key shapes age out within 12 h. Holds in every layer.

### 5. INFO — stale cached pages

Deleted or private videos, and old `nextPageToken`s, are handled by the TV watchdog skip and fail-soft degraded response (documented in route.ts). Acceptable.

## Verdict

PASS-WITH-NOTES. One MEDIUM (finding 1) to ticket; no BLOCKER/HIGH.
