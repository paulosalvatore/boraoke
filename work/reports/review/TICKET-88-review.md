# TICKET-88 — Reviewer report (independent, clean context)

**Branch:** `ticket/88-rotation-modes-e2e-flake` (worktree `.worktrees/ticket-88`)
**Port:** 3195 throughout. Machine exclusive to this review.
**Posture:** every claim below was re-derived by my own measurement. The dev report was read but not taken as evidence.

## 1. Root cause — independently re-derived, CONFIRMED

I did not re-run the dev's committed probe. I wrote my own (`e2e/zz-review-probe.spec.ts`, scratch, deleted afterwards) that replays the **pre-fix** `rotation-modes` `warmUp()` verbatim, creates a room, seeds three entries, then hits one candidate route at a time, re-reading the room record and the queue after each. Result on a freshly restarted dev server:

```
PROBE seed Alpha 201
PROBE seed Bravo 201
PROBE seed Charlie 201
PROBE after-seed:          roomRecord=200  queueLen=3
PROBE GET /api/host/session -> 401
PROBE after-host-session:  roomRecord=200  queueLen=3
PROBE GET /api/host/pending -> 401
PROBE after-host-pending:  roomRecord=404  queueLen=0     <-- store wiped
PROBE POST /api/host/mode  -> 401
PROBE after-mode:          roomRecord=404  queueLen=0
```

So, established by my own measurement:

- **(a) The pre-fix spec fails deterministically in isolation.** I checked `origin/main`'s `e2e/rotation-modes.spec.ts` into a scratch file under `e2e/` (byte-identical to the base version, verified with `diff`) and ran it alone, killing the dev server between runs so each got a fresh Next process: **3/3 RED**, every time at the same line — `rotation-modes.spec.ts:93`, `expect(getByTestId("mode-toast")).toBeVisible()`, "element(s) not found".
- **(b) The first `GET /api/host/pending` is what destroys the seeded state.** `/api/host/session` immediately before it is provably harmless (room 200, queue 3 → room 200, queue 3). One `GET /api/host/pending` takes room 200→404 and queue 3→0. Note the wipe happens even though the request itself **401s** — this is compile-time module re-evaluation, not anything the handler does. That kills the "it's really an auth/rate-limit interaction" alternative hypothesis outright.
- **(c) The post-fix spec does not fail.** Post-fix `rotation-modes.spec.ts` run alone, fresh server each time: **3/3 GREEN** (9.8s / 8.0s / 8.4s).

The causal chain the dev asserts holds up: bogus-token warm-up login → `/default/admin` renders the *unauthenticated gate* → the authed `AdminRoom` poll (`app/(patron)/[room]/admin/AdminRoom.tsx:151,164`) never mounts → `/api/host/pending` stays uncompiled until the test's own post-seed `goto(/<roomId>/admin)` → first compile resets the in-memory singletons → `POST /api/host/mode` 401s → `res.ok` false → toast never set → line 93 fails. I verified `changeMode` only sets `modeMsg` inside `if (res.ok)` (`AdminRoom.tsx:243-247`), which is why the toast is the assertion that dies.

The "why intermittent" explanation also checks out on inspection: with `workers: 1` and sorted file order, `contrast`, `feedback-widget-safe-area`, `host-controls` and `moderation` all sort before `rotation-modes` and all compile `/api/host/pending` (three via `warmModerationRoutes`, `contrast` as a side effect of an authed `/default/admin`). The spec was borrowing another file's warm-up.

**Scratch cleanup:** both scratch specs deleted; `git status --porcelain` is empty and `ls e2e/` matches the base file set exactly (19 entries, no `zz-review-*`).

## 2. Full suite — 3 independent runs, all foreground, all GREEN

| Run | Conditions | Result |
|---|---|---|
| 1 | fresh dev server, warm `.next` | **106 passed (6.0m)** |
| 2 | server reused from run 1 | **106 passed (5.4m)** |
| 3 | `rm -rf .next`, fresh server (cold compile) | **106 passed (5.3m)** |

Zero failures, zero flakes, zero retries (`retries: 0` in the config, unchanged). Run 3 was deliberately cold to exercise the worst case for the compile-reset mechanism. Combined with the dev's own 5/5, the ticket's "5 consecutive full-suite runs green" bar is met and then some.

## 3. Zero product source touched — CONFIRMED

`git diff --name-only origin/main...HEAD`:

```
e2e/helpers.ts
e2e/render-and-links.spec.ts
e2e/rotation-modes.spec.ts
work/events/by-branch/ticket-88-rotation-modes-e2e-flake.jsonl
work/evidence/TICKET-88/probe.spec.ts
work/reports/dev/TICKET-88-report.md
```

