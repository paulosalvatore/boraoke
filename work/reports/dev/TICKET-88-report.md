# TICKET-88 — dev report: deflaking `rotation-modes` and `render-and-links`

**Branch:** `ticket/88-rotation-modes-e2e-flake` (merged `origin/main` @ `5a06b48` before measuring)
**Port:** 3195. **Machine:** exclusive — no sibling agents running.

## Summary

The recorded root-cause class was **confirmed by measurement**, and the *specific* route responsible was identified: the first compile of **`/api/host/pending`** under `next dev` re-evaluates the in-memory store module and wipes both the room registry and the queue. `rotation-modes.spec.ts` never warmed that route, so its first compile happened **after** the test had created its room and seeded three entries.

The fix is warm-before-seed (the TICKET-65 pattern), applied to the right routes. **No timeout was added or inflated** — the diff is 84 insertions, 0 deletions, and contains no `timeout` / `waitForTimeout` / `setTimeout`.

## Reproduction

### Full suite, pre-fix (merged main): 3/3 GREEN

The reported "~1-in-3 full-suite" rate did **not** reproduce on an idle machine against current `main`:

| Run | `.next` | Result |
|---|---|---|
| 1 | cold (`rm -rf .next`) | 106 passed (5.7m) |
| 2 | warm | 106 passed (5.7m) |
| 3 | warm | 106 passed (5.5m) |

That is not a contradiction of the ticket — it is the explanation for the *intermittency*. See "Why it looked intermittent" below.

### Isolated `rotation-modes.spec.ts`, pre-fix: 3/3 RED

| Run | Failing assertion |
|---|---|
| 1 | `rotation-modes.spec.ts:93` — `expect(getByTestId("mode-toast")).toBeVisible()` |
| 2 | `rotation-modes.spec.ts:93` — same |
| 3 | `rotation-modes.spec.ts:93` — same |

Note that line 92 (`ATIVO` chip moves to `per-table-2`) **passes** — because `changeMode()` sets the chip *optimistically*, before the network call. The toast at line 93 renders only `if (res.ok)`. So the failure was already telling us: **the `POST /api/host/mode` did not succeed.**

### Isolated `render-and-links.spec.ts`, pre-fix: 3/3 GREEN

No failure of this file was reproducible at any point (isolated or full-suite). See "render-and-links" below for what was changed and why.

## Direct measurement of the mechanism

Rather than infer, the store lifecycle was instrumented (`work/evidence/TICKET-88/probe.spec.ts`, committed). It replays `rotation-modes`' own `warmUp`, then seeds, then hits each candidate route one at a time, re-reading the room record and the queue after each:

```
PROBE seed Alpha 201
PROBE seed Bravo 201
PROBE seed Charlie 201
PROBE after-seed:          roomRecord=200  queueLen=3
PROBE /api/host/session -> 200
PROBE after-host-session:  roomRecord=200  queueLen=3
PROBE /api/host/pending -> 401
PROBE after-host-pending:  roomRecord=404  queueLen=0     <-- store wiped
PROBE /api/host/mode    -> 401
PROBE after-mode:          roomRecord=404  queueLen=0
```

One `GET /api/host/pending` — the route's **first** compile in that dev process — takes the room from `200` to `404` and the queue from `3` entries to `0`. The subsequent `POST /api/host/mode` then `401`s (the room it authenticates against no longer exists), `res.ok` is false, the toast is never set, and line 93 fails.

**Verdict vs. the recorded theory: CONFIRMED, and narrowed.** It is the singleton reset, not a rate-limit interaction, not cross-spec pollution, not real timing. `/api/host/session` was already warm and provably harmless; `/api/host/pending` is the single culprit.

## Why `rotation-modes` never warmed it

`warmUp()` logs in with a deliberately bogus token (`{ token: "x" }`) before `page.goto("/default/admin")`. That renders the **unauthenticated login gate**, and the gate does not mount the authed dashboard. Only the authed `AdminRoom` mounts the 3-second poll of `/api/host/session` + `/api/queue` + **`/api/host/pending`** (`app/(patron)/[room]/admin/AdminRoom.tsx:151,164`). So the spec's warm-up compiled exactly half of the route it depends on, and the other half was compiled by the test body — after seeding.

## Why it looked intermittent (~1-in-3) rather than always-red

Playwright discovers spec files in sorted order with `workers: 1`. Three files that run **before** `rotation-modes` already call `warmModerationRoutes()`, which compiles `/api/host/pending`: `feedback-widget-safe-area`, `host-controls`, `moderation`. In a clean full-suite run the route is therefore already warm by the time `rotation-modes` starts, and the bug is masked.

**`rotation-modes` was depending on another file's warm-up for its own correctness.** Anything that perturbs that — a `--grep` filter, a `.only`, a skipped or reordered file, a new spec file sorting in between, a dev-server restart mid-run, or an edit to any of those three files causing a recompile — re-exposes it. That is exactly the profile of a test that fails "about one run in three" for reasons nobody can pin down, and it is why the failing assertion appeared to move between runs: *which* post-seed assertion dies depends on precisely when the async 3s poll lands relative to the test's next step.

