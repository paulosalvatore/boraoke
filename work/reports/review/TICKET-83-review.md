# TICKET-83 — Reviewer gate report

**Branch:** `ticket/83-search-mode-first-pagination` (worktree `.worktrees/ticket-83`, HEAD `07793a6`)
**Base:** `origin/main`
**Reviewer context:** clean — findings below are derived from the code and from commands run in this worktree, not from the author's claims.

## Verdict

**CHANGES REQUESTED** — 2 must-fix defects (§Findings 1 and 2), both small, both in the ticket's own subject matter (quota spend and cache integrity). Everything else in the ticket is well-built and the headline design is correct.

The core claims hold up under adversarial checking: a mode change genuinely fires zero YouTube calls, the cache genuinely covers deep pages, the first-page key is genuinely unchanged, nothing is prefetched, and locale parity is machine-enforced. The two blockers are both key/state-plumbing details, not design errors.

---

## 1. Observed command output

### `npm test`

```
Test Suites: 45 passed, 45 total
Tests:       778 passed, 778 total
Snapshots:   0 total
Time:        3.351 s
Ran all test suites.
```

All green, including the new `__tests__/search-pagination.test.ts` and the amended `__tests__/search-cache.test.ts`.

### `npx tsc --noEmit` — delta vs `origin/main`

`tsconfig.tsbuildinfo` deleted on both sides. Baseline measured in a throwaway detached worktree at `origin/main` (created, measured, and removed — `git worktree list` confirmed clean afterwards).

| | Total errors | TS2304 | TS2582 | TS7006 | TS2540 | TS2345 | TS2503 | TS2353 |
|---|---|---|---|---|---|---|---|---|
| `origin/main` | 2351 | 1483 | 824 | 20 | 17 | 5 | 1 | 1 |
| branch | 2420 | 1527 | 849 | 20 | 17 | 5 | 1 | 1 |
| **delta** | **+69** | +44 | +25 | 0 | 0 | 0 | 0 | 0 |

**No new error classes.** All 69 new errors are `Cannot find name 'describe' / 'it' / 'expect' / 'beforeEach' / 'afterAll'` emitted from the single new file `__tests__/search-pagination.test.ts` — the documented pre-existing missing-`@types/jest` baseline. Zero new errors in production source: `components/SongSearch.tsx`, `lib/youtube-search.ts`, `lib/search-cache.ts`, `app/api/search/route.ts` and `PatronRoom.tsx` are all clean.

### `npm run build`

Succeeded. `/api/search` and all patron/TV routes compiled; no new warnings surfaced in the route table.

### `PORT=3191 npx playwright test` (full suite, foreground)

```
7 failed
  contrast.spec.ts:389  landing › last-room quick-entry link meets AA
  contrast.spec.ts:407  landing › footer copy meets AA
  contrast.spec.ts:513  admin › accent-coloured remove button meets AA
  feedback-widget-safe-area.spec.ts:327  header trigger never overlaps a 25-row queue
  feedback.spec.ts:10   feedback button submits in 2 taps
  moderation.spec.ts:122  reject → patron sees the polite rejected state
  render-and-links.spec.ts:211  /new renders the create form
81 passed (18.5m)
```

**All 4 search specs — including the 3 new TICKET-83 specs — passed in the full run.**

The 18.5m wall time against a documented ~40s baseline indicates heavy machine contention, so I re-ran every failing file in isolation:

- `feedback-widget-safe-area.spec.ts` + `render-and-links.spec.ts` — **pass in isolation.** I checked these specifically rather than waving them through, because `PatronRoom.tsx` did change the add-song form layout (two-column grid → full-width table field), which could plausibly move the feedback pill or the page height. It does not.
- `contrast.spec.ts` — **18/18 pass in isolation** (3.4m). Note the failing test *changed identity* between runs (`311` failed on the second run, `389`/`407`/`513` on the first), which is itself proof of nondeterminism rather than a regression. The landing/admin surfaces it covers (`app/page.tsx`, `app/globals.css`, `components/tv/**`) are untouched by this diff.
- `feedback.spec.ts` + `moderation.spec.ts` — **5/5 pass in isolation** (1.3m); these are in the documented in-memory-store reset race set.

**Conclusion: zero regressions attributable to TICKET-83.**

---

## 2. Verification of the ticket's specific claims

### Mode change fires zero YouTube calls — CONFIRMED

Traced the mechanism rather than trusting the comment:

- `modeRef` is written by a `useEffect` on `[mode]`; `runSearch` is a `useCallback` over `[patronUuid]` only and reads `modeRef.current` at call time. `t` is deliberately excluded (documented, and correct — a locale change remounts the tree).
- The debounce effect depends on `[input, runSearch]`. Since `runSearch`'s identity is stable across a mode flip and `input` is untouched, the effect does not re-run. No other effect in the component depends on `mode`.

