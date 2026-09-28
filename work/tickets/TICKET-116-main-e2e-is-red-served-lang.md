# TICKET-116 — `main`'s e2e suite is RED: the venue TV does not serve the room's language, and nothing was catching it

**Filed:** 2026-09-28, found while re-gating PR #84 against a freshly-merged `main`.
**Priority:** HIGH — not for the failing test itself, but because it proves regressions reach `main` unnoticed.
**Type:** Bug + gate gap
**Size:** M

## What

`e2e/served-lang.spec.ts:105` — *"the venue TV serves the ROOM's language, never the visitor's"* (TICKET-79) — **fails on `main`, deterministically.** Measured 3 runs out of 3 in a clean detached worktree at `main`, on two different ports, with every other test in that file passing. It is not a flake.

The assertion is that `/{room}/tv` served with `Accept-Language: es-ES,es;q=0.9` returns `lang="en"` — the **room's** language, never the visitor's.

## Why this is HIGH despite being one test

**The failing test is the smaller half of the finding. The larger half is that nobody knew.**

Boraoke has no gate that runs this suite:
- There is **no code-review bot** on this repo (the only actor on PRs is `vercel`, a deployment bot).
- `verify-green-local.sh` — the house's authoritative merge gate under D-051 — runs `md-doctor` and `shell-tests`, **neither of which exists in boraoke**.
- GitHub Actions is deliberately minimal and advisory-only (D-051) and does not run e2e.

So the e2e suite runs **only when an agent chooses to run it**, which means a regression lands on `main` and sits there silently until someone re-gates for an unrelated reason. That is exactly what happened: this was found only because a merge-sync pulled new code into PR #84 and the TM re-ran the suite rather than quoting the PR's earlier numbers.

**The product behaviour at stake is real, not cosmetic.** TICKET-79 exists because a venue TV showing the *visitor's* language rather than the room's is wrong — the TV is the venue's screen, shared by a room of people, and its language is a property of the venue, not of whoever last loaded it. If this is a genuine regression rather than a broken test, a venue in Brazil could be showing an English or Spanish interface.

## What's needed

1. **Establish which it is:** a real regression in served `<html lang>` for `/{room}/tv`, or a test that has drifted from correct behaviour. Do not assume the test is wrong because it is inconvenient — TICKET-79 shipped this deliberately and TICKET-75's client-side patch was removed in favour of it.
2. **Find when it broke**, by bisecting over the recent merges (103, 106, 109 all landed on 2026-09-27). Cheap, since the failure is deterministic.
3. **Fix the cause**, and if the test was right all along, check whether production is affected — this is a served-HTML property, so it is verifiable against `boraoke.com` directly.
4. **Close the gate gap**, which is the durable half. Options to weigh rather than assume: run the e2e suite in the GitHub Actions job despite its advisory status, add a boraoke-appropriate target to the local-Docker gate so `verify-green-local.sh` means something here, or make an e2e run a required step of the TM's own merge procedure. The current state — a suite that only runs when someone remembers — will produce this again.

## Constraints

- Read **`proof-by-absence`** before concluding anything is unaffected; "I could not reproduce it in production" is not "production is fine".
- Note the environmental hazards already documented for this repo: the in-memory store resets on route compile **and again on dev-server eviction every ~25s of idle**, and a second `PORT=` does **not** isolate a Next dev server because the `.next` cache is shared. Rule those out before blaming them — this failure reproduced on two ports with a clean `.next`.

## Acceptance

The test passes for the right reason (either the product is fixed, or the test is corrected with a written justification), the breaking change is identified, production impact is stated with evidence, and a gate exists that would have caught it.

---

## Appended 2026-09-28 — measured evidence from PR #84, and a mitigation that was TRIED AND REVERTED

Added by the TICKET-108 Dev while re-gating PR #84. This section exists so whoever does the build-and-start work starts from what was measured rather than rediscovering it. **Nothing here is in PR #84** — the mitigation below was implemented, measured, found insufficient, and deliberately reverted.

### The suite cannot pass a cold-cache run on `main`, and the failures roam

