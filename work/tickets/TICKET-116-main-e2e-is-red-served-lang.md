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

## 2026-09-28 UPDATE — ROOT CAUSE FOUND, and it is not a product regression. It is one defect behind a whole family of flakes.

A read-only diagnosis (no suite run — two latency measurements were in flight) establishes this is **neither a product regression nor test drift**, and that **it predates 103/106/109** — none of those three touches the served-lang path, and `git log` over `middleware.ts`, `i18n/`, `app/layout.tsx` and `app/(patron)/[room]/tv/` ends at TICKET-79 itself.

**The mechanism.** Both in-memory stores are **plain module-level singletons, not pinned to `globalThis`**:

- `lib/rooms.ts:278` — `export const roomBackend: RoomBackend = createBackend();`
- `lib/store.ts:39` — `export const store: QueueStore = createStore();`

Under `next dev`, **any module re-evaluation discards every room and every queue entry.** The served-lang test seeds a room and then loads `/{room}/tv`; if a route compiles in between, the room is gone and `getRoomLanguage` falls back to `pt-BR`, failing an assertion that expects the room's `en`. The visitor's `Accept-Language` is structurally unreachable on the TV branch (`i18n/resolve-request-locale.ts:46-48` returns `getRoomLanguage(room)` and never reads the header), so a *product* explanation for the failure does not exist.

**`served-lang.spec.ts` is the only seed-then-load spec that calls no warm-up helper.** That is why it is the one that fails.