I then tried to break it by looking for a remount path, since a remount *would* re-fire the debounce. `SongSearch` carries `key={searchKey}` in `PatronRoom`. `setSearchKey` is called in exactly one place — line 305, after a *successful submit* — and not on mode change. `mode` state lives in the parent and survives that remount. No path found where changing the mode re-triggers a fetch.

Asserted by counting outbound calls, not by inspection: `e2e/search.spec.ts` "changing the mode fires NO search" routes `**/api/search**`, pushes every request into `seenQueries`, and asserts `toHaveLength(0)` before typing, `toEqual(["evidencias karaoke"])` after a mode flip post-results (with a 1200ms wait > the 400ms debounce), and exactly 2 only after the explicit "Buscar de novo" tap. The degraded spec independently counts calls across a mode flip too. This is the right shape of assertion.

### Cache covers paged results — CONFIRMED (but see Finding 1)

- `cacheKey(q, regionCode, pageToken)` folds the cursor in.
- First-page key is byte-identical: `cacheKey("foo bar","BR")` and `cacheKey("foo bar","BR","")` both yield `BR::foo bar`, pinned by a test. Live 12h Redis entries are not orphaned. Correct and important.
- Legacy bare-array payloads are still readable via `toSearchPage()`, pinned by a test.
- A revisited deep page is served with zero outbound calls, pinned by a test that counts `global.fetch` invocations across two different uuids.

### Page-depth cap — CONFIRMED client-side, NOMINAL server-side (Finding 4)

Client: `canFetchMore = !!nextPageToken && pagesFetched < MAX_SEARCH_PAGES`; the affordance retires and the copy switches to `refineSearch`. Nothing is prefetched — `loadMore` only ever runs from an `onClick`, and the reveal tier (`visible < results.length`) is checked first, so the first ~6 taps are pure client-side. Server: `page > MAX_SEARCH_PAGES` → 400 before any outbound call, pinned by a call-counting test. See Finding 4 for why the server side is weaker than the ticket claims.

### Degraded path — CONFIRMED

Route returns `{degraded:true, reason, results:[]}` before `pageToken` is ever used; `nextPageToken` is absent. Client sets `results=[]` and `resultsMode=null`, so the load-more button, the mode badge and the stale-mode notice are all *absent* rather than broken — they are gated on `results.length > 0`. Pinned by both a unit test (`degraded ignores pageToken`) and an e2e spec. Paste-a-link continues to work and produces a single row with `resultsMode=null`, so no pagination and no stale-mode notice.

### Locale parity — CONFIRMED, mechanically

11 new `Search` keys in all three catalogs. `__tests__/i18n-completeness.test.ts` is a CI gate that enforces exact leaf-key set equality *and* matching ICU argument sets per key across `pt-BR`/`en`/`es`; it passes. The two placeholder-bearing keys (`resultsFor`, `modeChanged`) carry `{mode}` in all three. No hardcoded user-facing strings in `SongSearch.tsx` — every visible string routes through `t()`.

### Sibling-file boundary — CONFIRMED

`git diff --name-status origin/main...HEAD` touches only: `components/SongSearch.tsx`, `lib/youtube-search.ts`, `lib/search-cache.ts`, `app/api/search/route.ts`, `app/(patron)/[room]/PatronRoom.tsx`, `messages/{pt-BR,en,es}.json`, `__tests__/{search-cache,search-pagination}.test.ts`, `e2e/search.spec.ts`, `work/tickets/**`, `work/evidence/TICKET-83/**`, `work/events/by-branch/*.jsonl`. The messages diffs are confined to the `Search` object — `Landing` and `Meta` untouched. Specifically confirmed untouched: `components/tv/**`, `app/(patron)/[room]/tv/page.tsx`, `app/page.tsx`, `app/page.module.css`, `app/globals.css`, `components/feedback/**`. No out-of-scope files.

---

## 3. Findings

### 1. MEDIUM (must fix) — cache-key collision lets an attacker poison any query's page 2

`lib/youtube-search.ts` `cacheKey()`:

```ts
const normalized = q.trim().toLowerCase().replace(/\s+/g, " ");
const page = pageToken ? `p:${pageToken}::` : "";
return `${regionCode}::${page}${normalized}`;
```

The key has a *variable* structure and its marker `p:` is lowercase, while `q` — fully attacker-controlled — is lowercased into the same namespace. So a **first-page** request whose `q` is literally `p:<token>::<query>` produces the same key as the **deep-page** entry for `<query>`, whenever Google's cursor contains no uppercase characters. Runnable repro against the real function:

```
legit deep-page key : "BR::p:cauqaa::evidencias karaoke"   // cacheKey("evidencias karaoke","BR","cauqaa")
attacker page-1 key : "BR::p:cauqaa::evidencias karaoke"   // cacheKey("p:cauqaa::evidencias karaoke","BR","")
COLLIDE             : true
attack q length     : 28   (limit is 100, so length is not a barrier)
```

The attacker does not need to guess the cursor: `nextPageToken` is returned in the response body to every client, so any patron can read the live page-2 token for a popular query and then craft the colliding query. The route performs a real search for that literal string and writes the result under the legit page-2 key with the 12h TTL. Consequence: **attacker-chosen videos are served as page 2 of that query to every patron at every venue for 12 hours**, on a product whose search results feed a bar's TV queue — plus one of the day's 100 searches burned to plant it.

The only thing standing between this and exploitability is an undocumented property of an opaque third-party token (Google's search cursors are conventionally uppercase-prefixed, e.g. `CAUQAA`, but they are explicitly documented as opaque and carry no character-set guarantee). Resting cache integrity on that is not acceptable when the fix is two characters.

**Fix:** uppercase the marker — `` const page = pageToken ? `P:${pageToken}::` : ""; ``. `normalized` is unconditionally lowercased, so it can never produce `P:`, which makes the key unambiguous by construction. `pageToken` cannot contain `:` (blocked by `PAGE_TOKEN_RE`), so the closing `::` is unambiguous too. This preserves the byte-identical first-page key, which is the property that must not regress. Update the two affected assertions in `__tests__/search-cache.test.ts`, and add a test asserting `cacheKey("p:X::foo","BR") !== cacheKey("foo","BR","X")`.

### 2. MEDIUM (must fix) — "load more" can spend a daily search on the wrong query

`components/SongSearch.tsx` `loadMore()` builds its request from the **live** `input`, but pairs it with `nextPageToken`/`pagesFetched` from the **previous** query:

```ts
const augmented = augmentQuery(input.trim(), resultsMode ?? modeRef.current);
const params = new URLSearchParams({ q: augmented, ..., pageToken: nextPageToken, page: String(pagesFetched + 1) });
```

The author correctly pinned the *mode* the results came from (`resultsMode`) but not the *query*. There is a reachable window where they diverge: when the patron edits the query, the debounce effect clears the timer and schedules `runSearch` 400ms later, but for a ≥3-char query it does **not** clear `results` and does **not** set `loading`. So during those 400ms the results list and the load-more button are still on screen, and `seqRef` has not yet incremented — meaning the `if (seq !== seqRef.current) return` guard does not fire. A tap in that window sends the **new** query with the **old** cursor.

Consequences, both squarely in this ticket's problem domain:

1. `cacheKey(newQuery, "BR", oldToken)` is a guaranteed miss, so it spends **1 of the platform's 100 daily searches** on a nonsensical query/cursor pair — the exact class of waste TICKET-83 exists to eliminate — and caches the junk for 12h.
2. Whatever comes back is appended to the previous query's rows, so the list mixes results from two different searches.

**Fix:** mirror the `resultsMode` pattern — add a `resultsQuery` state set inside `runSearch` alongside `setResultsMode(searchMode)`, and use it in `loadMore` instead of `input`. Belt-and-braces: also suppress the load-more affordance while a debounce is pending (e.g. a `pendingRef` set when the timer is scheduled and cleared when `runSearch` starts), so the stale affordance is not tappable at all. Worth an e2e assertion that typing-then-immediately-tapping issues no request.

### 3. LOW — legacy cache entries make the UI assert something untrue for 12h after deploy

The back-compat decision is right, but it has an unstated consequence. A legacy entry is a bare array of **8** rows with no cursor, so after deploy the hottest queries (the ones that are cached) return `nextPageToken: undefined` → `canFetchMore` false → `hasMore` false → `capped` false → the UI renders `noMoreResults` ("Isso é tudo que a gente achou."). That is false: Google had more, we simply have a pre-83 entry. For up to 12h, the ticket's headline feature is invisible on exactly the queries patrons hit most, and the copy misstates why.

Not a code defect and not worth orphaning the cache over (that would cost real quota). But it should be either documented in the ticket's rollout notes, or handled by treating a cursor-less entry whose length equals the *old* page size as non-terminal (fall back to the neutral `refineSearch` copy rather than the definitive `noMoreResults`).

### 4. LOW — the server-side depth cap is bypassable, so "enforced server-side" overstates it

`page` is client-declared and never cross-checked against `pageToken`, so `?page=1&pageToken=<arbitrarily deep cursor>` passes validation and fetches any depth. The ticket is honest that this is "a budget guard, not a security boundary", which is why this is LOW — but the ticket and the review checklist both say the cap is "enforced client-side AND server-side", and as written the server side stops only an honest client. Two cheap lines make it match its description: reject a `pageToken` when `page === 1`, and reject `page >= 2` without a `pageToken`.

Informational, not a regression: the genuine ceiling on hostile spend is the rate limiter (5/uuid, 30/IP per 10s), which permits the entire 100-search daily budget to be drained from one IP in ~35s. That was already true before this ticket (varying `q` generates distinct keys just as easily), so TICKET-83 does not regress it — but a cross-instance **daily search-spend counter** would be the real defense, and `lib/rate-limit-counter.ts` already anticipates it ("the room-create and search limiters can adopt it in their own follow-ups"). Recommend filing that as a follow-up ticket rather than expanding this one.

### 5. LOW — mode chips have no visible keyboard focus indicator

`chipStyle` has no `position`, and the visually-hidden radio is `position: "absolute"`. With no positioned ancestor the input is positioned against the nearest positioned element (or the initial containing block), so the browser's focus ring lands away from the chip. A keyboard patron gets no visible indication of which chip is focused. Add `position: "relative"` to `chipStyle`.

### 6. NIT — a new comment repeats the pre-June quota model this ticket exists to correct

`__tests__/search-cache.test.ts`, new legacy-entry test: "each one is ~101 quota units that would otherwise be re-burned". Under the corrected model it is 1 of 100 daily searches plus 1 unit of the separate metadata pool. Minor, but this ticket's stated purpose is to purge exactly that phrasing from the files it owns.

### 7. NIT — the end-of-list message is gated on `results.length > 1`

A single-result search shows neither `noMoreResults` nor `refineSearch`. Probably intentional (one row needs no epilogue); flagging only to confirm it is deliberate.

---

## 4. The deliberate deviation — cache key does NOT carry a separate `mode` component

**Verdict: I agree with the author. Do not add a mode component.**

Verified against `lib/search-query.ts`. `augmentQuery` appends `karaoke` in sing mode unless `containsKaraoke(query)` already matches, and returns the raw query otherwise — and it runs **client-side, before** `/api/search`. So:

- `sing "evidencias"` → `evidencias karaoke` → key `BR::evidencias karaoke`
- `vibe "evidencias"` → `evidencias` → key `BR::evidencias`

Distinct keys, no cross-mode poisoning. The mode is already in the key, transitively, via the only thing that actually differs — the query string sent to Google.

The one case where the keys converge is a raw query already containing "karaoke", and there the convergence is **correct, not a bug**: both modes send Google the *byte-identical* `q`, so they are the same search and must share one entry. Adding a `mode` component would split one identical search across two keys and spend a second of the day's 100 searches re-answering a question already answered — for zero difference in the result set. Under a 100-calls-per-day platform-wide ceiling that is a straightforwardly worse design, and the author is right to have pushed back rather than complied.

One caveat to record, since it is the load-bearing assumption: this correctness depends entirely on augmentation staying **client-side and pre-request**. If augmentation ever moves server-side, `q` stops encoding the mode and the key *must* gain a mode component or it will poison across modes. `lib/search-query.ts` already documents this reasoning; I'd add a one-line cross-reference from `cacheKey()` back to it so a future editor of either file cannot break the invariant without seeing it. (Finding 1 is a sharper instance of the same underlying fragility — the key's structure is doing semantic work without being explicit about it.)

