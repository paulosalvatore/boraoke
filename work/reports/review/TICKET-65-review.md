# TICKET-65 Review — `/tv` e2e deflake

Reviewer: independent Reviewer agent (no prior analysis seen)
Branch: `ticket/65-tv-e2e-deflake` (changes are uncommitted working-tree modifications; `git diff main...HEAD` is empty, `git diff` carries the change)
Date: 2026-08-05

## Verdict

**APPROVE** (revised from APPROVE-WITH-FOLLOWUPS after the rate-limit-bucket fix — see §6)

The fix targets a real, independently reproduced mechanism — not timing guesswork. Timeout changes are bounded and justified, one of them is a genuine determinism improvement rather than a bigger sleep. Zero product source touched. Six full green runs (30/30 tests) plus one spec-isolated run.

The single follow-up I raised — the warm-up exhausting the 12/60s singer-skip rate-limit bucket — was fixed in-review and I re-verified it empirically. Nothing remains open.

## 1. Zero product source touched — VERIFIED

```
 e2e/helpers.ts          | 23 +++++++++++++++++++++++
 e2e/tv-watchdog.spec.ts | 15 ++++++++++++---
 e2e/tv.spec.ts          | 32 +++++++++++++++++++++++---------
 3 files changed, 58 insertions(+), 12 deletions(-)
```

Test files only. Nothing under `app/`, `lib/`, `components/`. `npx tsc --noEmit` reports no errors in any of the three changed files (the repo has pre-existing bare-tsc noise in `__tests__/` and `e2e/advance-auth.spec.ts`, unrelated to this diff and present on main).

## 2. The mechanism is real — INDEPENDENTLY REPRODUCED

I did not take the ticket's claim on trust. On a **fresh** dev server (port 3177), driving it directly with curl:

```
== server up; /api/queue compiled ==
-- seed via POST /api/queue --
{"ok":true}
-- GET /api/queue (should show 1 item) --
{"items":[{"id":"22e9ab52-3e25-40c1-b35c-638ee7b8a121","videoId":"aaaaaaaaaaa","title":"Probe",...}],"nowPlaying":{...
-- FIRST EVER GET /default/tv (forces route compile) --
status=200
-- GET /api/queue AGAIN (did the store reset?) --
{"items":[],"nowPlaying":null,"paused":false,"mode":"full-karaoke","moderation":false}
```

A seeded queue entry, visible via an already-compiled `/api/queue`, **vanished** purely because `/default/tv` compiled for the first time. This is exactly the documented `next dev` per-route-bundle singleton-reset caveat. The root cause in the helper's doc comment is accurate, and this is a mechanism bug, not a timing bug.

**The pattern application is legitimate, not cargo-cult.** `warmModerationRoutes` (helpers.ts:95) is the established precedent, consumed by `moderation.spec.ts` and `host-controls.spec.ts` inside their own `warmUp()` before seeding. `warmTvRoutes` mirrors it faithfully:

- `GET /${roomId}/tv` — compiles the page route that I just proved resets the store.
- `GET /api/queue${roomQuery}` — the endpoint the TV client polls.
- `advanceOnce(...)` — compiles `/api/queue/advance`. This one is *load-bearing*, not filler: in `tv-watchdog.spec.ts` the watchdog fires an advance **mid-test**; if that were the route's first compile, the store would reset mid-assertion. Warming it removes that vector.

Wiring is correct in both specs: `test.beforeEach` calling `warmTvRoutes(page.request)`, which Playwright runs before every test body, hence before every seed. `tv.spec.ts` previously had **no** warm-up at all, unlike five other specs in the suite — that gap is a plausible and sufficient explanation for the branch-only flake.

## 3. Timeouts were not inflated to mask flake — VERIFIED

Each change reviewed individually:

