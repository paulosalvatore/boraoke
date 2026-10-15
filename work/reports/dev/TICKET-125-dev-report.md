# TICKET-125 — Dev report

## Status
2026-10-15: `origin/main` (#88 squash, #91, #92) merged in (`a73ca7a`); PR #89 is based on `main`, draft. jest, build and one full e2e run are green after the merge; `measure:t125` unchanged. Gate fix batch (`93c3799`, `632d2c3`) awaits the Cyber Security and Reviewer re-gates.

Earlier status: implemented, measured and self-verified on top of #88's fix batch (`bed2857`, merged in), including the `v=2` legacy-compat change.

Earlier status: implemented, measured and self-verified. Draft PR open, base `ticket/124-index-primary` (stacked on PR #88; retarget to main after #88 merges). Not merged. No gate requested yet.

## Context
- Picking up from: fresh start (no prior TICKET-125 record). Read the ticket brief, PR #88's dev report, RESULTS and replay harness.
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search`
- Branch: `ticket/125-enter-idle-search`, cut from `origin/ticket/124-index-primary` @ `882260c`
- App/e2e port: 3125
- PR: #89 https://github.com/paulosalvatore/boraoke/pull/89 (draft, base `main` since #88 merged)
- Plan: `work/plans/TICKET-125-plan.md` (approved via the TM dispatch brief).

## Log

### 2026-10-14 explore
Explore subagent mapped e2e/search.spec.ts (mocks /api/search via page.route; no page.clock use anywhere yet), the i18n parity test (`__tests__/i18n-completeness.test.ts`), the absence of SongSearch component tests (jest env is node), and the replay harnesses. Key finding: **the production traces carry no timestamps**; each trace element is a prefix that production billed, i.e. a pause of at least the 400 ms debounce. Any idle-timing result therefore needs a stated pause model.

### 2026-10-14 build (commit `0f79c48`)
- **Server, `app/api/search/route.ts` + `lib/live-search-gate.ts`:**
  - A first page is **index-only by default**. It is answered from cache → karaoke index, or gets `200 {results: [], liveRequired: true}` without touching the key, the daily budget or Google. Only `live=1` (exactly) or a `pageToken` ("load more", including the IDXLIVE escape) may bill.
  - A **per-uuid live cooldown** (2 s, in front of the budget reservation, `anon` keyed per IP) answers a too-soon billed attempt with `{deferred: "live-cooldown", retryAfterMs}`. A modified client sending `live=1` per keystroke gets at most one billed call per 2 s per uuid. uuid rotation stays bounded by the per-IP bucket and the TICKET-87 daily cap.
  - Index-only lookups get **their own rate bucket** (`indexRateLimitOk`, 30/10 s per uuid, 240 per IP), so as-you-type lookups never starve the strict billed window (5/10 s).
- **Client, `lib/search-trigger.ts` + `components/SongSearch.tsx`:**
  - `LiveSearchTrigger` is a pure, timer-injected class: idle timer, once-per-text guard, late-miss handling, Enter, allowRetry. `isSearchKey` treats Enter as search, but not during IME composition.
  - Typing sends debounced index-only lookups. A miss shows a subtle hint and arms the idle timer (`IDLE_SEARCH_MS` = 4000). Enter fires a live-allowed request immediately. The input sets `enterKeyHint="search"` and `inputMode="search"`. "Search again" is live. A `deferred` reply is retried once after `retryAfterMs` if the text is unchanged.
- **i18n:** one new key, `Search.enterToSearch`, in en/es/pt-BR. The parity test passes.
- **README:** a "When live search may run" paragraph in the search-tiers section.
- **Measurement:** `work/measurements/ticket-125/replay.ts` (`npm run measure:t125 -- --controls`) writes `RESULTS.txt`.
- **Legacy route suites** (api-search, api-search-budget, search-pagination) model the billed path, so their requests now carry `live=1` and their cooldown is neutralised by a jest.mock (the cooldown has its own suites).

### 2026-10-14 measurement
- **Timing assumption (stated, not measured):** each mid-title pause (already ≥ 400 ms) lasts ≥ N s with probability S(N), drawn from a log-normal model (median 1 s, sigma 1). That gives S(3) = 0.166, S(4) = 0.101, S(5) = 0.066. The final prefix of each family always settles (Enter or idle). Enter is never pressed mid-title. Monte Carlo, 4000 runs, seed 125.
- **Calls per queued song: PR #88 1.22 → 0.89 at N = 4 s** (26 → 18.91 mean billed; p5-p95 18-21). 3 s gives 0.91 and 5 s gives 0.87. The Enter-only floor is 0.84. The full S sweep (1.0 → 0) is in RESULTS.txt, so other assumptions can be read off it.
- **hit@10: 25/28 → 25/28** (mean and worst run, at every N and every S). Nothing is newly missed. Grading uses what the patron sees when they settle (Enter/idle) on the graded query.
- Controls:
  - C1 S = 1 reproduces PR #88 exactly (26 billed, 25/28).
  - C2 empty index + S = 1 reproduces TICKET-108 main (48, 22/28).
  - C3 with nothing ever going live, on-screen hit@10 drops to 15/28, so the settle rule is load-bearing and disclosed.
  - C4 billing rises with S (18.44 → 22.28).
- **Idle choice, 4 s:** inside the TL's range. It costs 0.02 calls/song more than 5 s. 3 s fires on about 1.6x as many mid-title pauses as 4 s. 5 s makes a non-Enter patron wait longer for little gain. The justification is in `lib/search-trigger.ts`.

### 2026-10-14 tests + prove-can-fail
New suites: `search-trigger` (17), `live-search-gate` (6), plus 10 route tests in `api-search-index-tier`. New e2e (4): Enter hint and Enter-only billing; idle once at 4 s with none before and none repeated; index hit never idles; enterkeyhint/inputmode. The idle and Enter e2e use `page.clock`, frozen after join (`pauseAt` + `runFor`), so there are no real 4 s sleeps.

Mutation pass (jest; each mutation restored afterwards; worktree verified clean):

| Mutant | Caught by |
|---|---|
| M1 idle timer fires at 0 ms | "fires ONE live search exactly IDLE_SEARCH_MS after the last edit, not before", "every edit restarts the idle period" |
| M2 idle once-guard removed | "fires once: never again for the same text" |
| M3 idle ignores index hit/miss | "never fires before the free tiers have answered", "a late index miss…", "ignores a stale miss…" |
| M4 Enter never fires | "fires a live search immediately, with no wait", "cancels the pending idle search…", "can retry…" |
| M5 `isSearchKey` dead | "Enter (and the phone's search/go key…) is a search key" |
| M6 server default flipped to live | 5 route tests incl. "an index-only request the index cannot answer bills NOTHING…", plus "liveAllowed › a first page is index-only unless it says live=1" |
| M7 cooldown removed | "a client sending live=1 on EVERY keystroke bills at most once per cooldown", "the cooldown also covers 'load more'", 2 gate unit tests |
| M8 index-only shares the strict bucket | "as-you-type lookups use their own rate bucket…" |
| M9 index-only miss falls through to live | 5 route tests |

e2e mutations (component, rebuilt each time, `workers: 1`):
- **E1, `onKeyDown` removed:** "an index miss shows the Enter hint and bills NOTHING until Enter" FAILS (results never visible).
- **E2, `trigger.edited` removed:** "idle: ONE live search after 4 s…" FAILS ("Expected: 1, Received: 0").
- **Honest note:** the first version of the Enter e2e let real time flow, and it **passed under E1** because the real 4 s idle timer fired inside the 5 s assertion timeout. I fixed this by freezing the clock after join; it now fails as shown above.

**Reverse-check** (the new route tests run against PR #88's `route.ts`): 7 of the 10 new route tests fail. Verbatim:
```
  ● index-only vs live-allowed requests › an index-only request the index cannot answer bills NOTHING and says liveRequired

    expect(received).toEqual(expected) // deep equality

    - Expected  -  2
    + Received  + 10

      Object {
    -   "liveRequired": true,
    -   "results": Array [],
    +   "nextPageToken": "CDIQAA",
    +   "results": Array [
    +     Object {
    +       "channelTitle": "YT",
    +       "duration": "3:00",
    +       "thumbnailUrl": "",
    +       "title": "Live result",
    +       "videoId": "vLive000001",
    +     },
    +   ],
```
The 3 that pass on the pre-fix route are companions, not regression tests: cache served to index-only, per-uuid independence, and anon per-IP.

- Hollowing-out: no primitive beneath existing assertions changed (the legacy suites now send `live=1` explicitly, and their billing assertions are unchanged).
- Triggered mutation pass: not triggered. There is no new parsing/normalisation function on a money/quantity/identity path.

### 2026-10-14 draft PR
#89 opened as a draft against `ticket/124-index-primary`. The body carries the measurement table, the idle justification, the server-enforcement section and the Testing Handoff. Commits: `0f79c48` (implementation), then the e2e clock fix plus this report.

### 2026-10-14 self-verification
- jest: **61 suites, 1,066 passed, 5 skipped, 0 failed**. Load ~5.5-8.8 on 10 cores, with no other jest of mine running.
- `npm run build`: OK. `bundle-es-target: OK` (50 chunks at ES2019) and `css-target: OK` (TV surface). The CSS advisories are pre-existing.
- e2e full suite: **131/131 passed in 3.8 min**, `workers: 1`, `PORT=3125`. The `.next-e2e` build cache was warm, since the worktree had built for the search-spec runs first, and the webServer rebuilds every run. Load was 7.2 at the start and 11.9 at the end on 10 cores. No other playwright test runner or next server was running; only idle `playwright-mcp` servers were present. `e2e/_canary` passed, and so did `e2e/tv.spec.ts:740`. Earlier: canary + search.spec cold, 22/22 in 56.7 s.
- Live smoke (`next dev -p 3125`, `KARAOKE_INDEX_FILE` = fixture, no key):
  - `evidencias karaoke` (index-only) → index rows.
  - `escurinho do cin karaoke` → Rita Lee "Flagra".
  - `soda stete karaoke` (index-only) → `{"results":[],"liveRequired":true}`; the same query with `live=1` → `degraded:no-api-key`, which is correct with no key.
  - The server was stopped by PID and port 3125 was freed.

### 2026-10-14 TM change: protocol version (old tabs)
TM finding: a page loaded before the deploy (venues keep pages open all night) never sends `live=1`. On an index miss it would show an empty list until reloaded, which is a patron-facing regression.

Fix (`lib/live-search-gate.ts`, `SongSearch.tsx`, route doc):
- The current client sends `v=2` on every request, including "load more".
- **A request without `v=2` is a legacy client** and keeps the pre-#125 path: cache → index → live fallback. It is still subject to the 2 s per-uuid billed cooldown, the strict per-uuid/per-IP rate limit and the daily budget.
- A v2 request without `live=1` gets `liveRequired`.
- **Residual:** a client can omit the marker on purpose to get live fallback on every request. The cooldown still holds it to at most 1 billed call per 2 s per uuid. Rotating uuids is bounded by the per-IP bucket (30/10 s) and the daily cap.

New tests:
- "a v2 request without live=1 gets liveRequired on an index miss, and bills nothing"
- "a LEGACY request (no v=2 …) on an index miss still gets live results"
- "legacy requests stay under the per-uuid billed cooldown"
- "legacy requests still get index answers first"
- gate unit tests for `isLegacyClient` / `liveAllowed`

The per-keystroke and load-more cooldown tests now send `v=2` explicitly.

Mutation pass (each mutation restored afterwards; the mutated files were back in their pre-mutation state):
```
$(cat $S/mut2.txt)
```
(The L3 line above is from before the cooldown tests were split into v2 and legacy. Re-run after the split: `L3 legacy exempt from the billed cooldown: Tests: 1 failed, 27 passed, 28 total`, failing on `legacy requests stay under the per-uuid billed cooldown (no per-keystroke billing by omitting v=2)`.)

jest after the change: **61 suites, 1,071 passed, 5 skipped, 0 failed** (load ~12-13 on 10 cores).

### 2026-10-14 base update: #88 fix batch merged in (`bed2857`)
- **Merged, not rebased** (merge commit `d09ebd0`, parents `e445855` + `bed2857`). A rebase of the pushed, stacked branch would need a force-push. The house commit mechanism never force-pushes, and the TM allowed a merge as the no-force alternative. The PR diff against `ticket/124-index-primary` is unchanged in meaning.
- Conflicts:
  - README: kept #88's rewritten tier, storage and retention text, plus this ticket's Enter/idle paragraph.
  - `api-search-index-tier.test.ts`: kept #88's "without even loading the index" assertion, with this ticket's `live=1`.
- #88 stopped committing the harvested fixture (it is gitignored, local only). `measure:t125` now refuses to run without it, like `measure:t124`. I ran it against the same local fixture #88 measured with: harvested 2026-10-14T23:52:24Z, sha1 `4a7cd5b6…`, identical to the copy in the t124 worktree. The harness also uses #88's new title-only hit predicate (`--legacy-predicate` restores title+channel).
- `npm run measure:t125 -- --controls` after the merge, verbatim:
```
SHIPPED: IDLE_SEARCH_MS=4000
billed search.list per queued song:  BEFORE (PR #88) 1.22  ->  AFTER 0.89   (26 -> 18.91 mean calls over the same traces; p5-p95 18-21)
                                     Enter-only floor 0.84   (no mid-title pause ever reaches N)
hit@10 (settled):  BEFORE 25/28 (89%)  ->  AFTER mean 25.00/28, worst run 25/28 (89%)
newly missed (Enter-only vs PR #88): (none)
C1 S=1 (every pause bills)   billed 26 (PR #88: 26)  hit@10 25 (PR #88: 25)  -> identical to PR #88, as required
C2 empty index, S=1          billed 48 (pre-index main: 48)  hit@10 22 (22)  -> identical to TICKET-108 main, as required
C3 nothing ever goes live    billed 0  hit@10 on screen 15/28  -> quality DROPS — the Enter/idle settle is what keeps quality
C4 S 0.05 -> 0.5              billed 18.44 -> 22.28  -> rises with S, as required
```
- The 125 replay reproduces #88's new numbers exactly: 26 billed, 1.22/song, 25/28 (#88 RESULTS line: `BEFORE 2.25  →  AFTER 1.22   (48 → 26 calls …)`, `hit@10: … AFTER 25/28 (89%)`).
- jest after the merge: **63 suites, 1,087 passed, 5 skipped, 0 failed** (load ~11-12 on 10 cores).
- **e2e, one full run after the merge (HEAD `b10f961`): 131/131 passed in 3.9 min.** Conditions:
  - `workers: 1`, `PORT=3125`, warm `.next-e2e` build cache (the webServer rebuilds each run).
  - Before starting I waited until no other playwright/next process was running; a `next dev -p 3134` from another tab had been live and had exited.
  - Load was 9.9 at the start and 9.7 at the end on 10 cores.
  - `e2e/_canary` passed, as did `e2e/tv.spec.ts:740`.

### 2026-10-14 gate fix batch: Security FAIL (HIGH 1) and Reviewer REQUEST-CHANGES (B1 + items 2-6); App Tester PASS (c9e1539)
Commits: `93c3799` (H1, B1) and `632d2c3` (legacy 429, Enter on a pasted link, per-mode guard, copy).

**H1. Index lookups evicted the billed per-IP bucket.** `lib/youtube-search.ts`:
- Index buckets now live in their own `indexHits` map with their own LRU cap, so they can never evict a billed `u:`/`ip:` key.
- `indexRateLimitOk` checks the IP bucket first. Once it rejects, no uuid key is added.
- Regression suite `__tests__/search-rate-isolation.test.ts`:
  - unit: a full billed IP bucket survives 5,000 fresh-uuid index lookups from the same IP.
  - unit: index lookups add 0 billed buckets, and the rejected lookups add no uuid key.
  - route: Security's probe (d) shape over one 10 s window, ≤ RATE_IP_MAX billed.
- Run against the previous head's limiter (`git show HEAD:lib/youtube-search.ts`, before `93c3799`), verbatim:
```
  ● index-only lookups cannot evict the billed per-IP bucket › unit: a full billed IP bucket stays full after 5,000 free lookups with fresh uuids from the same IP
    Expected: 0
    Received: 30
  ● index-only lookups cannot evict the billed per-IP bucket › route (probe d): ONE real IP, rotating uuids + a free index flood stays at the per-IP billed ceiling
    Expected: <= 30
    Received:    300
Tests:       2 failed, 2 total
```
  On the fixed head, the same route test bills ≤ 30 in a 10 s window, which is 180/min, #88's figure. Before the fix it billed 300 in 10 s, which is 1,800/min.
- Partial mutants:
  - H1a (index buckets back in the shared map) and H1b (uuid key inserted before the IP check) are each killed by the bucket-count unit test.
  - H1a alone does not reopen the route drain, because the IP-first ordering already stops rejected lookups from churning the map. The separate map is the second layer, for the case where more than 2,000 accepted keys arrive (e.g. spoofed XFF, TICKET-119).

**B1. A deferred request must cost no daily budget.** The per-keystroke test now reserves one probe slot afterwards and asserts `remaining === SEARCH_DAILY_BUDGET - 2`, i.e. the four keystrokes spent exactly one slot.

**Other review items:**
- **Old tab inside the cooldown** now gets the existing 429 ("too many searches, wait"), not `deferred`. Tested.
- **Enter on a pasted link:** the pasted-link check runs before `preventDefault`, so the queue form submits. New e2e "Enter inside the search field on a pasted link still queues it".
- **Once-guard keyed on mode + text:** `LiveSearchTrigger.setScope(mode)`, called from the mode effect; it fires nothing (TICKET-83). Tests: "the once-guard is per mode…" and "a mode change alone never fires anything".
- **Copy, my call:**

  | Locale | Text |
  |---|---|
  | en | "Tap Search (or press Enter) to search YouTube" |
  | es | "Toca Buscar (o Enter) para buscar en YouTube" |
  | pt-BR | "Toque em Buscar (ou Enter) para pesquisar no YouTube" |

  Why: patrons are on phones, where `enterKeyHint="search"` labels the key "Search"/"Buscar" (iOS) or shows a magnifier (Android), and "Enter" is not on the screen. Desktop keeps Enter in parentheses. pt-BR says "pesquisar" to avoid "Buscar … buscar". The strings are longer than before, so one-line fit at 390 px is UNVERIFIED; the App Tester checked the shorter copy.
- **Reviewer item 5 (Android keyCode 229):** not changed. The App Tester's CDP simulation showed no submit and the idle search fired. A real Android keyboard is UNVERIFIED.

Mutation pass (each mutation restored afterwards; files verified back in place):
```

B1 cooldown moved after reserveSearchCall(): Tests:       1 failed, 20 passed, 21 total
   FAIL: index-only vs live-allowed requests › a client sending live=1 on EVERY keystroke bills at most once per cooldown
      Expected: 88
      Received: 85

H1a index buckets back in the shared billed map: Tests:       1 failed, 2 passed, 3 total
   FAIL: index-only lookups cannot evict the billed per-IP bucket › unit: index lookups never add billed buckets, and a rejected lookup adds no uuid key
      Expected: 0
      Received: 241

H1b uuid key added before the IP check: Tests:       1 failed, 2 passed, 3 total
   FAIL: index-only lookups cannot evict the billed per-IP bucket › unit: index lookups never add billed buckets, and a rejected lookup adds no uuid key
      Expected: 241
      Received: 2000

L4 legacy cooldown answered with deferred (no 429): Tests:       1 failed, 20 passed, 21 total
   FAIL: index-only vs live-allowed requests › legacy requests stay under the per-uuid billed cooldown (no per-keystroke billing by omitting v=2)
      Expected: 429
      Received: 200
```
plus "setScope is a no-op": FAILS "the once-guard is per mode: the same text in another mode may fire".

Security LOWs are noted in the PR body only:
- LOW 2: the cooldown does not lower the paced single-uuid ceiling (30/min, same as #88).
- LOW 3: the legacy path is a permanent marker bypass, so a sunset ticket is needed.
- INFO 6: the anon cooldown key embeds the raw XFF hop; fold into TICKET-126.

### 2026-10-15 base update: `origin/main` merged in (#88 squash `c8de70e`, #91 `b249326`, #92 `17d53f2`)
- **Merged, not rebased** (merge commit `a73ca7a`, parents `c2765b1` + `17d53f2`; pushed, then the event-log commit `995d23a`). No force-push.
- **Why it conflicted:** #88 landed on main as a squash of the content this branch had already merged from `ticket/124-index-primary` (`bed2857`), so git saw add/add conflicts on the same files. `git diff bed2857 c8de70e` outside `work/` is only #91's files plus a 10-line redis index store test change, so main's #88 is the #88 this branch was built on.
- **Conflicts and resolution** (rule: per file, compare this ticket's delta `bed2857..HEAD` with main's delta `bed2857..origin/main`; only one side ever changed a file, except README):

  | File | Resolution |
  |---|---|
  | `.gitignore` | main's (#92 adds the oracle ignore line; this ticket never touched it) |
  | `__tests__/karaoke-index-store-redis.test.ts` | main's (this ticket never touched it) |
  | `scripts/karaoke-index-harvest.ts` | main's (#92 note; this ticket never touched it) |
  | `work/measurements/ticket-124/replay.ts` | main's (#92 oracle guard; this ticket never touched it) |
  | `app/api/search/route.ts` | this branch's (main has no change past #88) |
  | `__tests__/api-search-index-tier.test.ts` | this branch's (same) |
  | `package.json` | this branch's (`measure:t125` script; same) |
  | `README.md` | main's text (#92 oracle wording) plus this ticket's Enter/idle paragraph, re-applied as a patch |

- `work/measurements/ticket-108/production-search-results.json` stays **deleted** (from #92). Nothing #92 removed was reintroduced.
- `git diff origin/main` after the merge contains only TICKET-125 files (24 files; outside `work/`: the route, gate, trigger, limiter, SongSearch, messages, README, package.json and the jest/e2e suites).
- **Harness adaptation:** `measure:t125` read the oracle unconditionally, so after #92 it would crash. It now refuses with exit 2 and the same regenerate note as `measure:t124` (verified: run without the oracle printed `FATAL: … the TICKET-108 production oracle) is missing.` and reported no numbers). The README sentence says it needs the local fixture and oracle.
- **Measurement re-run:** I restored the oracle to its gitignored path from git history (`git show c8de70e:work/measurements/ticket-108/production-search-results.json`; `git check-ignore` confirms `.gitignore:46`), ran the harness against the same fixture (sha1 `4a7cd5b6…`), then deleted the local copy again so the worktree matches main. `RESULTS.txt` regenerated byte-identical (no diff). Verbatim:
```
SHIPPED: IDLE_SEARCH_MS=4000
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
billed search.list per queued song:  BEFORE (PR #88) 1.22  ->  AFTER 0.89   (26 -> 18.91 mean calls over the same traces; p5-p95 18-21)
                                     Enter-only floor 0.84   (no mid-title pause ever reaches N)
hit@10 (settled):  BEFORE 25/28 (89%)  ->  AFTER mean 25.00/28, worst run 25/28 (89%)
Enter-only run misses: banderille karaoke | soda stete karaoke | banderilleros karaoke
PR #88 run misses:     banderille karaoke | soda stete karaoke | banderilleros karaoke
newly missed (Enter-only vs PR #88): (none)

C1 S=1 (every pause bills)   billed 26 (PR #88: 26)  hit@10 25 (PR #88: 25)  -> identical to PR #88, as required
C2 empty index, S=1          billed 48 (pre-index main: 48)  hit@10 22 (22)  -> identical to TICKET-108 main, as required
C3 nothing ever goes live    billed 0  hit@10 on screen 15/28  -> quality DROPS — the Enter/idle settle is what keeps quality
C4 S 0.05 -> 0.5              billed 18.44 -> 22.28  -> rises with S, as required
```
  Fixture line: `index fixture: 71 channels, 38275 videos, harvested 2026-10-14T23:52:24.533Z; oracle: 80 production cache keys; traces: 32 families`. No delta: calls/song 0.89, hit@10 25/28.
- **jest:** `Test Suites: 65 passed, 65 total` / `Tests: 10 skipped, 1099 passed, 1109 total`. The skip count rose from 5 to 10 because #92 made the 5 escurinho replay tests in `search-prefix.test.ts` skip without the local oracle (`Tests: 5 skipped, 17 passed, 22 total` for that file alone), exactly as on main. The +2 suites are #91's `claim-token-owner-pin` and this ticket's `search-rate-isolation`. Load ~24 on 10 cores.
- **Build:** `npm run build` exit 0: `✓ Compiled successfully`, `bundle-es-target: OK — all 50 chunk(s) parse at ES2019.`, `css-target: OK — the TV surface uses nothing newer than Chrome 68 (18 stylesheet(s) scanned).`
- **e2e, one full run on the merged tree:** `132 passed (4.1m)`, exit 0, no failures or flaky. `PORT=3125 npx playwright test --workers=1`.
  - The machine had just rebooted (Spotlight, iCloud and the Docker VM were indexing; load peaked at 136). I waited until load fell below 12 with no other playwright test / next / jest process before starting: load was 12.32 at the start and 62.31 at the end on 10 cores (other tabs' work, not a test runner of mine).
  - 132 = 131 before + the gate fix batch's "Enter inside the search field on a pasted link still queues it".
```
  ✓    1 [chromium] › e2e/_canary.spec.ts:22:7 › run-triage canary (not a product test) › the runner evaluates constants correctly (4ms)
  ✓    2 [chromium] › e2e/_canary.spec.ts:28:7 › run-triage canary (not a product test) › the runner's async primitives complete (52ms)
  ✓  101 [chromium] › e2e/search.spec.ts:808:5 › Enter inside the search field on a pasted link still queues it (TICKET-125) (291ms)
```
- **Behaviour change from the merge:** none to this ticket's code. #91 (claim-token cap) and #92 (oracle removal, docs/tickets) touch no file this ticket changes, apart from the README and `.gitignore` lines above.
- Housekeeping note: the Log entry "2026-10-14 TM change" contains a literal `$(cat $S/mut2.txt)` where the L1-L3 mutant output should have been (a heredoc that never expanded). The text is lost; the verdicts are restated in the PR body, and the L3 re-run line under it is verbatim.

## Open items for the TM
- Deploy skew: resolved by the `v=2` protocol marker (see above).
- **Legacy client + cooldown:** an old page (no `v=2`) that hits the 2 s cooldown gets the existing 429 ("too many searches, wait"), not `deferred`, which it would render as an empty list; its next keystroke refetches. Tested. Only v2 clients receive `deferred`.
- The timing model is an assumption. Real keystroke timing would need client telemetry (pause lengths), which is not collected. A possible follow-up.
- The cooldown is per instance (in memory), like the existing rate limiter. The cross-instance hard cap is still the TICKET-87 budget.

## Friction
- A clock-flowing e2e passed under the mutation it was meant to catch. Idle-timer e2e must freeze the clock. Recorded above.
- The first replay run took over 10 min (decideTier ran 4000 × per point). Memoising per query brought it down to 2.5 min.

## Reviewer nits 7-9 (follow-up)

- Nit 7: new e2e "a mode switch re-arms the once-per-text guard" (`e2e/search.spec.ts`). Mutation: commenting out `triggerRef.current?.setScope(mode)` in `SongSearch.tsx` makes it FAIL at `expect.poll(() => liveCalls(log)).toBe(2)` (Expected 2, Received 1); restored, it passes.
- Nit 8: route response-contract comment, README cooldown sentence and the open item above now say an old tab inside the cooldown gets the 429.
- Nit 9: PR body corrected (search-trigger suite is 19 tests; 390 px fit now the App Tester's finding).
