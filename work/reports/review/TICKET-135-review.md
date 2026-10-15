# TICKET-135 + TICKET-136 — Reviewer report (D-022 opus pass)

- PR: #97 (draft), branch `ticket/135-cache-key`, reviewed head `829099e` (== `origin/ticket/135-cache-key`; code head `c476597`).
- Diff read locally: `git diff $(git merge-base origin/main HEAD)..origin/ticket/135-cache-key`.
- Read: both tickets, `work/plans/SCOPE-search-cache-pagination.md` (main checkout) sections 1, 3, 4, `TICKET-141` (30-day API-data rule, III.E.4.d/e, no video-ID exemption), `work/plans/TICKET-135-plan.md`, `work/reports/dev/TICKET-135-dev-report.md`, `work/measurements/ticket-135/RESULTS.txt`, the PR body and thread, `scripts/check-bundle-es-target.mjs`, `package.json` browserslist, `components/tv/watchdog.ts`.

## Verdict: REQUEST-CHANGES

One code item (1) and the missing gates (2). The design is right and the tests are strong; the code item is small.

## Required

1. **`\p{...}` regex breaks a declared browser target at module load.** `lib/search-prefix.ts` builds `NOT_WORD_CHAR = new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu")` at the top level. That module is imported by the patron client (`components/SongSearch.tsx` imports `planSearch` from it, and `augmentQuery` → `containsKaraoke` → `foldTokens`). Unicode property escapes: Chrome 64, Safari 11.1, Edge 79 (Chromium), Opera mirrors Chrome, **Firefox 78** (MDN browser-compat-data, `javascript/regular_expressions.json`, `unicode_character_class_escape`). The browserslist declares `firefox >= 67`. On Firefox 67-77 the constructor throws `SyntaxError` while the module evaluates, so the patron search UI fails to load at all, not just the fold. The bundle-es-target gate cannot catch this: it is a runtime constructor, not syntax, which is exactly why the comment's claim ("every browser and Node version boraoke runs on supports them") needs to be true and is not. Fix, either one:
   - guard it: build the regex inside a `try` and fall back to a non-property class (for example `/[^0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ一-鿿가-힯̀-ͯ]+/g`, or simply the `normalizeQuery` alphabet on the client, since only `containsKaraoke` runs there and it only needs to find the Latin token `karaoke`), and correct the comment; or
   - raise the browserslist floor to `firefox >= 78`, which is a product decision (the script header says so) and should be stated in the PR.
   A one-line unit test that stubs `RegExp` to throw on `\p` and still gets `containsKaraoke("evidencias karaoke") === true` would pin the guard.
   - **TV (Chrome 68): fine.** Chrome 64+ supports property escapes, so the TV surface is not affected, and `String.prototype.normalize` is Chrome 34+.
2. **Gates before any final APPROVE.** No Cyber Security report, no recorded App Tester waiver (the diff touches no UI file: `lib/`, `app/api/`, tests, `work/`, `package.json` script, so a waiver is plausible), full e2e and `next build` (incl. `check:es-target`) owed. boraoke has no `verify-green-local.sh`, so the TM must name what stands in for "CI green" here. The re-review needs these.

## Conditions (TM decision, not a code change)

- **Acceptance "graded accent queries keep their hit@10 in the 125 harness" was not run** (oracle and fixture are gitignored and absent). The dev's argument holds: both merged pairs share a graded `want`, all four were hits@10 in the shipped 125 run, and both pairs already share one 125 trace where the client serves the first member's page to the second. The TM should record that this criterion is met by argument, or regenerate the oracle. I accept the argument.

## Judgement on the questions asked

