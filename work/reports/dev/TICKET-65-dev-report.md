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

## Reviewer

Opus Reviewer (clean context) — independently reproduced the singleton-reset mechanism itself via curl, confirmed zero product source touched, confirmed timeouts were bounded and justified (not masking-by-inflation), confirmed the chrome-hide rewrite is a real determinism improvement, and re-ran the specs itself. Caught the rate-limit-bucket exhaustion risk described above. See `work/reports/review/TICKET-65-review.md` for the full verdict.

## Out of scope / not a product bug

No genuine product race was found — the flake was entirely a test-harness artifact (missing warm-up + tight default timeouts), consistent with the recorded theory. Nothing was deferred as a product finding.
