# TICKET-135 + TICKET-136 — Reviewer report (D-022 opus pass, round 3, delta)

- PR: #97, branch `ticket/135-cache-key`, reviewed head `d650a17` (== `origin/ticket/135-cache-key`), delta `6f674b2..d650a17`: `lib/search-prefix.ts`, `__tests__/search-cache-key-fold.test.ts`, the dev report and the event log. Base `28beeb2` == current `origin/main`.
- All runs, mutants and probes in a `git archive` copy of each head outside the worktree; the worktree stayed clean.
- triggered mutation pass: triggered (rewritten normalisation on a cache-identity path), table below.

## Verdict: APPROVE (code), merge conditional on two TM bookkeeping items

Both blocking items from round 2 are closed and verified. The rewrite keeps every plain key I could find, is linear, and the key is still server-only.

## Round 2 items

1. **Closed.** `foldSearchKey` returns the tokens in typed order when any of `|`, `"`, `-"`, `+`, `#` is present. All six of my round-2 merging forms now get distinct keys (test groups `phrase`, `orGroup`, `orLead`), and the doc says what the code does. Mutants M1 (skip removed) and M2 (skip only on `"`) are KILLED.
2. **Closed.** The `-` is now an operator when the character on its left is not a word character, so tab, newline, no-break space, zero-width space, `(`, `,`, `.` all keep the exclusion. M6 (left boundary is a space only, the analogue of my R10 on the new code) is KILLED, 9 failed. The round-2 non-blocking lookalikes (`−`, `–`, `—`, `－`, curly quotes, `｜`, `+`, `#`, `(-`, `,-`, `.-`) are all covered too.

## Plain queries (re-run, not taken from the dev report)

- `npm run measure:t135` on `6f674b2` and on `d650a17`: `diff` empty, 52 strings, 50 keys, the same 2 merges (`mana`/`maná`, `cerol na mao/mão karaoke`). That output only lists merges, so I also compared `foldSearchKey` old vs new per string: **0 of 52 production strings changed**.
- 200,000 random strings (letters, accents, `karaoke`/`KARAOKÊ`, digits, `!?.,'&/():;*~^@$%_=<>[]{}`, tab, NBSP, ZWSP, Cyrillic, CJK, no dash/quote/bar/sign): **0 differ** old vs new.
- Hand list, unchanged keys: `Jay-Z karaoke`, `blink-182 …`, `AC/DC - Back in Black`, `Guns N' Roses sweet child o' mine`, `rock'n'roll`, `don’t stop me now` (U+2019 is not a quote marker), `Earth, Wind & Fire`, `Nossa Senhora (Ao Vivo)`, `evidências - chitãozinho e xororó`, `a-ha take on me`, `t.A.T.u. …`, `Pão de Açúcar`, `Bon Jovi — Always`, `Beyoncé - Halo`, `abba: dancing queen`, `Earth Wind -Fire`.
- **Newly split (over-split only, non-blocking):** `+` and `#` are now markers, so `C++ karaoke` → `c + + karaoke` (was `c karaoke`), `#1 crush karaoke` → `# 1 crush karaoke`, `1+1 beyonce` → `1 + 1 beyonce`. Because a marker also disables the karaoke move, `karaoke C++` and `C++ karaoke` now get different keys, as do `karaoke #1 crush` and `#1 crush karaoke`. Cost: at most one extra billed call for these rare spellings, never a wrong page. A dash glued after punctuation (`(-x`, `/-x`) now excludes where it used to be plain; again over-split only. Acceptable under the stated "when in doubt keep apart" rule.

## Firefox 67-77 fallback vs main path