- `tv.spec.ts:53`, `tv.spec.ts:70`, `tv.spec.ts:148`, `tv-watchdog.spec.ts:110`, `tv-watchdog.spec.ts:144` — `{ timeout: 10_000 }` added to the **first** assertion after each `page.goto()`. 5s → 10s is a bounded 2x on exactly the assertion that must absorb a cold SSR render on a slow runner. Not a blanket 30s, and not applied to downstream assertions, which correctly keep the 5s default.
- `tv.spec.ts:176-186` — the meaningful one. Old code:
  ```
  await page.waitForTimeout(4600);
  await expect(chrome).toHaveClass(/chromeHidden/);
  ```
  New code:
  ```
  await expect(chrome).toHaveClass(/chromeHidden/, { timeout: 8000 });
  ```
  This is a genuine improvement, not a longer sleep. `CHROME_HIDE_MS = 4000` (`components/tv/TvScreen.tsx:65`), so the old fixed sleep left only a **600 ms** margin over the component's own timer, and the follow-up assert was one-shot — a slow runner blows it deterministically. The replacement is a web-first polling assertion that returns as soon as the class lands (typically ~4s, i.e. often *faster* than the old 4600ms sleep) and only spends the 8s on a genuinely slow machine.

  I verified the cursor coupling the ticket relies on. Both classes derive from the **same** `chromeVisible` state in the **same** render (`TvScreen.tsx`):
  ```
  650:  className={`${styles.tv} ${!chromeVisible ? styles.cursorHidden : ""}`}   // data-testid="tv-root"
  762:  className={`${styles.chrome} ${!chromeVisible ? styles.chromeHidden : ""}`} // data-testid="tv-chrome"
  ```
  and `.cursorHidden { cursor: none !important }` (`tv.module.css:42-44`). So waiting for `chromeHidden` guarantees the subsequent non-retrying `getComputedStyle(...).cursor === "none"` read — they commit together. The class-driven approach is sound.

## 4. My own test runs

All from `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-65`.

### Run 1 — `PORT=3165 npx playwright test e2e/tv.spec.ts e2e/tv-watchdog.spec.ts --reporter=line`

```
Running 6 tests using 1 worker

[1/6] [chromium] › e2e/tv-watchdog.spec.ts:96:7 › /tv watchdog (TICKET-41) › onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action
[2/6] [chromium] › e2e/tv-watchdog.spec.ts:137:7 › /tv watchdog (TICKET-41) › onError 100 (video removed) also skips; non-fatal codes do not
[3/6] [chromium] › e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6)
[4/6] [chromium] › e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1)
[5/6] [chromium] › e2e/tv.spec.ts:121:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2)
[6/6] [chromium] › e2e/tv.spec.ts:174:7 › /tv › chrome auto-hides and the cursor goes with it
  6 passed (38.7s)
```

### Run 2 — same command, fresh dev server

```
Running 6 tests using 1 worker

[1/6] [chromium] › e2e/tv-watchdog.spec.ts:96:7 › /tv watchdog (TICKET-41) › onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action
[2/6] [chromium] › e2e/tv-watchdog.spec.ts:137:7 › /tv watchdog (TICKET-41) › onError 100 (video removed) also skips; non-fatal codes do not
[3/6] [chromium] › e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6)
[4/6] [chromium] › e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1)
[5/6] [chromium] › e2e/tv.spec.ts:121:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2)
[6/6] [chromium] › e2e/tv.spec.ts:174:7 › /tv › chrome auto-hides and the cursor goes with it
  6 passed (31.5s)
```

### Run 3 — same command against a server I owned (so I could probe state afterwards)

```
Running 6 tests using 1 worker

[1/6] [chromium] › e2e/tv-watchdog.spec.ts:96:7 › /tv watchdog (TICKET-41) › onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action
[2/6] [chromium] › e2e/tv-watchdog.spec.ts:137:7 › /tv watchdog (TICKET-41) › onError 100 (video removed) also skips; non-fatal codes do not
[3/6] [chromium] › e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6)
[4/6] [chromium] › e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1)
[5/6] [chromium] › e2e/tv.spec.ts:121:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2)
[6/6] [chromium] › e2e/tv.spec.ts:174:7 › /tv › chrome auto-hides and the cursor goes with it
  6 passed (25.2s)
== suite done; probing REMAINING singer-skip budget immediately ==
first 429 after 0 successes -> budget remaining was 0
```

### Run 4 — `tv.spec.ts` alone, fresh server, with post-run state probe

