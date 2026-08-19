# TICKET-87 — Dev report: cross-instance daily `search.list` spend counter

**Branch:** `ticket/87-search-daily-spend-counter`
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-87`

## The gap being closed

`lib/youtube-search.ts` limits *velocity* (5/uuid, 30/IP per 10s). Nothing limited the platform's *daily total* against Google's post-2026-06-01 hard cap of 100 `search.list` calls/day. At the per-IP ceiling one client drains the whole day in ~35s and search dies for every venue until the reset — a cheap DoS on the core feature. This adds the missing ceiling. It does not touch the velocity limiter.

## What was built

| File | Change |
|---|---|
| `lib/search-budget.ts` | New. Atomic, cross-instance, Pacific-day-keyed reservation counter. |
| `app/api/search/route.ts` | Reserves one call after the cache read, before the outbound `search.list`. Degrades to `{ degraded: true, reason: "daily-limit", results: [] }`. |
| `components/SongSearch.tsx` | Distinct honest copy for the daily-limit case; load-more retires instead of failing silently. |
| `messages/{pt-BR,en,es}.json` | `Search.dailyLimit` (Search namespace only). |
| `__tests__/search-budget.test.ts` | 23 tests: day boundary, memory + Redis paths, atomicity under concurrency, fail-closed, negative control. |
| `__tests__/api-search-budget.test.ts` | 11 route-level tests asserting **outbound call counts**. |
| `__tests__/{api-search,search-pagination}.test.ts` | Added `_resetSearchBudget()` to `beforeEach` (module-level state). |
| `e2e/search.spec.ts` | 2 tests: cap degrade + paste-link still queues; load-more at cap. |

## The decisions

### Day boundary — midnight **Pacific**, DST-aware

Verified against primary docs, not assumed:

- "Daily quotas reset at midnight Pacific Time (PT)." — <https://developers.google.com/youtube/v3/determine_quota_cost>
- "For per-day quotas, the time period resets at midnight Pacific Time." — <https://docs.cloud.google.com/docs/quotas/overview>
- "Daily quotas refresh at midnight (0:00) Pacific Standard Time (PST) or Pacific Daylight Time (PDT), depending on the time of year." — <https://docs.cloud.google.com/speech-to-text/docs/v1/quotas>

The same fetch also confirmed the cap itself: "Projects that enable the YouTube Data API have a default quota allocation of 100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints."

So the key is the calendar date in `America/Los_Angeles` via `Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" })` — DST-correct by construction, no offset arithmetic. A UTC key would roll 7–8h early and hand out a second budget against a bucket Google still considers full. Tests pin both the PDT roll (07:00Z) and the PST roll (08:00Z).

### Atomicity — one Lua `EVAL`

Check-and-increment runs entirely inside `RESERVE_SEARCH_SCRIPT`, following `REGISTER_FAILURE_SCRIPT` (rate-limit-counter) and `REJECT_ALL_PENDING_SCRIPT` (pending-store). A client-side `GET` then `INCR` is a read-modify-write: N instances all read 89, all pass, all increment. Upstash's REST transport has no `WATCH` and its `MULTI/EXEC` only pipelines, so a script is the only option.

**cjson is deliberately not used.** TICKET-63 pinned that the pending-store round-trip is lossless *only* because every field is a string or boolean; cjson pushes numbers through a double, which is a live hazard for a counter. This script stores a bare Redis integer and returns a Lua number → exact integer reply. Asserted in a test.

### Reserve before spending, and **no refunds**

Increment happens before the outbound call. Failures are **not** refunded, for two reasons:

1. Google bills on request receipt, not on a 2xx — a 4xx/5xx answer was still billed, so refunding systematically under-counts.
2. **A refund path is an attacker-triggerable free credit.** Anyone who can induce failures gets unlimited free reservations, turning the ceiling into decoration.

There is therefore no refund API at all — a test asserts the module exports nothing matching `refund`/`release` and the script contains no `DECR`. The cost (a few slots charged for errored calls) is exactly what `RESERVE_MARGIN` absorbs.

### Fail-**closed** on an unreachable configured Redis

This deliberately diverges from `search-cache.ts` and `rate-limit-counter.ts`, which fail open. Their failures are symmetric and cheap; this one is not:

- **Fail open during a blip:** every instance spends unaccounted. A blip at peak (or one an attacker waits for) burns the whole 100 → search dead for every venue until midnight Pacific. **Not self-healing** — the damage outlives the outage by hours and cannot be undone.
- **Fail closed during a blip:** no new outbound searches for the blip's duration. Self-heals the instant Redis returns, the in-process L1 cache still answers hot queries, and **paste-a-link is completely unaffected** so patrons keep queueing songs.