Nothing under `app/`, `lib/`, `components/`, or `middleware.ts`. `playwright.config.ts` is **not** in the list either — the suite-level `timeout: 30_000`, `retries: 0` and `workers: 1` are untouched. Diffstat: **217 insertions, 0 deletions** across 6 files (the three `e2e/` files account for 48 of those; the rest is the dev report, event log and the committed probe). Zero deletions means nothing existing was weakened or removed.

`work/evidence/TICKET-88/probe.spec.ts` lives under `work/`, outside `testDir: "./e2e"`, so it is inert — it does not join the suite.

## 4. Timeouts were NOT inflated — CONFIRMED

I grepped the added lines of `git diff origin/main...HEAD -- e2e/` for `timeout|retr|waitFor|setTimeout|poll|slow`. **Every single hit is inside a comment** — "a 3s poll of `/api/host/pending`", "the authed console's other two polled endpoints", etc. There is no added or raised `timeout:` option, no `waitForTimeout`, no `setTimeout`, no retry count, no slowed polling, and no `expect.poll` interval change anywhere in the diff. The three added executable statements are, in total, `request.get("/api/host/session")`, `request.get("/api/queue")` and two `warmModerationRoutes(...)` calls. This is a structural fix (compile-before-seed), not a papering-over. Clean pass on the ticket's explicit prohibition.

## 5. Blast radius of the `e2e/helpers.ts` change — acceptable, and I measured the one real risk

The change to `warmModerationRoutes()` is two prepended idempotent `GET`s (`/api/host/session`, `/api/queue`) plus comments. `warmTvRoutes`, `advanceOnce`, `drainQueue`, `screenTokenFor`, `TV_WARMUP_ROOM` are byte-untouched (0 deletions in the file), so `tv.spec.ts` / `tv-watchdog.spec.ts` cannot be affected — they import only `warmTvRoutes` / `advanceOnce` / `drainQueue`.

For the three pre-existing callers (`host-controls:33`, `moderation:26`, `feedback-widget-safe-area:124`): I checked each call site's surrounding context. All three log in with the dev token **before** calling the helper, so the two new `GET`s are authenticated idempotent reads that those specs were already performing anyway (all three call `GET /api/queue` explicitly within a few lines). No behavioural change.

**The one thing that genuinely needed measuring** — the concern that `warmModerationRoutes`' `POST /api/host/moderation {moderation:false}` now runs in `render-and-links.spec.ts` while that context IS authenticated to the `default` room, and could leak moderation state into a later-sorted spec. I probed it live rather than reasoning about it:

```
PROBE default room record=404  POST /api/host/moderation{false} -> 404 {"error":"Room not found"}
```

The `default` room has **no room record** in dev/test (it keys off the dev-fallback token — see `helpers.ts:13-19` and `lib/rooms.ts:450-477`), so `setRoomModeration` returns `null` and the route 404s without mutating anything. The write is a no-op. Two further independent reasons it could not have mattered anyway: `getRoomModeration` normalizes a missing flag to `false`, so `{moderation:false}` is the default state; and `moderation.spec.ts` / `feedback-widget-safe-area.spec.ts` both enable moderation on **their own created rooms**, never on `default`. No leak into `rooms`, `rotation-modes`, `saved-rooms`, `search`, `served-lang`, `submit-song`, `telemetry`, `tv-watchdog` or `tv` (the files sorting after `render-and-links`). Empirically corroborated by 3/3 full-suite green.

## 6. Reusability — genuine, and the flake is removed rather than relocated

No new helper was introduced and there is no copy-paste: both specs import the existing shared `warmModerationRoutes`. The helper's misleading historical name is handled the right way — a doc caveat explaining that it is really the authed-host-console warm-up, with the rename explicitly declined because three specs already import it. I agree with that call: a rename here would churn four files for zero behavioural gain, and the caveat is where a reader will actually look.

The fix does not relocate the flake. The warm call is the **first** statement of each `warmUp()`, strictly before any room creation or seeding, so there is no post-seed compile left in either spec's path. The mechanism is eliminated for these files, not moved later in them.

**One residual gap, non-blocking (see §8).** The dev's stated principle for touching the already-green `render-and-links.spec.ts` — "it survived only by accident, because its `DEV_TOKEN` login happens to be a valid default-room login, so its `/default/admin` goto compiles the route as a side effect; state the guarantee rather than inherit it" — applies **verbatim and unchanged** to `contrast.spec.ts`, which was not touched. Its `warmUp()` (`contrast.spec.ts:236-247`) is the same shape: valid `DEV_TOKEN` login, then `goto("/default/admin")`, and its `admin room contrast` describe block (line 458+) creates a room and logs in, so it carries the same latent exposure. `contrast` also sorts **second** in the suite, which makes it the file most often doing the accidental warming for everyone downstream. Applying the principle to two of the three files that inherit the guarantee, and not the third, is an inconsistency worth closing — but `contrast` is green in all three of my full-suite runs and this is beyond the ticket's stated scope, so it is a follow-up, not a merge blocker.