```
Running 4 tests using 1 worker

[1/4] [chromium] › e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6)
[2/4] [chromium] › e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1)
[3/4] [chromium] › e2e/tv.spec.ts:121:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2)
[4/4] [chromium] › e2e/tv.spec.ts:174:7 › /tv › chrome auto-hides and the cursor goes with it
  4 passed (39.0s)
== store state after run (should be EMPTY if drains succeeded) ==
{"items":[],"nowPlaying":null,"paused":false,"mode":"full-karaoke","moderation":false}
== remaining singer-skip budget ==
remaining budget was 4
```

**4 runs, 22/22 tests passed, zero failures, zero retries.**

## 5. Follow-up RAISED (now RESOLVED — see §6): the warm-up consumed advance rate-limit budget

> **Status: FIXED in-review and re-verified.** The analysis below is the original finding, kept for the record. §6 documents the fix and my re-verification.

`lib/advance-rate-limit.ts` caps **non-`unplayable`** advances at `ADVANCE_ROOM_MAX = 12` per room per 60s, and `app/api/queue/advance/route.ts` charges the limiter **unconditionally, before** any empty-queue check — there is no dev/test bypass. I confirmed the ceiling empirically against a fresh server:

```
advance 1..12 -> 200
advance 13 -> 429
advance 14 -> 429
advance 15 -> 429
advance 16 -> 429
```

`warmTvRoutes`'s `advanceOnce` is a plain advance with no `reason`, so it charges the tight 12/60s anti-grief bucket, **once per test** via `beforeEach`. Measured consumption:

- `tv.spec.ts` alone (4 tests): consumed 8 of 12 (4 remaining), store left clean. Fine.
- `tv.spec.ts + tv-watchdog.spec.ts` (6 tests, 25s wall): **bucket fully exhausted, 0 remaining.**

Adding 6 warm advances is what pushes the combined run from comfortably under the ceiling to exactly at it. The failure mode if it tips over is quiet rather than loud: `drainQueue` (helpers.ts:133) ignores the response status, so a 429'd drain spins its full 60-iteration guard and then **returns leaving the store dirty**, leaking queue state into the next test — a new (smaller) order-dependent flake vector, in a ticket whose whole purpose is removing flake. Note the perverse incentive: a *faster* runner packs more advances into the 60s window, so this bites the fast machines, not the slow ones.

Cheap fixes, in order of preference:

1. **Charge the generous bucket.** Have `warmTvRoutes` issue its warm advance with `?reason=unplayable`, which `route.ts` routes to the separate `ADVANCE_UNPLAYABLE_ROOM_MAX = 40` bucket. One-line change, keeps the compile-warming benefit, stops competing with real drains for anti-grief budget.
2. **Warm once per file, not per test.** The compile-reset only happens on the *first* request; a module-scoped `let warmed = false` guard (or `beforeAll`) drops 5 of the 6 advances and cuts run time slightly.

Either would restore headroom. I'd suggest filing this as a small follow-up ticket rather than blocking.

### Minor notes (no action required)

- `warmTvRoutes` runs on every test including the ones that never seed (`idle`, `fullscreen`, `chrome auto-hide`). Harmless, and arguably correct for uniformity — it just feeds into the budget point above.
- The changes are uncommitted in the worktree. They need committing to the branch before a PR gate can run — flagging as a state observation, not a defect. I did not touch git state.

## 6. Re-review of the rate-limit fix — VERIFIED, follow-up CLOSED

The author took option 1 from §5. `advanceOnce` gained an optional 4th parameter and `warmTvRoutes` now charges the generous bucket:

```ts
export async function advanceOnce(
  request: APIRequestContext,
  roomId = DEFAULT_ROOM,
  rawHostCode?: string,
  reason?: "unplayable",
) {
  const q = roomQuery(roomId);
  const reasonParam = reason ? `${q ? "&" : "?"}reason=${reason}` : "";
  return request.post(`/api/queue/advance${q}${reasonParam}`, {
    headers: { [SCREEN_TOKEN_HEADER]: screenTokenFor(roomId, rawHostCode) },
  });
}
```

**Query-param construction is correct.** `roomQuery` returns `""` for the default room and `"?room=<id>"` otherwise, and the separator is chosen off exactly that: default room → `?reason=unplayable`, named room → `?room=x&reason=unplayable`. Both well-formed.