- Production strings: main and fallback (stubbed `RegExp` throwing on `\p{`, `_usingNotWordCharFallback === true`) give the same `foldSearchKey` on **52/52**. Random marker-free strings: 0/200,000 differ.
- With operators they differ only on three characters: `−` (U+2212), `﹣` (U+FE63) and `｜` (U+FF5C). Each alone gives about 48% divergence on random strings; the operator alphabet without them gives 0/200,000. Cause: `NOT_WORD_CHAR_FALLBACK` does not list them, so on the fallback they are word characters and get glued into a word. **This cannot reach a key**: `cacheKey`'s only caller is `app/api/search/route.ts:201` (Node, primary class), and the client only uses `foldTokens` (unchanged). Optional: add those three to the fallback class so the dev report's "same rule on both paths" sentence is literally true.

## Long input

`foldKeyTokens` is one pass over `Array.from` code points; each step is an O(1) single-character regex test (with `lastIndex` reset), string append, or `out[out.length-1]` read; `foldSearchKey` adds one `some` and one `filter`. Timings at load ~240: 100k chars 5-431 ms, 1M chars 0.3-2.3 s across `a`, `-`, `|`, `" `, `-a `, `a-`, `é`, about 5-10x for 10x input, so linear. The route rejects `q.length > 100` (`MAX_QUERY`, line 161) before `cacheKey` (line 201).

## Triggered mutation pass (new code, against the 115-test fold suite)

| mutant | result |
|---|---|
| M1 marker skip removed | KILLED, 7 failed |
| M2 skip only on `"` | KILLED, 4 failed |
| M3 dash ignores left glue | KILLED, 1 failed |
| M4 no `-"` (quote after dash ignored) | KILLED, 2 failed |
| M5 `+`/`#` dropped | KILLED, 5 failed |
| M6 left boundary is space only | KILLED, 9 failed |
| M7 bar runs not collapsed | SURVIVED-equivalent: only splits `a \|\| b` from `a \| b`, never merges |
| M8 `minus` not reset in `flush` | KILLED, 2 failed |
| M9 ASCII quote only | KILLED, 3 failed |
| M10 `#` merged into `+` | KILLED, 1 failed |
| M11 bar class emptied | KILLED, 8 failed |

Reverse check, my run: new suite against `6f674b2`'s `lib/search-prefix.ts`: `Tests: 23 failed, 92 passed, 115 total`, matching the dev's figure.

## Tests

- Targeted jest on `d650a17` (`search-cache-key-fold`, `search-prefix`, `search-query`, `search-cache`, `youtube-search`, `api-search`, `api-search-budget`, `api-search-index-tier`, `api-search-personal-caps`): `Test Suites: 9 passed, 9 total`, `Tests: 5 skipped, 258 passed, 263 total`.
- Dev's full jest 1580/1669 (89 skipped), build exit 0, `check:es-target` OK, rotation-engine 59/59: claims, not re-run (load ~240, 2-job limit).

## E2E ruling: accepted, no further full run required

Full run 141/143, failures `render-and-links.spec.ts:333` (`#yt-player` count in 5 s) and `rooms.spec.ts:65` (`page.goto` 30 s), both passing on targeted re-run (20 passed; 333 failed once first). Accepted because (a) both are TV-page tests and this delta touches only `lib/search-prefix.ts` plus its unit test; (b) I walked the import graph of `app/(patron)/[room]/tv/page.tsx` (24 local files) and none of `search-prefix`, `search-query`, `youtube-search` is in it, so the change cannot reach those pages; (c) the failures are timeouts at load 260, the classic load flake. Another full run at this load would add noise, not evidence.

## `check:tv-runtime`: not needed for this PR

Verified: the only `cacheKey` call site is `app/api/search/route.ts:201`, and the TV page's import graph contains no search module (above). The patron client does bundle `search-prefix.ts` (via `SongSearch` and `search-query`), but the new module-level code is plain regex literals without the `u` flag and a `Set`, which Chromium 68 runs; and the patron page is not what `check:tv-runtime` exercises.

## Conditions before merge (TM, not Dev)