- **Fold correctness: correct.** lowercase, NFD + strip U+0300–036F, every non-L/M/N char to a space, split, drop empties, all `karaoke` tokens removed and one appended. NFC/NFD agree. For Latin input it equals `normalizeQuery` with karaoke moved (asserted over all 52 production strings, plus a pairwise "same fold implies same index form" check). Region stays in the key; digits kept; sing vs listen stays distinct.
- **All scripts kept vs `[a-z0-9]`: right call.** With `[a-z0-9]` every CJK/Cyrillic/Hangul sing query becomes `BR::karaoke` and every one shares one answer; that would be a real cross-query poisoning bug. Note (optional, low): `stripDiacritics` still applies to non-Latin text, so `й`→`и` (`мой`/`мои` merge) and `ё`→`е`, and Vietnamese tones fold (`má`/`mà`/`ma`). Probed directly. Same class as the accepted Latin accent folding and irrelevant to today's BR traffic; worth a line in the comment, not a change.
- **`karaokê` in `containsKaraoke`: correct.** It now counts (tests with NFC, NFD, caps, punctuation-adjacent). It also makes the index tier treat `karaokê` as sing mode, which is the intent. Side effect: `karaoke_star` is now a match (old `\b` regex said no, `_` is a word char there). Harmless.
- **Page-marker/cursor separation: sound.** `P:<token>::` sits outside the fold, the token is never folded (case-distinct cursors stay distinct, tested), and the folded part can no longer contain `:` at all, so the forgery argument is stronger than before. The letterless fallback is lowercased and has no letters, so it cannot carry `P`. Nit: the comment says a fold result "always contains a letter or digit"; a mark-only input (e.g. U+3099) folds to a non-empty mark-only key. No collision results (the fallback only applies when the fold is empty), so it is a wording nit only.
- **Single-flight keys: correct.** `acquireSearchFlight(ck)` / `waitForSearchFlight(ck)` take the folded `ck`; the fixed `sf:lock:` / `sf:err:` prefixes keep the TICKET-126 namespace argument. The variant probe (4 spellings, many instances) shows 1 billed call and that Google receives one patron's original text.
- **Quality risk: acceptable.** Only 2 of 52 production strings merge, both pairs are the same song to the grader and already shared within one patron's typing. The first variant's page is served for 7 days; that is the price of the saving, bounded and stated.
- **TTL guards: nothing outlives 30 days.** Redis non-empty 7 d and empty 10 min, both written with `px` on every `set` (`lib/search-cache.ts:207`), and a hit only re-warms the 60 s L1 (never re-sets Redis), so max life is 7 d + 60 s. The guard asserts each TTL and the sum against `INDEX_MAX_AGE_MS` (30 d). Single-flight lock/err keys hold no API data. Fine.
- **Stale cached pages: acceptable, documented.** Search picks skip the embed check; the TV watchdog's fatal set is `{2, 5, 100, 101, 150}` (`components/tv/watchdog.ts:32`), confirmed by reading. An expired cursor fails soft and is not cached (tested). One extra wrinkle the header half-states: a cursor from `maná`'s page 1 is now replayed against Google with `q=mana`. YouTube tokens behave like offsets, so this most likely returns `mana`'s page 2, which can duplicate or skip rows relative to page 1; the client dedupes. Low impact, no change needed.

## Tests

- Targeted jest, my run (6 suites: key-fold, query, cache, single-flight, pagination, youtube-search): `Test Suites: 6 passed, 6 total` / `Tests: 183 passed, 183 total`.
- Dev evidence: reverse check against pre-fix code `67 failed, 65 passed`; 22/22 mutants killed; declarations on hollowing-out and the triggered pass are present.
- **Triggered mutation pass: triggered** (new normalisation on an identity path). My own mutants, each restored after (`cmp` clean, `git status` clean):

| # | Mutant | Result |
|---|---|---|
| R1 | `NOT_WORD_CHAR` without `g` flag | KILLED (1, Cerol group) |
| R2 | `karaoke` moved to the front, not the end | KILLED (4+) |
| R3 | `containsKaraoke` as token prefix match | KILLED (2) |
| R4 | fold uses NFC and no diacritic strip | KILLED (4+) |
| R5 | L1 TTL raised to 30 d | KILLED (1, retention guard sum) |
| R6 | letterless fallback replaced by a constant | KILLED (1) |
| R7 | page token folded into the query part | KILLED (1) |
| R8 | single-flight lock keyed on `ck + raw q` | KILLED (4, single-flight suite) |

## PR body accuracy

Accurate, with two points: the footprint is stated as 5-8 MB (ticket said 5-6; the higher bound is better measured, fine), and the Gates list correctly shows e2e, build, Security and the App Tester decision as open. The code comment on browser support (item 1) is the one inaccurate claim.

## Re-review checklist

- Item 1 fixed (guard + test, or browserslist raised with the product call stated), comment corrected.
- Security PASS, App Tester waiver recorded, e2e + `next build` + `check:es-target` green, TM's CI-green stand-in named.