**One observation refines the diagnosis and makes the fix more urgent.** The hypothesis was that a full-suite run protects this spec by accident, because alphabetically earlier specs compile `/[room]/tv` first — but **the observed failure occurred in a full-suite run.** The reconciling explanation is the separately-measured dev-server behaviour: `next dev` **evicts and recompiles** routes after roughly 25 seconds of idle (documented in the `run-app` skill after `/apple-icon.png` wiped three testers' state). So the store is wiped not only on *first* compile but on **any** recompile, at arbitrary points in a long run. That makes the hazard **ordering-independent**: no amount of warm-up sequencing fully closes it.

**Therefore the real fix is to pin the dev singletons to `globalThis`**, the standard Next.js dev pattern, so module re-evaluation cannot discard state. That eliminates the entire class rather than another instance of it. Consider what this class has already cost: three warm-up helpers in `e2e/helpers.ts`, the TICKET-88 / TICKET-92 / TICKET-65 / TICKET-68 deflaking work, a warm-up being added to `search.spec.ts` right now under TICKET-108, four agents losing time to vanished state in a single day, and this red `main`.

**Production is not affected, and the reason is structural:** production runs the Upstash driver (`lib/rooms.ts:257-278`), where no module re-evaluation can lose a record. The middleware and i18n files are byte-identical to the TICKET-79 merge that was verified against production.

### Revised scope

1. **Pin both memory singletons to `globalThis`** (dev/test only — the Upstash path is stateless and unaffected). Check first whether any spec *relies* on the store resetting between files; if one does, that dependency is itself a defect to record.
2. **Confirm the mechanism before fixing**, cheaply: run `served-lang.spec.ts` **alone with a clean `.next`** and capture the **received** value. `pt-BR` confirms the store-reset mechanism. **`es` would instead mean the pathname header is not reaching the request config — a genuine regression with production impact**, and that must be ruled out rather than assumed. The diagnosis argues strongly for `pt-BR` (an `es` result would also have failed the `/default/tv` and patron-chain assertions in the same file, which passed), but the value settles it and nobody has read it yet — the original error context was not retained.
3. **Then re-assess the warm-up helpers.** With a `globalThis`-pinned store they become belt-and-braces rather than load-bearing; leave them, but stop treating "add another warm-up" as the answer to this class.
4. **The gate gap stands unchanged** and remains the durable half: nothing in this house runs boraoke's e2e suite, which is why a red `main` went unnoticed.

**Do not run the confirming suite while a latency-sensitive measurement is in flight** — a concurrent suite shares the `.next` cache and has already corrupted one measurement on this product.

## 2026-09-28 SECOND UPDATE — measured: `main`'s e2e suite fails 4 out of 4 cold runs. The cause is that we test a DEV SERVER.

Measured on **pure `origin/main`**, cold `.next` before every run, no PR code present:

| run | failures | failing tests | wall-clock |
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


**4 of 4 cold runs failed. Seven of `main`'s twelve `search.spec` tests failed at least once, and the failing set changes every run.** The flake also scales with machine load — the slower runs failed harder.

This is not a property of any test. **It is the suite being run against a development server.**

### The actual root cause

`playwright.config.ts:34` — `webServer.command` is **`npx next dev -p ${PORT}`**.

Everything we have been patching for weeks follows from that one line:

1. **Routes compile lazily, during the tests.** First-compile latency lands inside assertion windows — hence `page.goto: net::ERR_ABORTED` on `/default` at a 30s timeout, and 5s `toBeVisible` timeouts. This is the **timeout** family.
2. **Module re-evaluation discards the in-memory singletons** (`lib/rooms.ts:278`, `lib/store.ts:39`), wiping every room and queue entry mid-test. This is the **vanished state** family, and the deterministic `served-lang` failure.
3. **Routes are evicted and recompiled after ~25s idle**, so (1) and (2) recur at arbitrary points rather than only at startup — which is why no warm-up ordering fully closes it.
4. **`workers: 1` exists solely because of (2)** — see the comment at `playwright.config.ts:14-16`. The suite is serialised to work around a dev-server artefact.

### The fix that closes the whole class

**Run e2e against a production build — `next build` then `next start` — instead of `next dev`.** A built server does not compile lazily, does not re-evaluate modules, and does not evict routes. That removes every mechanism above at once:

- no first-compile latency, so the timeout family disappears;
- no module re-evaluation, so state survives and the `globalThis` pinning becomes belt-and-braces rather than load-bearing;
- no eviction, so the ~25s recompile hazard disappears;
- **`workers: 1` can likely be lifted**, making the suite substantially faster rather than merely more reliable;
- the three warm-up helpers become unnecessary (leave them; stop adding more).

It is also **more correct, not just more stable**: e2e would exercise what production actually runs. A dev server differs from a production build in ways that matter (React strict-mode double-invocation, minification, bundling), so today's suite can both fail on working code *and* pass on code that breaks when built.

Cost: one `next build` (~1-4 min) before the suite. Against a suite that currently takes ~11 minutes warm, fails 4 of 4 cold, and has consumed days of agent time across TICKET-65/68/88/92 and today's work, that is trivially worth it.

### Revised recommendation, in priority order

1. **Switch `playwright.config.ts` to build-and-start.** This is the fix; everything else is mitigation. Verify by re-running the arm-E measurement — 4-of-4-failing should become 0-of-4.
2. **Pin the memory singletons to `globalThis`** anyway (cheap, and it protects hand-testing against `next dev`, which is a real workflow the `run-app` skill documents).
3. **Then confirm the served-lang value**, which should simply pass once (1) lands. If it still fails against a built server, *that* is a genuine product regression and gets escalated — the built-server run is the clean experiment this ticket has been missing.
4. **Close the gate gap**: with a suite that is actually reliable, running it automatically becomes worthwhile, which is what makes a red `main` detectable at all.

**Until (1) lands, treat every "e2e green" claim on this product as conditional on a warm cache**, and say so when reporting one.

## 2026-09-28 THIRD UPDATE — a third failure family, and a caveat that BINDS the build-and-start fix

From the TICKET-104 round-4 work, two additions that change how the primary fix must be implemented.

### A third failure family: `.next` build-artifact corruption

Distinct from the two already recorded (cold-compile timeouts; store-wiping module re-evaluation). Symptoms: `app-paths-manifest.json` missing, `Cannot find module './vendor-chunks/qrcode.js'`, `__webpack_modules__[moduleId] is not a function`.

**Cause: `next build` and `next dev` share the same `.next/` directory.** Running a build mid-session while a dev server is in use corrupts the artefacts the running server depends on. Cleaning `.next` removed it entirely. This is neither contention nor a product defect, and it is easy to misread as either.

### The caveat, and it is the important half

**Moving e2e to `next build` + `next start` makes this collision MORE likely, not less — unless the builds are isolated.** The proposed fix has the suite running a production build in the same working tree where agents and the `run-app` skill run `next dev` for hand-testing. Both write `.next/`. Without isolation, the fix for two failure families would routinely manufacture the third.

**So build-and-start must ship with build isolation**, not as a follow-up. Options, to be chosen with evidence rather than assumed:
- a distinct `distDir` for the e2e build (e.g. `.next-e2e`), so the dev server's artefacts are never touched;
- or a dedicated build directory per worktree, which also removes the cross-worktree case — five worktrees were open on this product in one day, and `node_modules`/`.next` are shared through the repo root.

Whichever is chosen, verify explicitly that a `next dev` session survives an e2e run happening concurrently. That is the exact scenario that produced the corruption, and it is a normal working pattern here, not an exotic one.

### Related: a measurement-hygiene rule this produced

Any agent running `npm run build` during a session that also uses `next dev` is corrupting its own subsequent test runs. Until the directories are isolated, treat a run showing missing manifests or `vendor-chunks` module errors as **void for artefact reasons** — a fourth void-category alongside the canary, wild wall-clock, and contention. Clean `.next` and re-measure rather than triaging the failures.

## 2026-09-28 FOURTH UPDATE — this ticket's own gate-gap premise was WRONG, and its title overstates the finding. Both corrected here.

The TICKET-116 review established two facts that contradict things **this ticket asserted repeatedly**. Recording them here rather than quietly editing, because the false premise is what shaped the ticket's recommendations.

### Correction 1 — "nothing in this house runs boraoke's e2e" is FALSE

`.github/workflows/ci.yml` exists and runs the suite. Verified: every workflow run in this repo's history succeeded, and the reviewer measured **126/126 in 4.0m** on this branch's tip. The ticket repeatedly claimed no gate ran e2e; **it does**.

**The real gap is much narrower: `ci.yml`'s only trigger is `on: pull_request`.** Every run ever recorded on this repo is a `pull_request` event. So **nothing re-verifies `main` after a merge** — which is precisely how a problem on `main` could persist unnoticed. The fix is a three-line addition (`push: { branches: [main] }`), filed as **TICKET-123**.

Acceptance criterion 4 of this ticket ("close the gate gap") was therefore aimed at the wrong target. The suite was always gated on PRs; it was never gated on `main`.

### Correction 2 — "`main`'s e2e suite is RED" is condition-specific, not absolute

The title and early text say `main` is red. More precisely: **`main` fails when the suite is run cold with a narrow spec selection, and passes in a full-suite run.** Both are true and neither is the whole picture:

- Measured here: cold, narrow selection → `served-lang.spec.ts:105` fails deterministically (3/3), and `search.spec.ts` fails 5/5 runs with a roaming failure set.
- Also measured: a **full-suite** run passes — on a GitHub runner (126/126) and locally when warm — because alphabetically earlier specs compile the route and the warm-up helpers suppress the trigger.

So the accurate statement is **not** "`main` is broken" but "**the suite's verdict depended on how it was invoked and how loaded the machine was**". That is worse for a gate than a plain failure, because a green run carried no information — which is exactly what this PR fixes.

**The reviewer's framing is the right one: the gate already existed and was green; the change's value is that its verdict now means something.** A quiet CI runner cannot see a load-dependent race.

### What this does not change

The three failure families, the proven dead ends (warm-ups relocate rather than remove the cost; an invalid-body fire-to-compile never warms the success path; no hook runs in a server that never booted), the build-isolation requirement, and the `next build` + `next start` fix all stand — they were measured, not inferred from the wrong premise.