- `scripts/ticket show TICKET-135 --product boraoke` still prints `app-tester: -`; record the `app-tester-waived` row (D-081). Substance is fine: the PR's files are `app/api/search/route.ts`, `lib/*`, tests, `package.json` and `work/`, no UI surface.
- Record the CI-green stand-in. The dev named it: boraoke's own `ci.yml` steps run locally (rotation-engine `node --test`, `npm run build`, `npm test`, `npm run test:e2e`), minus `check:tv-runtime`, which is irrelevant here per the section above. The TM should adopt that in the record.
- Optional, non-blocking: Cyber Security's report predates both operator rounds; a one-line look at this rule is still worth having.

---

# Round 2 report (superseded, kept for the record)

# TICKET-135 + TICKET-136 — Reviewer report (D-022 opus pass, round 2)

- PR: #97 (draft), branch `ticket/135-cache-key`, reviewed head `99e388f` (== `origin/ticket/135-cache-key`), code at `8d20b93` plus merge `0febc5c`. Base `28beeb2` == current `origin/main`.
- Mutations and probes ran in a throwaway copy outside the worktree. The worktree stayed clean.
- triggered mutation pass: triggered (new normalisation on a cache-identity path), table below.

## Verdict: REQUEST-CHANGES

The Firefox fix works. The operator fix closes the collapse onto the plain key for the forms it names, but two things block: the `karaoke` reorder still collapses different operator forms onto each other (item 1), and one mutant on the same fix is a SURVIVED-real-gap (item 2). Both are small.

## Required

1. **Moving `karaoke` still merges operator forms that mean different things to Google.** `foldSearchKey` pulls every `karaoke` token out and appends one, including from inside a phrase or an OR group. Observed keys:

   | Queries | Shared key |
   |---|---|
   | `"evidencias karaoke"`, `"evidencias" karaoke`, `"karaoke evidencias"` | `BR::" evidencias " karaoke` |
   | `a \| karaoke b`, `a \| b karaoke` | `BR::a \| b karaoke` |
   | `karaoke \| x`, `\| x karaoke` | `BR::\| x karaoke` |

   This is the same defect the TM ruled to fix in-PR: whoever misses first pins the page for 7 days. A patron in sing mode who types `"evidencias"` sends `"evidencias" karaoke`, and can be served the page of the reversed exact phrase. It cannot reach a plain query's key, so the blast radius is patrons who type operators, but the `foldSearchKey` doc and the test name "each operator form keeps its own key" both claim otherwise. Fix: skip the move when the tokens contain `|`, `"` or `-"`. I tried that one-liner in the copy and all 104 tests in `search-cache-key-fold` + `search-query` still pass, which also shows no test pins this. Add `"x karaoke"`, `"karaoke x"` and `a | karaoke b` vs `a | b karaoke` to the pairwise-distinct test, and correct the doc if any merge is kept on purpose.

2. **SURVIVED-real-gap (severity floor): the exclusion tests only use a plain space.** Mutant R10 changes the chunker to split on a space only (`[^ |"]+`). Then `evidencias\t-karaoke` and `evidencias\u00a0-karaoke` lose the `-` and fold onto `BR::evidencias karaoke`, the exact collision being fixed, and all 104 tests stay green. The current code is correct on these inputs (both give `BR::evidencias -karaoke`). Add those two inputs to the "does not share the plain query's key" list and show that they kill R10.

## Non-blocking, for the TM