**Backward compatible.** `reason` is optional, so when omitted `reasonParam` is `""` and the produced URL is byte-identical to the pre-change one. I checked every caller in the suite — `submit-song.spec.ts:13`, `host-controls.spec.ts:43`, `advance-auth.spec.ts:35`, `advance-auth.spec.ts:38`, and `drainQueue` (`helpers.ts:151`) all pass 3 args or fewer, so none change behavior. `drainQueue` deliberately still charges the singer-skip bucket, which is right: a real drain *is* a real skip and should be accounted as one. Only the synthetic warm-up moved buckets.

**Type-safe.** The parameter is narrowed to the literal `"unplayable"`, and the server's allowlist is `const ADVANCE_SKIP_REASONS = new Set(["unplayable"])` (`app/api/queue/advance/route.ts:12`) — the only accepted value. A typo is a compile error rather than a silently-ignored reason that falls back to the tight bucket.

**Typecheck:** `npx tsc --noEmit` → zero errors in `e2e/helpers.ts`, `e2e/tv.spec.ts`, `e2e/tv-watchdog.spec.ts`.

**Zero product source, still:** `git diff --stat` remains the same three e2e files (`e2e/helpers.ts` 35 lines, `e2e/tv-watchdog.spec.ts` 15, `e2e/tv.spec.ts` 32). Nothing under `app/`, `lib/`, `components/`.

### Run 5 — post-fix

```
Running 6 tests using 1 worker
[1/6] [chromium] › e2e/tv-watchdog.spec.ts:96:7 › /tv watchdog (TICKET-41) › onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action
[2/6] [chromium] › e2e/tv-watchdog.spec.ts:137:7 › /tv watchdog (TICKET-41) › onError 100 (video removed) also skips; non-fatal codes do not
[3/6] [chromium] › e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6)
[4/6] [chromium] › e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1)
[5/6] [chromium] › e2e/tv.spec.ts:121:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2)
[6/6] [chromium] › e2e/tv.spec.ts:174:7 › /tv › chrome auto-hides and the cursor goes with it
  6 passed (23.2s)
```

### Run 6 — post-fix, owned server, with the decisive budget probe

```
Running 6 tests using 1 worker
[1/6] [chromium] › e2e/tv-watchdog.spec.ts:96:7 › /tv watchdog (TICKET-41) › onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action
[2/6] [chromium] › e2e/tv-watchdog.spec.ts:137:7 › /tv watchdog (TICKET-41) › onError 100 (video removed) also skips; non-fatal codes do not
[3/6] [chromium] › e2e/tv.spec.ts:46:7 › /tv › idle state renders the recruitment poster without errors (AC3, AC6)
[4/6] [chromium] › e2e/tv.spec.ts:64:7 › /tv › playing state: hero scale, max-3 rail, nothing under 28px (AC1)
[5/6] [chromium] › e2e/tv.spec.ts:121:7 › /tv › fullscreen affordance enters fullscreen and hides after (AC2)
[6/6] [chromium] › e2e/tv.spec.ts:174:7 › /tv › chrome auto-hides and the cursor goes with it
  6 passed (18.5s)
== store state after run (should be EMPTY) ==
{"items":[],"nowPlaying":null,"paused":false,"mode":"full-karaoke","moderation":false}
== REMAINING singer-skip budget (was 0 before the fix) ==
remaining singer-skip budget was 6
```

**The measurement that closes the finding:** the same probe that reported `remaining budget was 0` before the fix (§4 Run 3) now reports **6 of 12 remaining** after an identical full run, and the store is left clean. Half the anti-grief bucket is now free headroom instead of zero. The order-dependent dirty-store vector is gone.

**Running total: 6 full runs (36 tests) + 1 spec-isolated run (4 tests) = 40/40 passed, zero failures, zero retries.**

## Summary

Root cause independently reproduced from first principles, fix is a faithful application of the repo's own established `warmUp` precedent, timeouts bounded and one of them genuinely converted from a racy fixed sleep to a deterministic polling assertion, no product source touched. The one follow-up I raised was fixed in-review and I confirmed the fix empirically (rate-limit headroom 0 → 6). **APPROVE — nothing open.**