Five runs of `e2e/search.spec.ts` alone, on **pure `origin/main`** (its `SongSearch.tsx`, its `search.spec.ts`, its `helpers.ts` — no PR #84 code present), with `rm -rf .next` before **every** run:

| run | failures | failing tests | duration |
|---|---|---|---|
| 1 | 1 | `:37` | 2.9m |
| 2 | 2 | `:329`, `:386` | 2.6m |
| 3 | 4 | `:37`, `:65`, `:254`, `:329` | 5.8m |
| 4 | 4 | `:37`, `:65`, `:115`, `:165` | 6.4m |
| 5 | 1 | `:37` | 2.8m |

**5 of 5 cold runs failed. Seven of that file's twelve tests failed at least once, and the set changed every run.** By contrast, 12 warm runs of the same file were 12/12 clean. Cold is the condition; the identity of the failing test is close to arbitrary.

Representative failures, verbatim — note that none is a logic failure:

```
:37   Test timeout of 30000ms exceeded.
      Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
        - navigating to "http://127.0.0.1:3132/default", waiting until "load"

:329  Error: expect(locator).toBeVisible() failed
      Locator: getByRole('button', { name: /Stale Song 0/ })
      Timeout: 5000ms
```

**Consequence for this ticket's own investigation (step 2):** a cold-cache run cannot distinguish a deterministic regression from this flake. `served-lang.spec.ts:105` was called deterministic on 3/3 runs — that conclusion is probably still right, since it failed the *same* assertion every time whereas this flake roams, but the bisect in step 2 should run **warm** (or post-fix) so the signal is not buried.

### Why it hits this suite: nine specs warm nothing

`e2e/helpers.ts` carries `warmModerationRoutes` / `warmTvRoutes` / `warmFeedbackRoute`, each added by a ticket (44/65/88/94) after exactly this failure. `warmFeedbackRoute`'s own comment describes it: *"the route's FIRST compile therefore happens inside the test's own assertion window… that compile can exceed the timeout and the test fails on a product path that is working correctly."*

Nine specs warm routes; **nine warm nothing** — `search`, `submit-song`, `identity`, `rooms`, `saved-rooms`, `telemetry`, `language-switcher`, **`served-lang`**, `advance-auth`. Note `served-lang.spec.ts` is in the unwarmed half.

A detail that makes this class hard to see: **`search.spec.ts` mocks `/api/search` in every test**, so the route the spec is *named* after never compiles. The latency is entirely on the surrounding routes, so the failure lands on an arbitrary test and reads as unrelated to whatever changed most recently.

### The mitigation that was tried, and the three reasons it is not the fix

A `warmPatronRoutes()` helper (patron page bundle + `/api/queue` + `/api/queue/pending` + `POST /api/queue` + `POST /api/t` + the feedback route) was written in the repo's own idiom and measured cold:

| variant | cold runs | result |
|---|---|---|
| `beforeEach` | 5 | **4 failed** |
| `beforeAll` + `test.setTimeout(180_000)` in the hook | 3 | **1 failed** |

Better than `main`'s 5/5, and not good enough to ship. **Reverted from PR #84.** Four findings, each paid for:

1. **Playwright charges a `beforeEach` against the TEST's timeout.** A warm-up living there can never buy more time than the 30s test it runs inside; cold and under load the hook itself dies — `Test timeout of 30000ms exceeded while running "beforeEach" hook`. Moving it to `beforeAll` with its own `test.setTimeout()` is strictly better, and compilation is a one-time process-wide event anyway, so `beforeEach` re-pays nothing sixteen times over while adding contention to the resource under pressure.
2. **`request` is test-scoped and unavailable in `beforeAll`.** Mint one from the worker-scoped `playwright` fixture: `playwright.request.newContext({ baseURL: testInfo.project.use.baseURL })`.
3. **Fire-to-compile with an invalid body compiles the route but does not warm the success path.** The surviving `beforeAll` failure was the submit assertion — `getByText(/música na fila/i)`, 5s timeout — *despite* `POST /api/queue` having been warmed with an unparseable body. A 400 short-circuits at the JSON guard before the modules only reached on the success path are evaluated. Any warm-up written this way has this hole, and warming with a *valid* body means planting state, which is what the invalid-body posture exists to avoid. This is a genuine dead end, not an implementation slip.
4. **A warm-up cannot reach the worst failure at all.** One cold run produced `Error: Timed out waiting 120000ms from config.webServer` — the dev server never became reachable, so no hook ran. Nothing spec-side addresses that.

**Conclusion: `next build` + `next start` is the only fix that closes this**, because it removes compilation from the test run rather than relocating its cost. A warm-up can only ever move the cost somewhere less damaging, and points 3 and 4 above bound how much it can move. This is direct support for the build-and-start approach already recorded as this ticket's primary fix.

### Two flawed measurements from this episode, recorded because the failure mode is the point

Both were true numbers, honestly obtained, describing a condition other than the one implied — the same class as a `113 passed / 0 failed` report:

- **The re-gate control that sent PR #84 back was miscompared.** Its loops never cleared `.next`; only the merged-tree loop had `rm -rf .next` per iteration. So "8 clean `main` runs" was roughly **2 cold and 6 warm**, presented as comparable to cold merged-tree runs. It was used to attribute a defect to PR #84's change, and arm E above is what corrected it.
- **The TICKET-108 Dev made the same error in round 2.** A second `next dev` was started on another port while a full suite run was in flight; `PORT=` does not isolate the `.next` cache, and the resulting 7 failures (`⨯ [TypeError: Cannot read properties of undefined (reading '/_app')]`) were nearly reported as findings.

**Unresolved, flagged rather than explained away:** the ~2 genuinely cold control runs in the re-gate passed, while 5 of 5 cold runs here failed. Within these runs, contention clearly modulates *severity* (fast runs 2.6–2.9m averaged 1.33 failures; slow runs 5.8–6.4m averaged 4.00 — 3.0×), but **zero of five cold runs passed, including the fastest**, so load does not explain the existence of a clean cold run. Both samples are small. The true cold-failure rate is high but is not established as 100%, and the discrepancy between the two environments is **probable-but-unconfirmed**.