- **Possible remaining routes onto the plain key.** These all fold to `BR::evidencias karaoke`: `evidencias (-karaoke)`, `evidencias,-karaoke`, `evidencias .-karaoke`, `evidencias \u200b-karaoke`, `evidencias \u2212karaoke`, `evidencias \u2013karaoke`, `evidencias \u201ckaraoke\u201d`, `evidencias \uff5c karaoke`, `evidencias +karaoke`, `evidencias #karaoke`. Whether Google gives any of them operator meaning is **UNVERIFIED**: finding out costs live `search.list` calls, which I did not spend. Attacker impact is as in the security report: a real but off-intent page on a popular key for 7 days. Over-splitting here costs one extra call on spellings nobody types, so the cheap hardening is to keep the `-` when only non-word characters precede it in the chunk, and treat `\uff5c` and curly quotes as markers. Security's option (b), sending Google the folded text, is the only thing that closes the whole class. Not required by this review. It is worth one line from Cyber Security, whose report predates this fix (it audited `829099e`).
- **Minor test gaps** (R6, R7, R8 below). Optional, and cheap to add with item 2.

## Fix 1: Firefox 67-77 (verified)

- Reverse check, run myself: the new test file against `lib/search-prefix.ts` from `76c5391` gives `Tests: 13 failed, 74 passed, 87 total`, including all 4 tests in the Firefox group and the operator tests. This reproduces the dev's count.
- Mutant R1 (catch rethrows) is KILLED by 3 tests.
- The production bundle keeps the guard. In `.next/static/chunks/app/(patron)/[room]/page-ee151fc429650411.js`: `C=function(){try{return RegExp("[^\\p{L}\\p{M}\\p{N}]+","gu")}catch(e){return I}}()`. The minifier did not turn it into a literal, which would have been a parse error on those browsers. That is the only client chunk containing `p{L}`. `.next` dates from the dev's merged-head build (`BUILD_ID` Oct 16 04:45), and code has not changed since.
- The other `\p{}` literals are in `lib/karaoke-index/title-parser.ts`, and no client chunk carries them (grep for `Extended_Pictographic` and `\p{Lu}` over `.next/static`: no match).
- Not run on a real Firefox 67-77. The evidence is the stubbed `RegExp` plus the bundle read.

## Fallback key consistency (verified, one negligible split)

- `cacheKey` has one caller, `app/api/search/route.ts:201`, and `foldSearchKey` one, `lib/youtube-search.ts`. The fold chunker regex is in `.next/server/chunks/4662.js` and in no `.next/static` file, so the key is only ever built in Node, with the primary class. The fallback cannot produce a key.
- The one indirect route is the old client's `containsKaraoke` deciding whether to append `karaoke`. I compared server keys for primary-client vs fallback-client augmentation over the 52 production strings plus 16 extras, in both modes (136 pairs), and exhaustively for `x karaoke<cp>` over every code point (1,112,032).
- Where the fallback under-splits (emoji, symbols), the client appends a second `karaoke`, and the server fold dedupes it to the same key.
- Where it over-splits, the key differs: exactly 35 code points (`\xb2 \xb3 \xb5 \xb9 \xbc-\xbe` and CJK iteration marks and Hangzhou numerals in `\u3005-\u303c`), and only when glued directly to `karaoke`, for example `karaoke\xb2`. That is one extra cache entry on Firefox 67-77 for input nobody types. All 52 production strings match. Not worth a change. Optional: drop those from the fallback class.

## Fix 2: operators (partly verified)

- `evidencias -karaoke`, `evidencias | karaoke`, `evidencias|karaoke`, `"evidencias" karaoke`, `"evidencias karaoke"`, `evidencias -"karaoke"` all have keys distinct from the plain query, and fail on the old code (reverse check above).
- Benign variants still merge, and `measure:t135`'s committed result stands because plain queries take the same path (52 index-agreement tests pass).
- No `:` can enter the key from a marker. Letterless inputs (`???`, `-`, `- ?`) keep the fallback; `|`, `"` and `-"` get a key of their own.

## Triggered mutation pass (mine, targeting the round 2 code)