---

## 5. Summary of required changes, severity-ranked

1. **MEDIUM — must fix.** `lib/youtube-search.ts` `cacheKey()`: uppercase the page marker (`p:` → `P:`) to make the key unambiguous against a lowercased attacker-controlled `q`; add a collision-negative test; update the two key assertions in `__tests__/search-cache.test.ts`. Preserve the byte-identical first-page key.
2. **MEDIUM — must fix.** `components/SongSearch.tsx`: add `resultsQuery` state set in `runSearch`, and use it (not live `input`) in `loadMore`; suppress the load-more affordance while a debounce is pending; add an e2e assertion that typing-then-tapping issues no request.
3. **LOW — recommended.** Document (or soften the copy for) the 12h legacy-cache window where cursor-less pre-83 entries make the UI claim "that's everything we found".
4. **LOW — recommended.** Cross-check `page` against `pageToken` in the route so the server-side cap matches its description; file the cross-instance daily search-spend counter as a follow-up ticket.
5. **LOW — recommended.** Add `position: "relative"` to `chipStyle` so the mode chips show a keyboard focus ring.
6. **NIT.** Fix the "~101 quota units" comment in `__tests__/search-cache.test.ts`.
7. **NIT.** Confirm the `results.length > 1` gate on the end-of-list message is deliberate.

Items 1 and 2 block merge. Items 3–7 are the reviewer's recommendation and can be taken in this PR or filed, at the Ticket Manager's discretion. Re-verification of 1 and 2 required before I re-issue a verdict.
