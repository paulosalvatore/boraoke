# TICKET-108 — Dev report: stop billing a `search.list` call per keystroke

**Status:** IMPLEMENTED. Gates run (results below). Quality holds against the guardrail, so per the ticket's own rule this ships.
**Branch:** `ticket/108-keystroke-billing` · **Worktree:** `.worktrees/t108-keystroke-billing`
**Role:** Dev (boraoke) · **Date:** 2026-09-27

Every number below is labelled **[MEASURED]** (produced by a command in this session, with the command named), **[DERIVED]** (arithmetic over measured inputs, arithmetic shown), or **[VERIFIED]** (quoted from a primary artefact). Nothing here is asserted from reasoning.

---

## The short version

1. **The fix works and quality holds.** Billed `search.list` calls over the real production corpus drop **80 → 48, i.e. 3.75 → 2.25 calls per queued song (−40%)**, with hit@10 **unchanged at 22/28 (79%)** and an **identical miss set**. **[MEASURED]**
2. **The ticket's naive framing would have been a false win, and it is now measured rather than feared.** "An extension never refetches" bills only 32 calls (−60%) — and drops hit@10 from **22/28 (79%) to 10/28 (36%)**. It is control C1 in the harness. Without the starvation guard this ticket would have shipped a quota graph that looked excellent and a search that had quietly got much worse. **[MEASURED]**
3. **The honest headline the ticket's framing did not anticipate: the safe fix is ~1.7x, not 4x.** The spike projected "~4x headroom" from removing keystroke spend. That 4x is real but it is *only* reachable by accepting the quality loss in (2). With quality held, 40% is what is available from this change. **This is not a reason to hold the PR** — 40% is material and free — but it does mean the as-you-type-vs-on-submit feel decision the ticket deliberately reserved for the Tech Lead is still on the table for the remaining gap. Written up at the end, not decided here.
4. **Measured at zero quota cost.** The whole before/after comparison spent **0** `search.list` calls, because the oracle is the production search cache itself — 80 real production queries and 3,919 real YouTube rows, read read-only. **[MEASURED]**
5. **Two extra savings the measurement found that nobody had noticed:** production billed *two separate calls* for `mana` vs `maná`, and two more for `cerol na mao` vs `cerol na mão`. They fold to one query. And a 3-character query was measured to be worth nothing at all (production's real page for `esc` contains no "Escurinho do Cinema" anywhere in its 50 rows), so `MIN_CHARS` is 3 → 4. **[MEASURED]**
6. **8/8 mutants killed; the reverse-check fails 8 unit tests and 2 e2e tests against the pre-fix implementation.** Verbatim output below.
7. **One real bug found in self-review, not by a gate:** a local narrowing did not supersede a search already in flight, so an older fetch could land and replace the narrowed rows with a page for a query the patron had already moved past — no spinner, and nothing left to re-narrow it. Fixed, tested, and the test is proven able to fail.

---

## 1. How this was measured, and why the instrument is trustworthy

### The oracle: production's own search cache, read-only, zero calls spent

The question "does a short prefix's top-50 contain the song a longer query returns?" is a fact about YouTube, not about our code, so it cannot be answered with a hand-written fixture. Two ways to get real data:

- live-search all 32 graded queries plus every prefix the policy fetches — **~50–60 `search.list` calls**, i.e. over half the platform's 90-call daily patron budget, spent to measure a fix for the platform's 90-call daily budget; or
- read the pages production *already* served for exactly these queries, which cost nothing.

The second was used. The TICKET-106 spike found that the production cache contains the complete keystroke ladders, and they were still live: **80 `sc:` keys, 3,919 result rows** on 2026-09-27. **[MEASURED]**

Credential handling (`handle-secret`): production env was pulled with `vercel env pull` into the **session scratchpad outside the repo**, only the **`KV_REST_API_READ_ONLY_TOKEN`** was used, and the file was **shredded immediately** after the dump (verified: `SHREDDED`). No secret value appears in this report, in the repo, or in any committed artefact. **No write of any kind was issued to production**, and the `search.list` budget counter was read, never incremented. boraoke has no Credential Vault entry yet (TICKET-107).

Positive controls for the probe, so a dead probe could not be mistaken for an empty store (`proof-by-absence`): **[MEASURED]**

```
CONTROL ping -> PONG
CONTROL dbsize -> 157
CONTROL total keys scanned: 157 namespaces: {"feedback":4,"identity":24,"room":28,"rooms":1,"sb":1,"sc":80,"telemetry":19}
sb:2026-09-26 = 90
sb:2026-09-27 = null
```

`sb:2026-09-26 = 90` independently re-confirms the exhausted day the ticket is about, and the dump script aborts non-zero if zero `sc:` keys come back. The fixture is committed at `work/measurements/ticket-108/production-search-results.json` (public YouTube titles/ids/channels only — no patron identity, no telemetry, nothing sensitive), so the measurement is reproducible from the repo forever, without credentials.

### The traces are measured, not synthesised

A "type the title one character at a time" trace would be a guess about where patrons pause. It is not needed: **a cache key exists if and only if that exact string was debounced and billed in production.** Grouping the 80 keys into prefix chains recovers the real debounce sequences, so the BEFORE arm is not modelled at all — it is 1 billed call per key, which is what actually happened. 32 keystroke families were recovered, the worst being the one the ticket names: **[MEASURED]**

```
12 billed calls today:  esc → escu → escur → escuri → escurinh → escurinho → escurinho d →
                        escurinho do → escurinho do c → escurinho do ci → escurinho do cin →
                        escurinho do cinema
 5 billed calls today:  bor → borb → borbu → borbulhas → borbulhas de
 5 billed calls today:  zé r → zé ra → zé ram → zé rama → zé ramalho
```

### One measurement bug worth recording, because its wrong answer looked plausible

The first run of the harness reported **−13%** and I nearly wrote it up. Cache keys are the *augmented* query (sing mode appends the keyword), so `escu karaoke` does **not** textually extend `esc karaoke` — the suffix sits on the end of both, and the patron's ladder is invisible in cache-key space. The harness now works in raw-input space, which is also what the product does (`planSearch` sees the raw input; augmentation happens only on the way out to the network). The corrected figure is −40%. A plausible-looking number is not a correct one; this one was three times too small.

---

## 2. Result 1 of 2 — billed `search.list` calls

`npm run measure:t108` (full output committed at `work/measurements/ticket-108/RESULTS.txt`). **[MEASURED]**

```
BEFORE (today: one call per debounce)       80 calls   = 3.75 per queued song (measured: 90 calls / 24 songs)
AFTER  minChars=3 minLocalMatches=1         50 calls   = 2.34 per queued song   (−38%)
AFTER  minChars=3 minLocalMatches=3         57 calls   = 2.67 per queued song   (−29%)
AFTER  minChars=4 minLocalMatches=1         43 calls   = 2.02 per queued song   (−46%)
AFTER  minChars=4 minLocalMatches=3         48 calls   = 2.25 per queued song   (−40%)   ← SHIPPED
AFTER  minChars=5 minLocalMatches=3         40 calls   = 1.88 per queued song   (−50%)   ← rejected, quality degrades
```

Arithmetic for the per-song figure, shown: baseline is the measured `90 / 24 = 3.75` **[MEASURED]**; the after figure is `3.75 × (48 / 80) = 2.25` **[DERIVED]**, i.e. the baseline scaled by the call ratio the replay produced over the same corpus.

**Why the floor is 48 and not ~24.** Of the shipped variant's 48 calls, **32 are `no-held-results`** — the unavoidable first call of each of the 32 families — and **16 are `local-matches-starved`**, the guardrail deciding the held page genuinely cannot answer the longer query. There are no other reasons; `not-an-extension` never fires on a monotonically-typed ladder, which is itself a sanity check on the extension logic. Squeezing the 16 out means showing patrons pages that do not contain their song; that is control C1.

---

## 3. Result 2 of 2 — result QUALITY, the guardrail that decides whether this ships

Same 32 graded production queries as the TICKET-106 spike, byte-identical `q`/`want` data (`work/measurements/ticket-108/queries.ts` is the spike's file with only the module syntax adapted), same `hit()` predicate. **[MEASURED]**

```
BEFORE  full-string search (today)         n=28  hit@1 18 ( 64%)  hit@5 20 ( 71%)  hit@10 22 ( 79%)
AFTER   minChars=4 minLocalMatches=3       n=28  hit@1 19 ( 68%)  hit@5 21 ( 75%)  hit@10 22 ( 79%)  = holds
```

By query shape, and the miss sets: **[MEASURED]**

```
partial   hit@10  before 8/12   after 8/12
typo      hit@10  before 2/4    after 2/4
accent    hit@10  before 5/5    after 5/5
complete  hit@10  before 7/7    after 7/7

before misses: escu karaoke | escurinho do cin karaoke | borb karaoke | banderille karaoke | soda stete karaoke | banderilleros karaoke
after  misses: escu karaoke | escurinho do cin karaoke | borb karaoke | banderille karaoke | soda stete karaoke | banderilleros karaoke
```

**Not one bucket moves and the miss set is identical, query for query.** hit@1 is one better (narrowing promotes a matching row out of the tail into view), which is not claimed as a win — on n=28 it is one query.

**4 of the 32 graded queries are EXCLUDED, by name, not silently counted as misses:** `boquinha da g karaoke`, `olha a onfs karaoke`, `boquinha da garrafa karaoke`, `na boca da garrafa karaoke`. Those families' keys have expired from the cache since the spike ran, so there is no production page to grade either arm against. Both arms are graded on the same n=28, so the comparison is sound; the honest caveat is that it is 28, not 32.

**n is small and the corpus is one evening.** 28 graded queries from one product's sparse traffic. What makes it usable is that it is the *same* corpus the decision was originally reasoned about, both arms are graded identically, and the quality arm is proven able to detect degradation (C1 below). It would not support a claim like "this improves search"; it does support "this does not degrade search".

### Verdict against the ticket's rule

> **If quality holds, ship it. If quality measurably degrades, stop and report up.**

Quality holds — identical hit@10, identical misses, no bucket regression. **Shipping.**

---

## 4. Prove-the-measurement-can-fail controls

A quality harness that scores the same however badly the policy behaves is measuring nothing. `npm run measure:t108 -- --controls`, verbatim: **[MEASURED]**

```
C1  naive "extension ⇒ never refetch" (minLocalMatches=0, starvation guard REMOVED)
      billed 32 (baseline 80)   n=28  hit@1  9 ( 32%)  hit@5 10 ( 36%)  hit@10 10 ( 36%)
      → hit@10 10 vs baseline 22: DROPS, as it must — the quality arm does detect degradation, so the "holds" verdicts above mean something

C2  empty oracle (must be 0%)
      n=28  hit@1  0 (  0%)  hit@5  0 (  0%)  hit@10  0 (  0%)
      → 0 hits, as required — hit() is not vacuously true

C3  no local narrowing at all (held page shown verbatim)
      billed 57   n=28  hit@1 16 ( 57%)  hit@5 20 ( 71%)  hit@10 22 ( 79%)
      → does not beat the baseline, as expected

C4  diacritic folding is load-bearing (an accent added after the fact must not bill)
      "evide" → "evidências":  planSearch = filter (39 rows, 0 calls)   raw unfolded startsWith = false
      "mana" → "maná":  planSearch = filter (50 rows, 0 calls)   raw unfolded startsWith = false
      "cerol na mao" → "cerol na mão":  planSearch = filter (50 rows, 0 calls)   raw unfolded startsWith = false

C5  token-PREFIX matching is load-bearing (mid-word typing)
      page("escurinho") narrowed by "escurinho do cin":  prefix-match 1 rows   whole-word-equality 0 rows
      ...
      → prefix matching keeps rows that word-equality would starve on — the rule earns its keep
```

**C1 is the one that matters.** It is simultaneously (a) the proof the quality arm is not blind, and (b) the measured answer to the ticket's proposed approach. `hit@10 22 → 10` is the false win, caught by the instrument that existed to catch it.

---

## 5. `prove-your-test-can-fail` compliance

### (a) Mutation-proof — which mutation kills each new assertion

Eight mutations applied one at a time to `lib/search-prefix.ts`, unit suite re-run after each, baseline restored and re-verified green. **8/8 KILLED, 0 SURVIVED.** **[MEASURED]**

```
M1 prefix-match → whole-word equality (filterResults)
    KILLED   Tests:       2 failed, 20 passed, 22 total
      ✕ prefix-matches a half-typed trailing word
      ✕ collapses the ladder from 11 billed calls to 6
M2 allow an EQUAL query through isExtensionOf
    KILLED   Tests:       1 failed, 21 passed, 22 total
      ✕ rejects an equal query, a backspace, and an unrelated query
M3 drop diacritic folding in isExtensionOf
    KILLED   Tests:       1 failed, 21 passed, 22 total
      ✕ is diacritic-insensitive, so adding an accent does not read as a new query
M4 remove the starvation guard (MIN_LOCAL_MATCHES 3 → 0)
    KILLED   Tests:       4 failed, 18 passed, 22 total
      ✕ REFETCHES rather than showing a starved list — the quality guardrail
      ✕ honours the MIN_LOCAL_MATCHES boundary exactly
      ✕ collapses the ladder from 11 billed calls to 6
      ✕ still finds the song the patron was typing — the billing win is not paid for in quality
M5 require ANY token instead of EVERY token
    KILLED   Tests:       4 failed, 18 passed, 22 total
M6 stop ignoring non-discriminating tokens
    KILLED   Tests:       3 failed, 19 passed, 22 total
M7 remove the re-spelling (normalized-equal) branch
    KILLED   Tests:       1 failed, 21 passed, 22 total
M8 starvation boundary < → <=
    KILLED   Tests:       2 failed, 20 passed, 22 total

restored baseline
Tests:       22 passed, 22 total
```

M4 is the important one: **removing the quality guardrail breaks four tests, including the one that asserts the patron still finds their song.** The guard is not decoration.

The e2e guardrail test was mutation-proofed the same way, because it passes against the pre-fix code (pre-fix always refetched, so "two calls, second is the long query" holds there too) and would otherwise be a test with no failure mode. Under `MIN_LOCAL_MATCHES = 0`: **[MEASURED]**

```
1) [chromium] › e2e/search.spec.ts:561:5 › a prefix whose page cannot answer the longer query DOES refetch (TICKET-108 guardrail)
    Error: expect(received).toHaveLength(expected)
    Expected length: 2
    Received length: 1
    Received array:  ["escu karaoke"]
  1 failed
```

### (b) Reverse-check — the new tests FAIL against the pre-fix implementation

Pre-fix behaviour is exactly "every input change bills a call", so `planSearch` was replaced by an unconditional `fetch`.

Unit suite — **8 of 22 fail**: **[MEASURED]**

```
===== REVERSE-CHECK: new suite vs PRE-FIX behaviour (always fetch) =====
    ✕ fetches for an unrelated query and for a backspace (3 ms)
    ✕ NARROWS an extension locally — no call — when enough rows survive (2 ms)
    ✕ REFETCHES rather than showing a starved list — the quality guardrail
    ✕ treats a re-spelling as the same query and hands back the held rows untouched
    ✕ honours the MIN_LOCAL_MATCHES boundary exactly
    ✕ collapses the ladder from 11 billed calls to 6 (1 ms)
    ✕ spends its calls on starvation, not on blind re-querying (1 ms)
    ✕ charges nothing at all for a ladder whose first page already answers it
Test Suites: 1 failed, 1 total
Tests:       8 failed, 14 passed, 22 total
--- restored ---
Test Suites: 1 passed, 1 total
Tests:       22 passed, 22 total
```

e2e — **2 of the (then) 3 new tests fail**: **[MEASURED]**

```
===== E2E REVERSE-CHECK vs PRE-FIX (always fetch) =====
  2) [chromium] › e2e/search.spec.ts:593:5 › load more pages against the HELD query while narrowing locally (TICKET-108)
    Error: expect(received).toHaveLength(expected)
    Expected length: 1
    Received length: 2
    Received array:  [{"pageToken": null, "q": "escu karaoke"}, {"pageToken": null, "q": "escurinho karaoke"}]
  2 failed
    [chromium] › e2e/search.spec.ts:540:5 › typing a title in chunks bills ONE search, not one per pause (TICKET-108)
    [chromium] › e2e/search.spec.ts:593:5 › load more pages against the HELD query while narrowing locally (TICKET-108)
  1 passed (18.4s)
```

The third (the guardrail test) passes against pre-fix *by design* — its failure mode is an over-aggressive filter, not the pre-fix code — and is mutation-proofed above instead. Noting it explicitly rather than letting "1 passed" look like a hole.

**On the trap the ticket warned about:** the e2e tests type in **chunks with 700ms pauses**, longer than `DEBOUNCE_MS = 400`. A Playwright `fill()` (or a fast `pressSequentially`) collapses into a single call on the pre-fix code too, so a "fewer calls" assertion written that way passes against the bug and proves nothing. That is precisely why the reverse-check above is the evidence, not the green run.

### (c) Hollowing-out declaration — REQUIRED, and it fired

**A primitive beneath existing assertions DID change.** Three existing behaviours were re-examined for vacuity:

1. **`queryDirty`, re-keyed from `resultsQuery` to `filterQuery`.** Under local narrowing `input !== resultsQuery` is now the *normal* state, so the old comparison would have withdrawn "load more" for the whole time a patron types deeper into a held page. The existing test `load more withdraws once the query is edited (no stale-cursor search)` still passes — but I checked whether it is now vacuous, and it is **not**: it drives an *unrelated* query (`evidencias` → `outra musica`), which still takes the fetch path, so its assertion `deep[0].q === "outra musica karaoke"` remains a real claim. It does, however, **no longer cover the new risk**, so I added `load more pages against the HELD query while narrowing locally`, which fails against pre-fix (above).
2. **`certainlyExhausted`, changed from `results.length` to `heldRows.length`.** Judged on the narrowed view it would have been wrong (a 3-row narrowed list says nothing about whether Google had more). The existing test `a cursor-less short page does not claim the results are exhausted` fetches 8 rows with no narrowing, so `heldRows.length === results.length === 8` and the assertion is unchanged in meaning — and still live: it asserts the *absence* of the "tudo que a gente achou" copy, which the guard is what produces.
3. **`results` itself changed meaning** (displayed rows, no longer necessarily the whole fetched page). The pagination test `load more pages through results, revealing fetched rows for free` never narrows, so `results` is still the full page there and its reveal-then-fetch tiering is unaffected. Verified by it passing, and by the new test covering the narrowing case it does not reach.

### (d) Triggered mutation pass declaration — REQUIRED

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`

The new `normalizeQuery` / `filterResults` are normalisation over user input, but the path is search relevance, not money, quantity, or identity. **I ran the pass anyway** — it decides platform quota spend, which is cheap to get wrong and expensive to discover — and the mutant table is in (a): 8/8 KILLED, 0 SURVIVED, therefore **no SURVIVED-real-gap**.

---

## 6. Constraints the ticket named — each one checked

| Constraint | Status |
|---|---|
| TICKET-83: a mode flip can never re-trigger a debounce, a fetch, or a quota charge (comment at L120-123) | **HELD.** The held page is read through `heldRef`, the same ref pattern and for the same reason, so landing a fetch does not change the search effect's deps. The effect is still keyed on `[input, runSearch]`, and `runSearch` still closes over `modeRef`. The existing e2e `changing the mode fires NO search (TICKET-83 §1)` passes. |
| A pasted YouTube URL/ID resolves locally with no API call | **HELD.** The paste branch calls `clearHeld()` and never becomes a held pool; existing AC2 e2e coverage passes. |
| The 12h cache (`lib/search-cache.ts`) and TICKET-87's fail-closed daily cap (`lib/search-budget.ts`) both stay | **UNTOUCHED.** Neither file is in the diff. This reduces demand; it replaces neither bound. |
| Decision logic in a pure helper, unit-testable directly (jest is node-env) | **DONE.** `lib/search-prefix.ts` has no React and no `server-only`; the suite drives it directly. |
| Do not build the deferred options (harvested index, `youtubei.js`, Piped/Invidious) | **NONE BUILT.** No dependency added; `package.json` gains only a `measure:t108` script. |

---

## 7. Gates

| Gate | Result |
|---|---|
| `npm test` (945 tests) | **GREEN** — `Test Suites: 53 passed, 53 total` / `Tests: 5 skipped, 940 passed, 945 total` **[MEASURED]** |
| `npm run test:e2e` | **GREEN** — `110 passed (9.0m)`, exit 0, on a clean run of the FULL suite (`PORT=3066`) **[MEASURED]** |
| `npm run build` → ES2019 bundle check | **GREEN** — `bundle-es-target: OK — all 47 chunk(s) parse at ES2019.` **[MEASURED]** |
| `npm run build` → `check-css-target.mjs` | **GREEN** — `css-target: OK — the TV surface uses nothing newer than Chrome 68 (13 stylesheet(s) scanned).` The 15 advisory findings outside the TV surface are pre-existing and explicitly not build-blocking. **[MEASURED]** |

`e2e/search.spec.ts` alone: **16 passed** — the 12 pre-existing tests plus the 4 new ones. **[MEASURED]**

**An earlier full run was not green, and it was my own fault — recording it rather than deleting it.** A first full run (`PORT=3062`) reported 107 passed / 2 failed (`render-and-links › legacy /admin and /tv redirect`, `served-lang › the venue TV serves the ROOM's language`), both of which passed when re-run in isolation. A second full run I started in the background then reported **seven** failures, almost all `/tv` — and its log carries `⨯ [TypeError: Cannot read properties of undefined (reading '/_app')]`, the signature of **two `next dev` servers sharing one `.next` build directory**. I had started a second spec run on another port while that full run was in flight. Different ports do not give you a different build cache.

So: that second run is **void, not a finding**, and the first run's two failures are confounded by the same class. The authoritative result is the run above — `rm -rf .next`, one dev server, nothing else running, **110/110, exit 0**. Lesson worth carrying: in a shared-checkout worktree, an extra `PORT=` does not isolate a Next dev server; the build cache is the shared resource.

## 8. Implementation log

| Commit | What |
|---|---|
| (see PR) | `lib/search-prefix.ts` — the pure planner |
| (see PR) | `components/SongSearch.tsx` — held pool vs displayed rows, `MIN_CHARS` 3 → 4, narrowing applied with no debounce |
| (see PR) | `__tests__/search-prefix.test.ts` — 22 unit tests incl. the real-ladder replay |
| (see PR) | `e2e/search.spec.ts` — 3 call-count tests |
| (see PR) | `work/measurements/ticket-108/` — oracle fixture, graded query set, replay harness, captured results |

Key design points, all of which exist for a measured reason:

- **A freshly-fetched page is NEVER filtered by its own query.** YouTube legitimately returns rows whose titles do not contain the query — production: "escurinho do cinema" surfaces Rita Lee's "Flagra", a lyric match the spike recorded. Self-filtering would throw those away. Narrowing applies only to a strict extension.
- **The `filter` path has no debounce.** A debounce exists to amortise a network call; there is no call to amortise, so narrowing is immediate and the list reacts as the patron types. This is a UX improvement that falls out of the fix.
- **A backspace refetches.** Held rows are Google's answer to the *longer* string, so they are not a superset of what the shorter one would return; filtering them would quietly serve a narrower list than the patron asked for. Production traces are overwhelmingly monotonic, so the cost is negligible.
- **A local narrowing bumps `seqRef`, so it SUPERSEDES a search still in flight.** Found in self-review, not by a gate, and it is a real staleness bug: backspacing starts a fetch for the shorter query, and if the patron then types forward again the held page answers them instantly — but the older fetch is still coming, and `runSearch` would have applied it on arrival. The patron would be left looking at a page for a query they had already moved past, with no spinner and nothing left to re-narrow it (the effect only runs on input change). `runSearch` already discards a superseded response; the narrowing just has to declare itself newer. Covered by a new e2e test with a deliberately slow mock, and **proven able to fail**: with the one-line bump removed, `expect(...Borbu Stale Page...).toHaveCount(0)` fails with `locator resolved to 8 elements`. **[MEASURED]**
- **`load more` appends to the held pool, then re-applies the narrowing**, and pages against the HELD query — the cursor belongs to that query, and pairing it with a narrowed string would be a guaranteed cache miss, i.e. a daily call spent on junk (the TICKET-83 reviewer's finding 2, preserved under the new semantics).

---

## 9. The one thing that genuinely wants the Tech Lead's attention (not a blocker for this PR)

The spike's framing — "stop the keystroke spend and get ~4x headroom" — is **half right, and the measurement says which half**:

- The 4x is really there: control C1 bills **32 calls instead of 80** (1 per family, ≈1 per song), exactly as projected.
- But it costs **hit@10 79% → 36%**. Patrons would stop finding their songs.
- The quality-preserving version buys **40%** (3.75 → 2.25 per song). At the product's demonstrated demand (~24–25 songs/day) that is **~54 of 90 calls** instead of 90/90 — the budget stops being exhausted, with headroom, which is the reported problem solved. **[DERIVED]** from the measured ratio.

So the remaining gap between 1.7x and 4x is **not** an engineering gap that more cleverness closes. It is the as-you-type-vs-on-submit **feel** decision the ticket explicitly reserved for the Tech Lead — because searching on submit makes every query a completed thought, which removes the short-prefix problem at its root rather than working around it. Worth putting to him **only if** 54/90 turns out not to be enough in practice; at today's demand it is, so my recommendation is to ship this, watch the `sb:` counter for a couple of real venue nights, and raise the feel question only if the counter says so.

Two cheap follow-ups this surfaced, neither in scope here:

- **TICKET-85's `cached: true|false` flag on `search_performed` is still unshipped.** Every figure in this report about cache-hit behaviour had to be *derived* from the budget counter plus the UTC-boundary reconstruction, which only works while both happen to be readable. It is a two-line change and it would make the next measurement of this kind trivial instead of archaeological.
- **Telemetry on the `planSearch` reason** (`no-held-results` / `not-an-extension` / `local-matches-starved`) would turn "40% on one evening's corpus" into a continuously-measured number, and would show immediately if the starvation rate in the wild differs from the 16/48 measured here.

## Friction

- `git show ticket/106-search-quota:<path>` worked four times and then failed with `fatal: invalid object name` — the local branch and its worktree were removed by another tab mid-session. `origin/ticket/106-search-quota` works and is the more durable reference; worth preferring the remote ref when reading across branches in a shared multi-worktree checkout.
- The repo has no ESLint config, so `npx next lint` drops into an interactive setup prompt. Not a gate here; noted so nobody mistakes it for a lint failure.