## 7. Product races — my own view

I formed my own judgement on the two items the dev flags as non-bugs, and looked for anything the dev may have reshaped a test around.

**Optimistic `ATIVO` chip — agree, not a bug.** `changeMode` (`AdminRoom.tsx:233-254`) does `setMode(next)` before the fetch, and unlike its sibling `toggleModeration` (line 280-291) it has no explicit `setModeration(prev)` rollback. But it calls `await fetchQueue()` on **both** the success and the catch path, unconditionally, and `fetchQueue` re-reads server truth including `if (data.mode) setMode(data.mode)` (line 140). So the chip reconciles immediately after the request settles, and the 3s poll (line 164) is a second safety net. Not a race, not a defect. The dev's secondary point is also correct and useful: because the chip is optimistic, the chip assertion at spec line 92 has no teeth on its own, and the toast at line 93 is the real server-confirmation signal — which is precisely why the toast was the assertion that died. The dev did **not** weaken or reshape that assertion; it stands untouched.

One genuine but minor UX observation, worth recording rather than fixing here: on a failed `POST /api/host/mode` the host gets **no error feedback at all** — `modeMsg` is only set inside `if (res.ok)`, the chip silently snaps back, and nothing tells the host the switch was rejected. That is an inconsistency with the adjacent moderation toggle, not the cause of anything in this ticket.

**`mode-toast` 4000ms auto-dismiss vs Playwright's 5000ms default expect timeout — agree, not a product bug, and correctly left alone.** `window.setTimeout(() => setModeMsg(""), 4000)` is deliberate toast UX. The theoretical window (a `POST` slow enough that the toast appears and expires inside one 5s assertion window) did not occur in any of my 6 runs (3 isolated + 3 full-suite) or the dev's 11. Critically, the correct response was *not* to raise the expect timeout — that is exactly the papering-over the ticket forbids — and the dev correctly recorded it instead of "fixing" it. I concur.

**Anything hidden?** I looked specifically for a real product race that a test change might be masking. There isn't one here: the failure is a *dev-server-only* artifact of the in-memory driver's module re-evaluation on first compile — it cannot occur against the durable Upstash driver production uses, and my probe showed the wipe happens on a request that 401s, i.e. before any product logic runs. The fix changes only *when* a route is compiled, never what any assertion demands. No assertion was loosened, removed, or made conditional (0 deletions in the diff proves this mechanically).

`crawlLinks()`'s fixed `page.waitForTimeout(300)` in `render-and-links.spec.ts` is pre-existing (not in this diff) and the dev's read is right — it fails *open*, weakening coverage rather than causing red flakes, so it belongs in its own ticket.

## 8. Recommended follow-ups (non-blocking, do not hold this PR)

1. Apply the same explicit `warmModerationRoutes` call to `contrast.spec.ts`'s `warmUp()`, for the identical "stated rather than inherited" reason given for `render-and-links` (§6).
2. Give `changeMode` a visible failure path (an error toast), matching `toggleModeration`'s explicit rollback (§7).
3. Replace `crawlLinks()`'s fixed `waitForTimeout(300)` with a real wait condition — a coverage-strength issue, not a flake.

## Verdict

**APPROVE**

Reasons: the causal claim is not merely plausible, it is **measured, and I measured it myself** — `/api/host/pending`'s first compile is the sole route that wipes the seeded store, `/api/host/session` demonstrably does not, and the wipe reproduces on a 401 request, which rules out the auth/rate-limit and real-timing alternatives. The pre-fix spec is 3/3 deterministically red in isolation at a fixed line; the post-fix spec is 3/3 green; the full suite is 3/3 green including one cold-`.next` run, on top of the dev's 5/5. Zero product source touched, `playwright.config.ts` untouched, zero deletions anywhere in the diff, and **no timeout, retry, wait or polling value was added or raised** — every regex hit for those terms is inside an explanatory comment. The one real blast-radius risk (an authed `POST /api/host/moderation` newly firing in `render-and-links`) I probed live and found to be a 404 no-op against a room that has no record, corroborated by the green suite. The fix reuses the existing shared helper with no duplication, is placed strictly before all seeding so the flake is eliminated rather than relocated, and both of the dev's flagged non-bugs are, on my own reading of `AdminRoom.tsx`, genuinely not bugs. The three follow-ups above are consistency and polish items that do not warrant holding a change that is this well evidenced.