| # | Mutant | Result |
|---|---|---|
| R1 | catch rethrows, no fallback | KILLED (3) |
| R2 | fallback drops CJK punctuation | KILLED (1) |
| R3 | fallback drops General Punctuation | SURVIVED-equivalent for the key: an under-split only adds a `karaoke` the server dedupes |
| R4 | fallback drops fullwidth punctuation | SURVIVED-equivalent, same argument |
| R5 | fallback drops most of Latin-1 | SURVIVED-equivalent, same argument |
| R6 | chunker `-*"` to `-?"` | SURVIVED, minor: `--"x"` loses its exclusion mark, and Google's reading of `--"` is unknown |
| R7 | `-` on every token of the chunk | SURVIVED, minor: `-foo.bar baz` and `-foo bar baz` share a key today, and nothing pins either behaviour |
| R8 | `\|` run not collapsed | SURVIVED, minor: the doc says runs collapse, and the failure direction is an over-split, which is safe |
| R9 | no diacritic strip before chunking | SURVIVED-equivalent: `foldTokens` strips each chunk again, and stripping cannot change `\|`, `"`, `-` or whitespace |
| R10 | chunker splits on a space only | **SURVIVED-real-gap: item 2** |
| R11 | `-"` emitted as `"` | KILLED (1) |

## Merge with main (verified clean)

- No file is changed on both sides (`comm` of the two name lists is empty), and `git diff-tree --cc 0febc5c` shows no resolved hunks.
- `git diff 8d20b93 HEAD` over `lib/search-prefix.ts`, `lib/search-query.ts`, `lib/search-cache.ts`, `lib/youtube-search.ts`, `app/api/search/route.ts` and the fold test is empty.
- `git grep` finds no new caller of `cacheKey`/`foldSearchKey`/`containsKaraoke` from main. Non-`work/`, non-test files in the PR diff: the 5 above and `package.json`.
- The dev report says main touched `lib/youtube*.ts`; that is not `lib/youtube-search.ts`, per the empty diff.

## Tests and evidence

- Targeted jest, my run on the worktree (`search-cache-key-fold`, `search-query`, `search-cache`, `search-single-flight`, `search-pagination`, `youtube-search`): `Test Suites: 6 passed, 6 total` / `Tests: 197 passed, 197 total`.
- Dev's full jest (79 suites), `npm run build`, `check:es-target` and e2e 143/143 on the merged head: accepted as **claims**, not re-run (load about 24-30 and the lane limit). They need re-running after this round anyway, at least targeted jest and build, since the fold changes.
- Dev declarations on hollowing-out and the triggered pass are present. Its N6 gap was closed and verified.

## Other gates

- **App Tester waiver: not in the ticket store.** `scripts/ticket show TICKET-135 --product boraoke` prints `app-tester: -` with only `plan-approved` and `worktree-created` rows; the waiver exists only as the PR-body line "waived, no UI files changed". The diff touches no UI file, so a waiver is valid in substance, but D-081 wants the `app-tester-waived` row before the final APPROVE.
- **CI-green stand-in:** boraoke has no `verify-green-local.sh`, and my round 1 asked the TM to name the stand-in. Still to be recorded.

## Re-review checklist

- Item 1 fixed and tested, doc corrected.
- Item 2 tests added, shown to kill R10.
- `app-tester-waived` row recorded, CI-green stand-in named.

---

# Round 1 report (superseded, kept for the record)

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
2. **Gates before any final APPROVE.** Cyber Security PASS-WITH-NOTES landed during this review (`1b8f1c3`, `work/reports/security/TICKET-135-security.md`, docs-only, no code change since `829099e`); its MEDIUM (first-miss page pinning, now 7 d) is for the TM to ticket. Still missing: a recorded App Tester waiver (the diff touches no UI file: `lib/`, `app/api/`, tests, `work/`, `package.json` script, so a waiver is plausible), full e2e and `next build` (incl. `check:es-target`) owed. boraoke has no `verify-green-local.sh`, so the TM must name what stands in for "CI green" here. The re-review needs these.

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
- App Tester waiver recorded, e2e + `next build` + `check:es-target` green, TM's CI-green stand-in named.
