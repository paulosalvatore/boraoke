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

---

# Delta re-gate — code at d650a17 (PR head 6403938)

**Verdict: PASS-WITH-NOTES**
**Date:** 2026-11-02

## Scope

`git diff 829099e..d650a17` on `lib/search-prefix.ts` (`foldKeyTokens` per-character rule, `MARKER_TOKENS` skip of the `karaoke` move, `buildNotWordChar` fallback), `lib/youtube-search.ts` (`cacheKey`), `app/api/search/route.ts` (length cap, `PAGE_TOKEN_RE`). Probes ran on a scratch copy of `lib/search-prefix.ts` at d650a17 under `node --experimental-strip-types`, with the `cacheKey` composition reproduced (region `BR`, empty-fold fallback, `P:<token>::` marker). No live YouTube call. Worktree left clean. Targeted jest: `search-cache-key-fold`, `search-query`, `search-single-flight`: 3 suites, 158 tests, all pass.

## Finding 1 (MEDIUM, operator forms share the plain key): RESOLVED

Probe against `BR::evidencias karaoke`:

- Every operator form from the original finding now has its own key: `evidencias -karaoke` -> `BR::evidencias -karaoke`, `evidencias | karaoke` -> `BR::evidencias | karaoke`, `"evidencias" karaoke` -> `BR::" evidencias " karaoke`, `"evidencias karaoke"` -> `BR::" evidencias karaoke "`, `evidencias +karaoke` -> `BR::evidencias + karaoke`, `evidencias #karaoke` -> `BR::evidencias # karaoke`, `evidencias -"karaoke"` -> `BR::evidencias -" karaoke "`.
- Exclusion survives every separator tried on its left: tab, NBSP, ideographic space, U+2028, ZWSP, ZWJ, U+2060, BOM, U+180E, a tag space (U+E0020), `(`, `,`, and a stripped combining mark after a space. Typographic and fullwidth bars, quotes, `+`, `#` map to the same marker as ASCII.
- Same-intent forms still share the plain key, as designed: `evidencias-karaoke`, `evidencias - karaoke`, `evidencias karaoke -`, `Evidências Karaokê`, `karaoke evidencias`, `evidencias!!! karaoke`, `evidencias_karaoke`, `evidencias.karaoke`, `evidencias (karaoke)`. The two dash cases are not Google exclusions (a dash glued on the left, or followed by a space).
- The `karaoke` move is skipped whenever a `|`, quote, `+` or `#` marker is present, so the phrase and OR forms keep typed order.

## New findings

### A. LOW: characters outside the marker set still fold onto the plain key

`evidencias * karaoke`, `evidencias ~karaoke`, `@evidencias karaoke`, `evidencias karaoke*`, `evidencias $karaoke`, `evidencias /karaoke`, `evidencias \karaoke`, `evidencias &karaoke` all give `BR::evidencias karaoke`. The YouTube Data API documents only `-` (NOT) and `|` (OR) for `q`, both now kept, so these are only a problem if Google returns a materially different page for them. That was not measured, to keep quota untouched. If any of them does change the result set, it is the same first-miss pinning as finding 1, for 7 days. Uppercase `OR`/`AND` stay distinct from the plain key (the token is kept), and only merge with their lowercase spelling. Remediation direction (follow-up, not blocking): one quota-cheap spot check of `*`, `~` and `@handle` against the plain query; if any differs, add it to the marker set. The cleaner long-term fix remains sending Google the folded string, which closes the class.

### B. INFO: operator spellings merge with each other

`evidencias -karaoke`, `evidencias –karaoke` (en dash) and `evidencias −karaoke` (minus sign) share `BR::evidencias -karaoke`; `|`, `｜` and `||` share `BR::evidencias | karaoke`. If Google treats the en dash as plain text, a first miss on it would serve a karaoke page to someone who deliberately excluded karaoke. The only victim is another exclusion searcher, never the plain query. Negligible.

### C. INFO: key injection still clean

The folded part never contains `:`; `PAGE_TOKEN_RE` (`^[A-Za-z0-9_\-=]{1,128}$`) keeps `:` out of the cursor, so `P:<token>::` cannot be forged from either input. The empty-fold fallback is only taken when the fold has no word character and no marker, so it cannot equal a non-empty fold.

### D. INFO: length cap and linear time confirmed

`route.ts` trims `q` (line 112) and returns 400 when `q.length > 100` (line 161), before `cacheKey` (line 201). The key is built only in `cacheKey` (`lib/youtube-search.ts`, server-side), called only from the route. `foldKeyTokens` is a single pass over code points with constant work per character (one single-character regex test, neighbour lookups, no backtracking). At the cap, worst of 1000 runs: 0.5 ms per key (100 astral characters), 0.4 ms (100 `|`), under 0.1 ms otherwise. Without the cap, plain letters stay flat at about 50 ns per character up to 400k characters; operator-dense input (`-a `, `-"`) rises to 400-600 ns per character at 400k from allocating one token per few characters, not from the algorithm. No ReDoS.

## CI

boraoke has no `verify-green-local.sh`. Only targeted suites were run (machine load). The full CI-green stand-in named in the review report (`ci.yml` steps run locally) is for the TM to record before merge.

## Verdict

PASS-WITH-NOTES. Finding 1 resolved by probe. One new LOW (A) for a follow-up ticket; no BLOCKER/HIGH.
