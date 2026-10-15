# TICKET-125 — Dev report

## Status
Implemented, measured and self-verified. Draft PR open, base `ticket/124-index-primary` (stacked on PR #88; retarget to main after #88 merges). Not merged. No gate requested yet.

## Context
- Picking up from: fresh start (no prior TICKET-125 record). Read the ticket brief, PR #88's dev report, RESULTS and replay harness.
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t125-enter-idle-search`
- Branch: `ticket/125-enter-idle-search`, cut from `origin/ticket/124-index-primary` @ `882260c`
- App/e2e port: 3125
- PR: #89 https://github.com/paulosalvatore/boraoke/pull/89 (draft, base `ticket/124-index-primary`)
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

## Open items for the TM
- **Deploy skew:** a browser still holding the pre-#125 bundle sends no `live=1`. On an index miss it sees an empty list until reload; its "load more" and IDXLIVE escape still work. Consider deploying #88 and #125 together, or accept a short skew.
- The timing model is an assumption. Real keystroke timing would need client telemetry (pause lengths), which is not collected. A possible follow-up.
- The cooldown is per instance (in memory), like the existing rate limiter. The cross-instance hard cap is still the TICKET-87 budget.

## Friction
- A clock-flowing e2e passed under the mutation it was meant to catch. Idle-timer e2e must freeze the clock. Recorded above.
- The first replay run took over 10 min (decideTier ran 4000 × per point). Memoising per query brought it down to 2.5 min.
