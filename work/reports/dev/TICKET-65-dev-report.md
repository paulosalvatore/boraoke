# TICKET-65 — Dev Report — Deflake the `/tv` e2e specs

**Status:** Implemented, self-verified (5/5 fresh consecutive runs green, `npx tsc --noEmit` clean on all changed files), reviewer round applied. Test-infrastructure only — zero product source touched.

## Symptom

`e2e/tv.spec.ts` failed twice on CI on a branch snapshot, on two *different* assertions, while the identical code passed 3+ consecutive runs on `main`. Recorded as a MED finding in the 2026-07-06 retroactive CI audit, never fixed.

## Root-cause diagnosis (confirmed, not assumed)

The recorded hypothesis was that `next dev` route compilation resets the in-memory store singleton mid-e2e (TICKET-7's `warmUp()` precedent exists for exactly this), plus fixed waits too tight for slow CI. I reproduced the singleton-reset mechanism directly before writing any fix:

```
seed via POST /api/queue → {"ok":true}
GET /api/queue (already-compiled route) → 1 item present
GET /default/tv for the FIRST TIME in a fresh dev-server process → 200
GET /api/queue again → {"items":[],"nowPlaying":null,...}
```

The seeded queue entry, visible via an already-compiled `/api/queue`, vanished purely because `/default/tv` compiled for the first time — confirming the documented `next dev` per-route-bundle singleton-reset caveat applies to the `/[room]/tv` **page** route, not just API routes. `tv.spec.ts` and `tv-watchdog.spec.ts` had **no** warm-up at all, unlike five other specs in this suite (`moderation.spec.ts`, `host-controls.spec.ts`, `render-and-links.spec.ts`, `rooms.spec.ts`, `rotation-modes.spec.ts`) that already follow the TICKET-7/44 `warmUp()` pattern. That gap is the confirmed root cause — matches the recorded theory.

## What changed

Three e2e-only files, no product source (`app/`, `lib/`, `components/` untouched):

- **`e2e/helpers.ts`** — new exported `warmTvRoutes(request, roomId)`: warm-compiles `GET /${roomId}/tv`, `GET /api/queue`, and a warm `advanceOnce(...)` (compiles `/api/queue/advance`) BEFORE any seeding. Also extended `advanceOnce` with an optional 4th `reason?: "unplayable"` param (backward-compatible — existing callers unaffected) so the warm-up advance charges the generous 40/room/60s unplayable rate-limit bucket instead of the tight 12/room/60s anti-grief singer-skip bucket (a follow-up the opus Reviewer caught: firing the warm-up advance once per test via `beforeEach` would otherwise exhaust the tight bucket across a multi-test run and leave the store dirty for later tests — a new, smaller flake vector).
- **`e2e/tv.spec.ts`** — added `test.beforeEach` calling `warmTvRoutes(page.request)`; bumped the first post-`goto` assertion in each test to `{ timeout: 10_000 }` (bounded 2x over Playwright's 5s default, not a blanket inflation); replaced a hard `page.waitForTimeout(4600)` + one-shot assert with a single deterministic `expect(chrome).toHaveClass(/chromeHidden/, { timeout: 8000 })` — a genuine determinism improvement (Playwright web-first assertion polls until true or timeout) rather than a bigger sleep. Verified `chromeHidden`/`cursorHidden` derive from the same `chromeVisible` state in `components/tv/TvScreen.tsx`, so waiting for the class covers the cursor assertion too.
- **`e2e/tv-watchdog.spec.ts`** — same `beforeEach` warm-up; same bounded `{ timeout: 10_000 }` bump on the first post-`goto` assertion in each test.

## Verification

`npx tsc --noEmit`: no errors in any of the three changed files (pre-existing unrelated noise in `__tests__/youtube.test.ts` and `e2e/advance-auth.spec.ts` — confirmed present on `main` too via `git stash`, not introduced by this change).

**5 consecutive fresh runs** of `PORT=3165 npx playwright test e2e/tv.spec.ts e2e/tv-watchdog.spec.ts --reporter=line`, each against a cold `next dev` process (no route pre-warmed by a prior run — the exact condition that reproduced the bug):

```
Run 1: 6 passed (25.7s)
Run 2: 6 passed (24.3s)
Run 3: 6 passed (25.3s)
Run 4: 6 passed (23.9s)
Run 5: 6 passed (56.8s)
```

After the rate-limit-bucket follow-up fix, ran 5 more fresh runs to confirm:

```
Run 1: 6 passed (25.2s)
Run 2: 6 passed (26.1s)
Run 3: 6 passed (25.9s)
Run 4: 6 passed (24.8s)
Run 5: 6 passed (26.0s)
```

30/30 tests green across 10 total fresh-process runs.

## Reviewer (round 1 — TV specs in isolation only)

Opus Reviewer (clean context) — independently reproduced the singleton-reset mechanism itself via curl, confirmed zero product source touched, confirmed timeouts were bounded and justified (not masking-by-inflation), confirmed the chrome-hide rewrite is a real determinism improvement, and re-ran the specs itself. Caught the rate-limit-bucket exhaustion risk described above. See `work/reports/review/TICKET-65-review.md` for that round's verdict.

**This round's APPROVE was issued with no full-suite run behind it** — all verification (mine and the Reviewer's) ran `e2e/tv.spec.ts` + `e2e/tv-watchdog.spec.ts` in isolation. The TM ran the full suite independently and found the branch red in a spec neither of us touched (`host-controls.spec.ts`, timing out mid-`warmUp`) while an equivalent baseline run was green — evidence the isolated-spec protocol could not have caught. See the next section.

## Full-suite investigation (TM-directed, post-APPROVE)

**Setup for a like-for-like comparison:** rebased `ticket/65-tv-e2e-deflake` onto current `origin/main` (`3888ee3`, which already carries TICKET-64/60/63) — no conflicts. Baseline: a dedicated worktree `.worktrees/baseline-65` checked out straight to `origin/main`, `npm ci`'d independently, run on a different port (3166) so it can never collide with the branch worktree (3165). Both trees: 63 tests / 16 files (2 always-skipped `test.fixme` in `contrast.spec.ts`, unrelated to this ticket → 61 runnable).

Ran `PORT=<port> npx playwright test --reporter=line` (i.e. the full suite, not scoped to the TV specs) to completion, foreground, one run at a time, no overlapping runs:

| # | Tree | Passed | Failed | Skipped | Wall time | Failing test |
|---|------|--------|--------|---------|-----------|---------------|
| B1 | branch (pre-fix) | 61 | 0 | 2 | 4.2m | — |
| B2 | branch (pre-fix) | 61 | 0 | 2 | 3.5m | — |
| B3 | branch (pre-fix) | 61 | 0 | 2 | 3.2m | — |
| B4 | branch (pre-fix) | 61 | 0 | 2 | 3.0m | — |
| B5 | branch (pre-fix) | 60 | **1** | 2 | 3.2m | `e2e/tv-watchdog.spec.ts:96` — `apiRequestContext.get: read ECONNRESET` on a plain `GET /api/queue` inside the pre-existing (unmodified-by-this-ticket) `drainQueue` helper |
| C1 | baseline (`origin/main`) | 61 | 0 | 2 | 3.5m | — |
| C2 | baseline (`origin/main`) | 61 | 0 | 2 | 2.9m | — |
| C3 | baseline (`origin/main`) | 61 | 0 | 2 | 2.8m | — |

(A discarded 0th branch attempt, run while the baseline worktree's `npm ci`/Playwright-browser install was still finishing in parallel, crashed the dev server outright — every test after #13 failed with `ECONNREFUSED`. Treated as environmentally contaminated, not counted as evidence either way, and not repeated: all runs above ran with nothing else installing/building concurrently.)

**Reading the result:** 1/5 branch runs failed, 0/3 baseline runs failed. The failure was NOT the same symptom the TM's own run hit (`host-controls.spec.ts` timing out on `page.getByLabel("Código do host").waitFor()`) — it was a raw network reset on a `GET` inside `drainQueue`, in a spec this ticket does touch. Both symptoms share a shape: a full-suite-only, network/infra-level failure (timeout or reset) rather than a logic/assertion mismatch, in code that was fine every time in isolation. That is consistent with the TM's hypothesis — `warmTvRoutes()`'s extra per-test traffic against `DEFAULT_ROOM` (shared with `host-controls.spec.ts`, `moderation.spec.ts`, `render-and-links.spec.ts`, `rooms.spec.ts`, and others) adding contention/load that a full run exposes and an isolated 2-file run cannot. One occurrence in 5 runs is a small sample — not proof of causation on its own — but it points the same direction the TM's independent run did, so treated it as implicated rather than dismissed as a coincidence.

**Fix: stop touching `DEFAULT_ROOM` for warm-up at all.** `warmTvRoutes()` now issues all three warm requests (`GET /<room>/tv`, `GET /api/queue`, the warm `advanceOnce`) against a dedicated synthetic room id, `TV_WARMUP_ROOM = "tv-warmup-e2e"`, never the room a test actually seeds/asserts against. This is sound because compilation under `next dev` is a process-wide, per-ROUTE-FILE event, not a per-room-value event: `GET /tv-warmup-e2e/tv` compiles the identical `/[room]/tv` page bundle `GET /default/tv` would have, so the warm-up keeps its full compile-forcing effect. The function signature dropped its `roomId` parameter entirely (it was previously called with none — `DEFAULT_ROOM` was only ever the implicit default), since a caller never needs to name its own room for a warm-up that's now always room-agnostic. This is strictly a superset improvement over the earlier `reason=unplayable`-bucket fix (kept) — it removes ALL interference on `DEFAULT_ROOM`'s queue state and BOTH rate-limit buckets, not just the tight one.

**Post-fix verification — 5 more full-suite branch runs, foreground, back to back:**

| # | Tree | Passed | Failed | Skipped | Wall time |
|---|------|--------|--------|---------|-----------|
| P1 | branch (post-fix) | 61 | 0 | 2 | 2.8m |
| P2 | branch (post-fix) | 61 | 0 | 2 | 2.8m |
| P3 | branch (post-fix) | 61 | 0 | 2 | 2.8m |
| P4 | branch (post-fix) | 61 | 0 | 2 | 2.9m |
| P5 | branch (post-fix) | 61 | 0 | 2 | 2.7m |

5/5 clean post-fix, and noticeably faster/tighter wall-clock spread (2.7–2.9m vs. 3.0–4.2m pre-fix) — consistent with removing contention, though not itself proof. `npx tsc --noEmit` re-checked clean on all three changed files after the fix.

**Honest caveat:** total sample is 10 branch full-suite runs (5 pre-fix, 5 post-fix) plus 3 baseline, all on one machine that is also running several sibling agents' dev servers concurrently (an uncontrolled variable this investigation could not isolate). One pre-fix failure in 5 runs, and zero in the following 8 (5 post-fix + none recurring), is suggestive but not an airtight statistical case. The fix is adopted on its own merits regardless — it is strictly safer (zero interference with any real room, by construction) and costs nothing — not solely because 5/5 came back clean once.

## Out of scope / not a product bug

No genuine product race was found — every full-suite failure observed (this investigation's ECONNRESET, and the TM's original `host-controls` timeout) was network/infra-level under full-suite load, not a reproducible logic bug in product code, and none recurred against the fixed helper. Nothing deferred as a product finding.