Worst case fail-closed is strictly shorter and strictly recoverable. A **middle path** — a small per-process emergency allowance during an outage — was considered and **rejected**: serverless instance count is unbounded, so any per-process allowance multiplies by an unbounded factor and is not a bound at all.

Important scope note: "fail closed" applies only to a Redis that is *configured and failing*. With no Upstash configured (dev/CI/zero-secret boot) the module uses the in-process counter like every sibling store — still a real ceiling for a single instance, and dev/CI behaviour is unchanged.

### Headroom — stop at 90, not 100

`SEARCH_DAILY_CAP` 100, `RESERVE_MARGIN` 10, patron budget 90. The margin covers a manual smoke test or support search late in a drained day, the unrefunded errored calls above, and any drift between our count and Google's. Spending to exactly 100 guarantees whoever investigates the outage cannot reproduce it.

### Degrade honestly

At cap the route returns HTTP **200** with `{ degraded: true, reason: "daily-limit", results: [] }` — never a 5xx, never a hang. The client shows a distinct localized line ("Chegamos ao limite de buscas de hoje — cole um link do YouTube" / en / es) rather than the generic outage copy, and the paste-a-YouTube-link path is untouched because it spends no `search.list` call. On "load more" the cursor is dropped so the button retires instead of becoming a dead control.

The gate sits **after** the cache read, so cache hits never consume budget and popular queries keep working normally once the budget is gone.

### Observability

Every spend logs remaining budget (`console.info`), escalating to `console.warn` at or below `LOW_WATER_MARK` (15) so near-exhaustion is visible in logs before search stops. `getSearchBudgetUsage()` is exported for a future surface and returns `null` — not a misleading `0` — when the count can't be read.

**Remaining budget is deliberately NOT in the response body.** Telling a caller how much is left maps the drain's progress for an attacker. Both denial causes (cap reached, store down) return the identical opaque `reason: "daily-limit"`, so the response cannot be used to probe whether our Redis is down. Both are asserted.

The admin analytics page was **not** wired up: it is global and `HOST_TOKEN`-gated, and the log line already satisfies the stated minimum. Left as an optional follow-up.

## Verification

- `npm test` — **47 suites, 822 tests, all passing.**
- `npx tsc --noEmit` — 2633 lines, **entirely the pre-existing `@types/jest` baseline** (TS2304/TS2582 missing test globals, TS2540 `NODE_ENV`), all inside `__tests__/`. The only non-test error is pre-existing in `e2e/advance-auth.spec.ts`. `lib/search-budget.ts`, `app/api/search/route.ts` and `components/SongSearch.tsx` contribute **zero** errors. Real delta: **0**.
- `npm run build` — clean.
- Full Playwright e2e on `PORT=3194`.

### Atomicity proof

`__tests__/search-budget.test.ts` runs a fake Redis whose `eval` reproduces Redis's execution model (one script at a time, to completion, on a shared keyspace, real async gaps between invocations) and fires 270 **concurrent** reservations: exactly 90 are granted, and every granted `remaining` value is distinct (0..89) — which a read-modify-write cannot produce, since it hands the same value to multiple callers.

`__tests__/api-search-budget.test.ts` proves it end-to-end at the route by counting **outbound `search.list` calls**: 180 concurrent requests with distinct queries and distinct IPs produce exactly 90 outbound calls.

### Negative controls

Two, both observed red:

1. **In-suite (permanent):** `describe("negative control")` runs the identical concurrent load against a fake that implements the same logic **non-atomically** (an `await` between read and write) and asserts it **does** overspend. If the atomicity harness were ever vacuous, this test fails. It passes today, so the harness is sensitive.
2. **Counter reverted (one-off):** replacing the reservation with an unconditional `{ ok: true }` turned 6 of the 11 route tests red — the drain test let **180** calls through instead of 90, and the fail-closed test let calls escape during a simulated outage. Restored and re-verified 11/11 green.

## Known limits — stated plainly

**An attacker can still drain the budget.** This ticket converts *unbounded overspend ending in a Google 403* into *a bounded 90 with 10 held in reserve*. It does not make the platform drain-proof: a distributed caller with fresh queries (defeating the cache) and rotating IPs (defeating the per-IP window) can still be the one who consumes all 90. What changes is that the damage is now bounded, predictable, observable in logs before it completes, and leaves headroom for a human to investigate.

**`RATE_IP_MAX = 30` per 10s is now indefensible** — 180/min from a single IP against a 90/day platform budget means one IP can legitimately consume the entire platform's day in ~30 seconds. Retuning it is explicitly out of scope for this ticket, so it is **not changed here**. Recommended follow-up: a per-IP *daily* sub-budget (a handful of calls/IP/day) rather than only tightening the 10s window, since a daily sub-cap is what actually bounds a slow drain; a per-room sub-budget would additionally stop one venue starving the rest.

Neither belongs in this PR — this one adds the platform ceiling that did not exist.