## The fix

Warm-before-seed, reusing the existing shared helper rather than adding a parallel one.

1. **`e2e/helpers.ts`** — `warmModerationRoutes()` now also warms `GET /api/host/session` and `GET /api/queue`, the authed console's other two polled endpoints. Both are idempotent reads that were previously warm only as a *side effect* of some caller's flow; warming them explicitly removes that accidental coupling. A doc note records that the helper's name is historical — it is the authed-host-console warm-up, not a moderation-only one — with the rename deliberately declined because three specs already import it.
2. **`e2e/rotation-modes.spec.ts`** — `warmUp()` now calls `warmModerationRoutes(page.request)` as its **first** action, before any room creation or seeding.
3. **`e2e/render-and-links.spec.ts`** — same call added to `warmUp()`. This file was already green because its `DEV_TOKEN` warm-up login is a *valid* default-room login, so its `/default/admin` goto lands on the authed dashboard and compiles `/api/host/pending` as a side effect. That is a silent dependency on one token line staying valid — the identical latent gap that failed `rotation-modes` 3/3. Stating it explicitly costs nothing and stops the same bug re-landing here.

No new helper was introduced; the existing shared one is imported. No copy-paste.

### Effect on the TV specs (`warmTvRoutes` callers)

`e2e/helpers.ts` changes are additive only: two extra idempotent `GET`s inside `warmModerationRoutes`, plus comments. `warmTvRoutes`, `advanceOnce`, `drainQueue`, `screenTokenFor` and `TV_WARMUP_ROOM` are untouched — verify with `git diff origin/main...HEAD -- e2e/helpers.ts` (0 deletions). `tv.spec.ts` and `tv-watchdog.spec.ts` import only `warmTvRoutes` / `advanceOnce` / `drainQueue` and are unaffected. All three pre-existing `warmModerationRoutes` callers (`host-controls`, `moderation`, `feedback-widget-safe-area`) pass in all five post-fix full-suite runs.

## Verification

### Isolated `rotation-modes`, post-fix: 5/5 GREEN

`1 passed (9.1s)`, `(8.4s)`, `(8.8s)`, `(8.6s)`, `(8.7s)` — against 3/3 red before. This is the tightest causal evidence available: the isolated case is the one that was deterministically broken, and it is now deterministically green.

### Full suite, post-fix: 5/5 consecutive GREEN (foreground)

| Run | Result |
|---|---|
| 1 | 106 passed (5.6m) |
| 2 | 106 passed (5.6m) |
| 3 | 106 passed (5.6m) |
| 4 | 106 passed (5.5m) |
| 5 | 106 passed (5.6m) |

### Other gates

- **Cold build:** `rm -rf .next && npm run build` — succeeded (full route table emitted, middleware 33.8 kB). Not a warm incremental.
- **Unit tests:** `50 suites, 879 passed, 5 skipped`.
- **`tsc --noEmit` delta vs `main`:** **0.** 2756 lines on the branch, 2756 on `origin/main` (`tsconfig.tsbuildinfo` deleted on both sides; `main` checked out into a throwaway worktree). The whole 2756 is the known pre-existing `@types/jest` baseline.

### Zero product source touched

```
$ git diff --name-only origin/main...HEAD
e2e/helpers.ts
e2e/render-and-links.spec.ts
e2e/rotation-modes.spec.ts
work/events/by-branch/ticket-88-rotation-modes-e2e-flake.jsonl
work/evidence/TICKET-88/probe.spec.ts

$ git diff --name-only origin/main...HEAD | grep -E "^(app/|lib/|components/|middleware\.ts)"
(no matches)
```

84 insertions, 0 deletions.

## Product bug found and deliberately NOT fixed

None. Every symptom traced to the harness. Two things are worth recording as *not* product races:

- **The optimistic `ATIVO` chip** (`AdminRoom.tsx:236`, `setMode(next)` before the `fetch`) means the chip moves even when the server rejects the change. That is intentional optimistic UI and the queue-order assertion downstream is the real check — but it is why the spec's *first* red line was the toast rather than the mode switch, and it means the chip assertion on its own has no teeth. Not a bug; noted so the next reader does not re-chase it.
- **`mode-toast` auto-dismisses after 4000 ms** while Playwright's default `expect` timeout is 5000 ms. Under heavy machine load a slow `POST` could in principle let the toast appear and expire inside one assertion window. Not observed in any of the 11 runs here, and inflating that timeout would be exactly the papering-over this ticket forbids, so it is left alone and recorded instead.

## Deliberately not changed

`crawlLinks()` in `render-and-links.spec.ts` uses a fixed `page.waitForTimeout(300)` before harvesting `<a href>`s. This is a code smell, but it fails **open**, not flaky-red: if client components have not rendered, fewer links are collected and the test passes vacuously. It weakens coverage rather than causing the reported flake, so replacing it is out of scope here and belongs in its own ticket.
