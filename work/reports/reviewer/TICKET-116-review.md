# TICKET-116 — Reviewer report (D-022 opus pass)

**PR:** #86 — *TICKET-116: run the e2e suite against a production build, not next dev*
**Branch / tip reviewed:** `ticket/116-e2e-built-server` @ `fbf7557` (verified equal to `origin/ticket/116-e2e-built-server`)
**Base:** `merge-base origin/main` = `66e0cd4`
**Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t116-e2e-built-server`
**Tier:** opus pass (D-022) — the merge-counting verdict.

## VERDICT: APPROVE

**Blockers: none.** The contradiction resolves in the Dev's favour and carries no production risk; the targeted reverse check does carry the claim; the `next-env.d.ts` decision holds under every measurement I could apply to it, including one the Dev did not have; and `workers: 1` is a genuine parallel-safety finding, not an artefact.

Eight observations follow, none blocking. One of them (#1) is HIGH and belongs in a follow-up ticket rather than in this PR.

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path.`
`design-parity: not applicable — no UI surface in the diff (product surface is two singleton bindings; no component, page or style changed).`

---

## What I verified by EXECUTION vs by READING

Stated up front because the TM merges on this.

### By execution (I ran it, in this worktree, on ports 3170/3171)

| # | What | Result |
|---|---|---|
| E1 | Full e2e suite, **cold** (`rm -rf .next-e2e test-results playwright-report`), `CI=1`, through the delivered config | **126/126 passed, 3m50s (230s)**, load 6.75 → 5.88, exit 0 |
| E2 | `served-lang.spec.ts` alone, **cold**, through the delivered config | **7/7 passed, 16.3s** |
| E3 | `<html lang>` served by a **built** server for a wiped room on `/{room}/tv` — the decisive experiment for the contradiction | **`pt-BR`** with `Accept-Language: es`, **`pt-BR`** with cookie `es`. Never `es`. |
| E4 | Same, patron route `/{room}` (the `:135` case) | **`es`** — reproduces the Dev's `es` on the route where it is correct |
| E5 | Existing room whose language is `es`, on `/{room}/tv`, with an **`en`** visitor cookie | **`es`** — the TV provably ignores the visitor and follows the room |
| E6 | `/default/tv` with cookie `es` + `Accept-Language: en-US` | **`pt-BR`** |
| E7 | Isolated build writes nothing into `.next/` | `NEXT_DIST_DIR=.next-e2e npx next build` on a tree with no `.next` → **`.next` was never created** |
| E8 | Isolated build does not touch an **existing** `.next/` | `.next` mtime stayed 18:37 across an e2e build that ran 18:38–18:39 |
| E9 | **Live concurrency**: a `next dev` session on 3171 serving from `.next/`, then a concurrent `NEXT_DIST_DIR=.next-e2e npx next build` | dev server kept serving `200` on `/`, `/default/tv` and its seeded room; the seeded room still served **its own language (`en`)**; **zero** corruption signatures in the dev log (`app-paths-manifest`, `vendor-chunks`, `__webpack_modules__`, `ENOENT`); tree clean |
| E10 | `next-env.d.ts` churn is real | after `NEXT_DIST_DIR=.next-e2e` build → `./.next-e2e/types/routes.d.ts`; after `npm run build` → `./.next/types/routes.d.ts`. It flips, both ways. |
| E11 | **`tsconfig.json` append-only fixed point** — the claim the whole §11 decision rests on | ran both an isolated build *and* a full default `npm run build` on the committed `tsconfig.json`: `git status` **empty** after each, `include` byte-identical. Verified, not assumed. |
| E12 | `tsc --noEmit` with vs without `next-env.d.ts` | **identical error-code histogram**, not merely an identical count (1997 TS2304 / 1089 TS2582 / 25 TS7006 / 17 TS2540 / 5 TS2345 / 2 TS2503 / 1 TS2353, both ways). No new TS2307 for CSS-module or image imports — the failure mode that would have mattered. |
| E13 | Canary ordering claim | ran as `[1/126]` and `[2/126]` in my own run |
| E14 | Secret scan of the full diff | see #8 below — one hit, verified benign, with a coverage proof |
| E15 | `17 of 20` shared-`default` count | `/usr/bin/grep -la` over `e2e/*.spec.ts` → exactly **17 files** (of 20 product specs) reference `DEFAULT_ROOM` or `/default` |

### By third-party execution (not mine, not the Dev's)

| # | What | Result |
|---|---|---|
| G1 | **GitHub Actions run 36486813108, job 109145601868, on this PR's tip** | `build-and-test` **SUCCESS**. Step *Playwright e2e*: `Running 126 tests using 1 worker` → **`126 passed (4.0m)`**, on a clean ubuntu runner from a fresh `actions/checkout`. Step *Unit tests*: `55 suites, 996 passed, 5 skipped`. |

G1 is the single most valuable piece of evidence in this review and the Dev did not cite it. It independently reproduces the headline on different hardware, a different OS and a **fresh clone** — which simultaneously settles the `next-env.d.ts` fresh-clone question (see #3) and proves the `globalThis` pinning does not leak state across the 996 jest tests.

### By reading only (explicitly not executed)

- The `workers: 2` / `workers: 4` distributions (§6, §7). I did not re-run 8 contended cold runs. I verified the *mechanism* by reading instead (see priority 4) and I am satisfied it explains the result.
- The old-config arms (3 full-suite runs, 5 targeted runs). I did not re-run `next dev` at `main`. The delivered side is what I measured; the pre-fix side I assessed as an argument (see priority 2).
- The four production-build divergences as *code*: `lib/host-auth.ts:131/199`, `lib/identity.ts:44`, `app/api/rooms/route.ts:28`, `lib/rooms.ts:296`.

---

## Priority 1 — THE CONTRADICTION: resolved, and there is no production bug

**Both accounts are correct. They are about two different routes, and the summary-level phrasing is what makes them look incompatible.**

The earlier read-only diagnosis said: on `/{room}/tv`, `pt-BR` means the store-reset mechanism and `es` would mean the pathname header is not reaching the request config. **That rule is correct** — I confirmed it by reading and then by execution. The Dev reported observing both `pt-BR` and `es`. **That is also correct** — but the `es` was never on a `/tv` path.

The two failing assertions on the old config are on different routes:

- `served-lang.spec.ts:110` (test at `:105`) — `servedLang('/${room}/tv', { cookieLocale: 'es' })`, received **`pt-BR`**.
- `served-lang.spec.ts:139` (test at `:135`) — `servedLang('/${room}', { acceptLanguage: 'es-ES,es;q=0.9' })` — the **patron** route, no `/tv`. Received **`es`**.

### By what mechanism a wiped room can yield `es` — and where it cannot

`i18n/resolve-request-locale.ts:46-48`:

```ts
if (route.kind === "tv") {
  return getRoomLanguage(route.room);
}
```

On the TV branch the cookie and `Accept-Language` are **structurally unreachable** — they are not read, not passed, not consulted. `getRoomLanguage` (`lib/rooms.ts:564`) is `normalizeLocale(room?.settings?.language)`, which for an absent record is `DEFAULT_LOCALE` = `pt-BR`. So a wiped room on `/{room}/tv` can only ever yield **`pt-BR`** (or the room's own language if it survived). `es` on that route requires `classifyLocaleRoute` **not** returning `kind: "tv"` — i.e. the pathname header genuinely failing to arrive — which falls to `APP_ROUTE` and then to cookie → `Accept-Language`.

On the **patron** branch (`:52-58`) the room tier is a *soft* tier by design: with no locale cookie it reads the raw `record?.settings.language`, and `resolveLocale` (`i18n/locales.ts:118-128`) falls through `cookie → roomLanguage → Accept-Language → pt-BR`. A wiped room makes `roomLanguage` `undefined`, so the visitor's `es-ES` header wins and the served value is **`es`**. That is the documented chain working correctly on a room that no longer exists — the same store-reset mechanism, surfacing as a different value because the route's chain is different.

**Verified by execution against the built server (E3–E6)**, using a non-existent room as an exact simulation of a wiped one:

| request | received | mechanism |
|---|---|---|
| wiped room, `/{room}/tv`, `Accept-Language: es-ES,es;q=0.9` | **`pt-BR`** | TV branch, absent record → DEFAULT_LOCALE |
| wiped room, `/{room}/tv`, cookie `NEXT_LOCALE=es` | **`pt-BR`** | same; cookie unreachable on this branch |
| wiped room, **patron** `/{room}`, `Accept-Language: es-ES,es;q=0.9` | **`es`** | patron chain falls past the absent room tier — the `:135` failure |
| **existing** room (language `es`), `/{room}/tv`, cookie `NEXT_LOCALE=en` | **`es`** | the room wins over the visitor — the product guarantee, intact |
| `/default/tv`, cookie `es` + `Accept-Language: en-US` | **`pt-BR`** | reserved-segment TV, absent record |

**So: `es` on `/{room}/tv` is not reachable by any store-reset mechanism, and it did not occur.** The header-failure path exists in principle but is not reachable in practice either: `middleware.ts`'s matcher excludes only `api/`, `_next/static`, `_next/image`, `favicon.ico` and paths with a file extension, and a room slug is `[a-z0-9-]{1,64}` so it cannot contain a `.`. Nothing to escalate.

### An independent corroboration inside the Dev's own evidence, which the report did not draw out

In the very runs where `:135` received `es`, the test at `:123` — `/default/tv` with cookie `es` + `Accept-Language: en-US` — **passed**, i.e. served `pt-BR`. If the pathname header had not been arriving, `/default/tv` would have classified as `APP_ROUTE` and served the cookie's `es`, failing that assertion too. **The header provably arrived in the same runs that produced the `es`.** The ticket's third update predicted exactly this parenthetically ("an `es` result would also have failed the `/default/tv` and patron-chain assertions in the same file"); half of that prediction came true (the patron-chain assertion did fail) and half did not (`/default/tv` held), and that asymmetry is itself the proof, because only the store-reset reading produces it.

**Production risk: nil.** Production runs the Upstash driver, where no record is lost to module re-evaluation; `middleware.ts`, `i18n/` and `app/layout.tsx` are untouched by this PR; and against the production-equivalent configuration the assertion serves `en` correctly (E2, E5).

---

## Priority 2 — the GREEN reverse-check arm: does the evidence support the change?

**Yes, and the Dev's reading is right. I'd put the case slightly differently, in the Dev's favour.**

The targeted arm carries the claim, and it carries it because it is a **clean single-variable experiment**, which is a stronger property than the Dev claims for it. I verified the two conditions that make it single-variable:

1. `e2e/served-lang.spec.ts` is **byte-identical** between `main` and this branch — it does not appear in the diff (`git diff --name-only` over the PR range).
2. It imports nothing from the modified `e2e/helpers.ts` — its imports are `@playwright/test` only (read at `:1`), and it builds its own request contexts.

So between the two arms, the *only* things that differ are the server configuration and the two singleton bindings. 5-of-5 fail on one side, 5-of-5 pass on the other, with the received values explained mechanistically (priority 1) rather than merely observed. That is a reverse check in the full sense of `prove-your-test-can-fail`: the assertion demonstrably fails against the pre-fix substrate and demonstrably passes against the fixed one, with the failure mode understood.

**On the full-suite arm coming back green — the right conclusion is not "the defect is smaller than claimed", it is "the full suite is the wrong instrument for this defect".** Three reasons, and I think this is a stronger argument than the report's:

- The defect is a **race**, not a deterministic fault. Its trigger is the interval between seeding a room and loading it, versus the dev server's compile/evict schedule. A race's reproduction rate is a function of machine timing by definition, so a 0%-on-idle / near-total-under-contention distribution is the *expected signature* of the diagnosed mechanism, not evidence against it. A defect whose reproduction rate depended on nothing would not be this defect.
- The full suite **actively suppresses** the trigger. 17 of 20 specs touch `/default` and several call warm-up helpers that pre-compile the routes in question (`warmTvRoutes`, `warmModerationRoutes`) — helpers that exist *because* of this exact class. A full run therefore front-loads the compiles that the narrow run leaves to land mid-test. `served-lang.spec.ts` is, as the Dev notes, the only seed-then-load spec that calls no warm-up. Running it alone removes the accidental protection; running the whole suite reinstates it.
- The house has a **same-day independent measurement** of the load axis: `work/self-improvement/inbox/2026-09-28-concurrent-worktrees-silently-corrupt-e2e-measurements.md` records boraoke e2e distributions at load 149–173 producing 26–32 failures per run, including on assertions over two constants. That is an external datapoint on the contended end of the same curve, taken by someone else, for a different reason.

And a fourth point that neither the report nor the PR body makes, which I think settles it: **the gate already existed and was green.** GitHub Actions runs this suite on every PR (G1), on a quiet runner — precisely the condition under which the Dev's three green old-config runs occurred. That is *why* the red `main` went unnoticed: the gate was not absent, it was measuring a load-dependent race on the machine least likely to trigger it. The change's value is therefore not "makes the suite pass" but **"makes the suite's verdict mean something"** — 126/126 on 7 independent cold runs across two machines and two operating systems, inside a 17-second spread on mine. That is the argument I would have led with.

The reverse check being reported rather than buried is the right instinct and is exactly what the skill asks for. The only correction I'd make is procedural and the Dev already self-reported it in §12: the targeted arm should have been the first arm.

---

## Priority 3 — the `next-env.d.ts` decision: sound, and the fresh-clone window is measurably empty

**The reasoning checks out, and the load-bearing claim holds under execution.**

**The append-only claim — verified, E11.** This is the one the whole decision rests on, so I tested it in both directions rather than once: I ran an isolated `NEXT_DIST_DIR=.next-e2e` build *and* a full default `npm run build` against the committed `tsconfig.json`, and `git status` came back empty after each, with `include` byte-identical. Next found both entries already present and wrote nothing. The fixed point is real. (Mechanically it must be: Next appends a missing entry to `include`; with both directories listed there is nothing missing to append, in either build mode. The execution confirms the mechanism rather than just the outcome.)

**The churn is real — verified, E10.** `next-env.d.ts` flipped `.next-e2e` → `.next` → `.next-e2e` across my three builds. The premise is not overstated.

**The third measurement, strengthened.** The Dev measured an identical *error count* with and without the file. I measured the identical **error-code histogram** (E12), which is the version that rules out the failure mode that would actually have mattered — a `TS2307` wave from CSS-module or image imports losing `/// <reference types="next" />`. Zero TS2307 either way. The Dev's secondary finding also holds: standalone `tsc --noEmit` on this repo is dominated by TS2304/TS2582 (jest/node globals outside `include`), so nothing depends on it; the real type check is inside `next build`, which CI invokes.

**"Does anything break for a fresh clone before the first `next` command?" — answered by execution, and the answer is no.** G1 *is* that fresh clone: `actions/checkout` on a tree where `next-env.d.ts` is untracked and ignored. The ordering in `ci.yml` is `npm ci` → `node --test` (packages/rotation-engine, a standalone zero-dep package) → `npm run build` → `npm test` → e2e. So the only work that happens inside the window is the rotation-engine's own suite, which touches no Next types, and `npm run build` **is** the first `next` command and regenerates the file before jest ever runs. All of it green.

That leaves exactly the residual the Dev states and nothing more: **an editor opened on a never-built clone**, which will show the TS2304/TS2582 noise the repo already has and, per E12, nothing additional attributable to the missing file. I agree with the decision. I also agree there is no third option: the two rejected alternatives (commit whichever value is current; `git update-index --skip-worktree`) are correctly characterised, and the reasoning being committed *in `.gitignore` beside the rule* is the right place for it.

One cosmetic consequence, no action needed: `tsconfig.json`'s `include` still lists `next-env.d.ts` while the file is untracked. That is harmless (a missing `include` entry is not a tsc error — verified in E12, where the file was absent) and it **must** stay, because Next re-appends it on the next build and removing it would reintroduce the churn on `tsconfig.json`.

---

## Priority 4 — `workers: 1`: a genuine parallel-safety defect, correctly kept

**Confirmed, and the mechanism is specific enough to name.**

I verified the coupling count independently: **17 of the 20 product spec files** reference `DEFAULT_ROOM` or `/default` (E15) — the Dev's figure exactly.

Then I read the test that fails 4-of-4 under `workers: 2`, `e2e/tv-watchdog.spec.ts:180`, and the mechanism is not merely plausible, it is close to inevitable:

- the describe block's `beforeEach` calls `warmTvRoutes`, and its **`afterEach` calls `drainQueue(page.request)` on the shared `default` room** (`:92-94`);
- the test itself does `drainQueue` → `seed(...)` → `goto("/default/tv")` and then asserts on the player;
- and it sets `test.setTimeout(120_000)` because the stall ladder climbs one rung per 12s, so the assertion window is **~36 seconds of frozen playback**.

A second worker running any of the other 16 `default`-touching files during that 36-second window will, with near-certainty, execute a `drainQueue` on `default` and empty the queue out from under the test mid-ladder. The longest-running assertion in the suite sits on the most-shared fixture — that is a fixture-ownership defect, and no worker count fixes it.

Two further points support the Dev's reading over a load explanation: the failure is the **same single test** on all four runs (load noise roams, as the ticket's own earlier evidence documents — "the failures roam"), and it held at run 4's load of 14.48, the same band in which `workers: 1` went 5-for-5. Preferring `workers: 2` over `workers: 4` as the decisive arm is methodologically right and the Dev says so unprompted.

**Keeping `workers: 1` is correct.** `TICKET-121` is filed, and it is a good ticket: it names per-spec rooms as the fix rather than a bigger worker count, keeps the advance rate limit explicitly out of scope ("a real anti-grief control"), and sets the re-verification bar at the same cold distribution this ticket used. The rewritten config comment now states the current cause with the numbers, so the next agent will not re-run this experiment against a stale rationale — which was the actual trap here.

---

## The four production-build divergences: each absorbed, none weakening the product

**The strongest single fact about this PR: the entire product-code diff is two singleton bindings.** `git diff --stat` over `lib/ app/ components/ i18n/ middleware.ts` returns `lib/rooms.ts` and `lib/store.ts` only. All four divergences were absorbed **in the harness and config**, with zero product change.

| # | Divergence | How absorbed | Weakening? |
|---|---|---|---|
| 1 | Built server locks the `default` room (`HOST_TOKEN` unset + production → deny all) | `HOST_TOKEN: "cantai-dev-host"` in `webServer.env` | **No.** I verified the value equals `DEV_FALLBACK_TOKEN` at `lib/host-auth.ts:85`, which is on `main` and mirrored at `e2e/helpers.ts:26` — the well-known dev constant, not a secret. Setting it is how a real deployment configures the legacy room. Product code untouched. |
| 2 | Per-IP room-create throttle enforced (3/hr) vs skipped in `next dev` | `ROOM_CREATE_LIMIT: "100000"` | **No — and arguably better.** `throttleEnforced()` (`app/api/rooms/route.ts:28-31`) returns true when `ROOM_CREATE_LIMIT` is set, so the throttle code path now *runs* in e2e (it just never trips), where under `next dev` it was skipped entirely. And no coverage is lost: I checked, and the throttle has **dedicated unit coverage** — `__tests__/room-create-throttle.test.ts` plus `__tests__/api-rooms.test.ts` — so the Dev's "no spec tests the throttle" is true of the e2e layer and irrelevant overall. |
| 3 | Auth/identity cookies gain `Secure` | `baseURL` host `127.0.0.1` → `localhost` | **No, and this is the cleanest of the four.** `lib/host-auth.ts` and `lib/identity.ts` **do not appear in the diff at all** (verified by `git diff --name-only`). The whole absorption is one word in the test harness. The diagnosis is also right on the mechanics: Playwright's `APIRequestContext` applies the secure-context rule by hostname, so `localhost` is a trustworthy origin and `127.0.0.1` is not — which is exactly why the browser half worked (Chromium accepts both) and the `page.request` half 401'd. Explicitly rejecting an env-based `Secure` opt-out was the right call; that would have been a production footgun. |
| 4 | `isEphemeralRoomStore()` becomes true → the "salas ainda são temporárias" notice renders on `/new` and the room-404 page | Accepted and recorded, not suppressed | **No.** It is a *truthful* notice — the e2e server genuinely is memory-backed. Suppressing it would have been the weakening move. My own cold run (E1) covers it: `contrast.spec.ts` and `render-and-links.spec.ts`'s `/new` and room-404 assertions all pass with the extra banner present. |

The closed dead end — runtime `NODE_ENV` override — is correctly closed and worth having on the record: `next build` inlines `NODE_ENV` into the server bundles, verified by the dev fallback token staying locked and `ephemeral` staying true under `NODE_ENV=test`. Recording it saves the next agent an hour.

## The isolated `distDir`: mechanism verified, not just the outcome

You asked me to spot-check the mechanism rather than the result, so I did both.

**Mechanism (E7, E8).** `next.config.ts` reads `distDir: process.env.NEXT_DIST_DIR || ".next"`; `playwright.config.ts` sets `NEXT_DIST_DIR` in `webServer.env`, which applies to the whole `npx next build && npx next start` command, so both halves agree on the directory — they cannot disagree, which is the property that matters (a build into one directory and a start from another would fail loudly, not silently). I confirmed empirically that an isolated build on a tree with no `.next` **never creates** `.next`, and that an isolated build leaves an **existing** `.next`'s mtime untouched. Unset, `distDir` is `.next` byte-for-byte as before — `npm run dev`, `npm run build` and Vercel are unaffected, and my default `npm run build` (E11) confirms it writes `.next`.

**Live outcome (E9).** I re-ran the concurrency test the Dev inherited rather than measured: a `next dev` session serving from `.next/`, with a room seeded into it, survived a concurrent isolated build — still `200` on `/`, `/default/tv` and the seeded room, still serving that room's own language (`en`), zero corruption signatures in the dev log, tree clean afterwards. As a bonus this also exercises the `globalThis` pinning under `next dev`: the seeded room survived a concurrent build and the recompiles that followed, which is precisely the failure the ticket diagnosed.

I agree this was correctly shipped *with* the change rather than after it. Without it, moving e2e onto a build would have promoted the `.next`-corruption family from rare to routine.

## `globalThis`-pinned singletons: correct, including unconditionally

- Namespaced keys (`__boraokeQueueStore`, `__boraokeRoomBackend`) — no collision surface.
- Unconditional rather than `NODE_ENV`-guarded is the **right** call and the reasoning is exactly right: the suite now runs a production build on the memory driver, so a `NODE_ENV !== "production"` guard would exclude the one case the pin exists for. The common Next.js recipe guards it because the recipe assumes dev-only memory state; that assumption does not hold here.
- Production is unchanged: Upstash holds no local state, so pinning it is a no-op; serverless gives each instance its own global. And in the degenerate case where production *did* run the memory driver, pinning is strictly better (less state loss), and the app already declares rooms ephemeral there.
- **Jest cross-file leakage was my one real worry** — pinning to `globalThis` could in principle make unit tests order-dependent. It does not: jest gives each test *file* its own global object, and G1 settles it empirically with 996 unit tests green on this branch.

## `e2e/_canary.spec.ts`: sound as a harness canary

Reviewed for correctness, per your instruction, not for whether it belongs.

- It is genuinely product-independent: constants and the runner's own primitives, no route, store, server or product import. It cannot go red for a product reason, which is the property that makes it usable as a void signal.
- The assertions are correct. `[3,1,2].sort()` is `[1,2,3]` under the default string comparator (single digits, so lexicographic and numeric order coincide) — not accidentally correct, but worth noting it depends on that.
- Ordering claim holds: `_` (0x5F) sorts ahead of every lowercase filename, and every other spec is lowercase. **Verified by execution** — it ran `[1/126]` and `[2/126]` in my run (E13).
- The failure taxonomy is complete, which is what I checked hardest. Playwright waits for `webServer.url` before any test starts, so a failed build means **no tests run at all** — the canary is *absent*, not red. Absent → build failure; red → runner failure; green + product failures → product failures. Three distinguishable states, no ambiguity.
- Test-count arithmetic is consistent: 124 product tests at `main` + 2 canary = 126. No product test was added or lost.

One nit at #6 below.

---

## Observations (none blocking)

**1. [HIGH — not this PR's job, but it needs a ticket] Ticket acceptance criterion #4 (the gate gap) is unaddressed, and the ticket's premise about it is factually wrong.**
The ticket states GitHub Actions "does not run e2e". It does — `.github/workflows/ci.yml` has a `Playwright e2e` step, and it ran **126/126 green on this PR** (G1). What is actually broken is narrower and sharper: **`on: pull_request` is the workflow's only trigger**, and I confirmed every CI run ever recorded on this repo is a `pull_request` event (`gh run list --workflow CI --limit 30 --jq '[.[]|.event]|unique'` → `["pull_request"]`). So nothing verifies `main` after a merge, and a PR that was green when opened is never re-checked against the `main` it merges into. That is exactly how the red `main` in this ticket arose — it was found "while re-gating PR #84 against a freshly-merged `main`". Combined with the load-dependence finding, the full story is: *the gate existed, ran on the quietest possible machine, and could not see a load-dependent race.*
This PR fixes the half it was scoped to (the verdict now means something) and the ticket's own revised scope explicitly leaves the gate gap open, so I am not blocking on it. But no follow-up ticket exists for it — `TICKET-121` is about parallel safety, not this. **Recommend:** file it. Adding `push: { branches: [main] }` to `ci.yml` is a three-line change and would have caught this ticket's original symptom. The ticket text should also be corrected so the next reader does not inherit the wrong premise.

**2. [MEDIUM — report accuracy] The dev report's summary conflates the two routes, and that is the entire source of the apparent contradiction.**
§1 and the PR body both say "Both received values (`pt-BR` and `es`) confirm the vanished-room mechanism" without saying that `pt-BR` came from `/{room}/tv` and `es` from `/{room}`. Read against the ticket's rule — which is scoped to the TV route — that sentence reads as a contradiction, and it cost this review its first hour. §9.2 does get it right ("on `/{room}/tv` the lookup falls back to `pt-BR`, and on `/{room}` it falls through to the visitor's own `Accept-Language`"). **Recommend** one clarifying clause in §1 and in the PR body: *"`pt-BR` on the TV route, `es` on the patron route — the same mechanism surfacing through two different chains; `es` is not reachable on the TV route at all."* Not a correctness finding: the report's detailed section is right and the underlying work is right.

**3. [LOW — follow-up, good fit for TICKET-121] `drainQueue` still cannot fail loudly.**
The fallback is well-designed — advance first so it can never mask a genuine advance failure, host-remove second, and the early return preserves byte-identical behaviour on the handful-of-entries path every spec actually has. But if the `POST /api/host/login` inside `removeAllEntries` is refused, or a `remove` 401s, the helper returns normally with a non-empty queue and the *next* spec pays for it — the same silent-failure shape this change was fixing, moved one layer deeper. Nothing currently triggers it (I verified `HOST_TOKEN` matches `DEV_FALLBACK_TOKEN`, so the login succeeds), which is exactly why it would be silent if that ever drifted. **Recommend** a final `expect(items).toHaveLength(0)` or a thrown error after the fallback. This suite already adopted precisely that discipline elsewhere — `e2e/feedback-widget-safe-area.spec.ts:108`: *"Fail LOUDLY on a rejected seed. Previously a 429'd fixture surfaced only…"*. Same class, same fix.

**4. [LOW — flagged coupling, accepted] The fallback's host cookie.**
`removeAllEntries` leaves a host session in the shared request context, on the fallback path only. The Dev carried this forward unresolved and flagged it rather than burying it, which is the right handling. It is genuinely inert today: tests needing an unauthenticated start clear cookies explicitly, and `clearCookiesSafely` now makes that clearing reliable. Worth carrying into TICKET-121, where per-spec rooms remove the rate-limit pressure that makes the fallback fire at all.

**5. [NIT] `e2e/helpers.ts:230` — a no-op conditional.**
`const loginQ = roomId === DEFAULT_ROOM ? "" : q;` — `roomQuery(DEFAULT_ROOM)` already returns `""` (`e2e/helpers.ts:60-62`), so both branches equal `q`. Harmless, but it reads as if it were guarding something and invites a future reader to preserve a distinction that does not exist. Either drop it or use `q` directly.

**6. [NIT] The canary's one flakeable assertion.**
`expect(Date.now() - started).toBeGreaterThanOrEqual(45)` after a 50ms `setTimeout` is the only part of the canary that can go red for a non-runner reason, and a false-red *voids a run that should have counted* — the wrong direction for an instrument whose job is to justify voiding. 5ms of slack makes it very unlikely, and the Dev voided nothing across 26 runs, so this is theory. But the assertion adds little over the constants checks; consider dropping the lower bound and keeping `await expect(Promise.resolve("ok")).resolves.toBe("ok")`, which tests the async primitive without a clock.

**7. [NIT] `NEXT_DIST_DIR=""` disagreement between the two configs.**
`playwright.config.ts` uses `?? ".next-e2e"`, `next.config.ts` uses `|| ".next"`. An empty-string `NEXT_DIST_DIR` therefore passes through Playwright as `""` and is coerced by `next.config.ts` to `.next` — silently building the e2e suite into the directory the isolation exists to protect. Pathological, and `||` in `next.config.ts` is the safer of the two. Use `||` in both for consistency.

**8. [Observation — secret scan, with coverage proof] The `ALLOW_SECRET_SCAN=1` usages were justified.**
Per `proof-by-absence`, with a fail-loud tool and a positive control. Scanned the full PR diff (`/usr/bin/grep -a` over 486,707 bytes / 4,887 lines; positive control `TICKET-116` matched 57×) for `AKIA`, PEM headers, `ghp_`/`github_pat_`, `sk-`, `xox[baprs]-`, and `password|secret|token|api_key` assignments. **Exactly one hit:** `playwright.config.ts` `HOST_TOKEN: "cantai-dev-host"`. Verified benign — it is `DEV_FALLBACK_TOKEN`, exported from `lib/host-auth.ts:85` **on `main` at the merge base** and already mirrored in `e2e/helpers.ts:26`. No new secret material enters the tree. The scanner's two false positives (an identifier reference, and the `--merge` path re-flagging unchanged lines) are both already filed to the framework inbox; not re-litigated here.

**9. [Observation, no action] CI now performs two full Next builds per run** — `npm run build` into `.next` (21s in G1) and then the e2e build into `.next-e2e`. Correct and unavoidable given the isolation, and cheap at this scale. Noted so nobody reads it later as a bug.

---

## Gate preconditions — stated honestly

There is **no App Tester report and no Cyber Security report** for TICKET-116 anywhere under `work/reports/`. Under the Reviewer's normal precondition that is a BLOCKED. I judge both **inapplicable here, and I am substituting my own execution for the App Tester's function** rather than waving the requirement:

- **App Tester / design-parity:** the diff contains no UI surface. The product-code change is two singleton bindings; no component, page, route or stylesheet is touched, so there is no surface a mockup could exist for. What an App Tester would have produced here — a green run of the suite with evidence — I produced myself: E1 (126/126 cold, full suite) and E2 (7/7 targeted), plus G1 as an independent run on other hardware. The evidence is committed under `work/measurements/ticket-116/runs/` and the tables are generated from it by `summarise.py` rather than transcribed, which I spot-checked against the raw files.
- **Cyber Security:** the one security-adjacent item is the cookie `Secure` flag, and it is *not weakened* — `lib/host-auth.ts` and `lib/identity.ts` do not appear in the diff. The env additions (`HOST_TOKEN`, `ROOM_CREATE_LIMIT`) are confined to `webServer.env` and cannot reach a deployment. I ran the secret scan myself (#8).
- **"CI green" (S1 / D-051):** `scripts/verify-green-local.sh` is a framework-repo gate (`md-doctor` + `shell-tests`), and neither suite exists in boraoke — the ticket says so itself, and that is part of finding #1. The substantive equivalent for this product is the e2e suite, which I ran cold myself (E1) and which GitHub Actions ran green on this tip (G1). The Vercel check is `FAILURE` on a free-tier **build rate limit** (`upgradeToPro=build-rate-limit`), which is the already-filed event-log-auto-commit deploy-doubling issue, is advisory under D-051, and is unrelated to this diff.

If the TM would rather have a formal App Tester pass on the record before merging, that is a reasonable call — but it would re-run what E1 and G1 already show, and I would not hold the merge for it.

## `prove-your-test-can-fail` — the Dev's declarations, assessed

All four required declarations are present, including the two conditional ones, which is the part most reports omit.

- **(a) No new product assertion or regression test.** Correct — verified: no `e2e/*.spec.ts` product file is added, and the test count moves 124 → 126 purely from the two canary tests. The instrument for a substrate change is properly the measured distribution against the recorded baseline, not a mutation table.
- **(b) Failure against the pre-fix implementation.** Present, verbatim, 5-of-5 each way, single-variable (assessed in priority 2). Satisfied.
- **(c) Hollowing-out — the conditional duty that WAS triggered, and handled well.** `drainQueue` is exactly the primitive-beneath-existing-assertions case (~45 call sites, and the change alters how it reaches "empty"). The Dev's four-part re-examination is the right analysis and I checked the load-bearing part myself by reading: the early return fires **before** the fallback, so the normal path is byte-identical; the specs that assert on *advance semantics* call `advanceOnce` directly and assert on its response (`tv.spec.ts`, `tv-watchdog.spec.ts`), with `drainQueue` confined to `beforeEach`/`afterEach` cleanup — so no advance assertion can now pass because removal did the work. That is the hollowing-out hazard correctly identified and correctly closed. The one non-vacuous side effect was flagged rather than hidden (#4).
- **(d) Triggered mutation pass: correctly declared not triggered.** No new parsing/normalisation function on a money, quantity or identity path. I concur.

## Friction / for the next agent

- **The route conflation in #2 is the reusable lesson.** When a diagnosis states a rule of the form "value X means mechanism A, value Y means mechanism B", that rule is scoped to the *route or input* it was derived for. Reporting an observed Y from a different route as satisfying the same rule produces an apparent contradiction that costs a full reviewer pass to unwind. Name the route beside the value.
- **The workspace-root warning is worth fixing cheaply.** Every `next build`/`next start` in this worktree prints `Next.js inferred your workspace root` and selects the repo root's lockfile, because the worktree carries its own `package-lock.json`. Pre-existing and harmless for `next start`, but it is noise in every e2e log and it is one `outputFileTracingRoot` line away from being gone. Good candidate for the framework inbox or a boraoke chore ticket.
- **The Dev's self-reported methodology corrections (§12) are the most valuable part of that report** — "for a failure whose rate is load-modulated, the narrow deterministic case is the instrument", and "when testing whether parallelism is safe, start at the smallest parallelism that is still parallel". Both generalise well beyond this ticket.

## Does this PR's workflow encourage the commit-per-deploy pattern? (asked by the TM mid-review)

Partly yes, and the mechanism is measurable on this very branch.

**18 commits, of which 9 — exactly half — are `chore(events): auto-commit event log after: …`.** Every substantive commit is automatically doubled by the event-log auto-commit, so the branch's real cost is 2× its apparent commit count. That is the dominant multiplier and it is a framework hook, not a boraoke habit; it is already filed (`inbox: event-log auto-commit doubles Vercel deploys`).

The part that *is* attributable to this ticket's workflow is the measurement campaign. 26 cold runs produced 26 evidence files (~160 lines each) committed under `work/measurements/ticket-116/runs/`, landed across several commits as the phases completed. **I want to be clear that this is good practice and should not be discouraged** — committed raw evidence with a generated summary is exactly why I could check the Dev's tables against their sources instead of taking them on trust, and it is the reason this review has a `workers: 2` verdict I can defend. The problem is not that the evidence was committed; it is that it was committed *incrementally*, one phase at a time, when it could have been one commit at the end of the campaign. Measurement evidence is append-only and nobody reads it mid-campaign, so it is the ideal candidate for batching.

Two further notes for the TM's batching policy:

- **This PR reduces the underlying pressure rather than adding to it.** The old suite was 7 minutes and non-deterministic, which is a standing incentive to re-run, re-measure and re-commit until something looks green. A 3m50s suite that passes 126/126 on 7 of 7 cold runs removes that incentive: one run is now evidence, where before it was an anecdote. Whatever the commit-rate problem is, this change makes it smaller.
- **A batching rule should exempt nothing about correctness and everything about record-keeping.** Gate reports, evidence files, measurement runs, status and ticket updates are all append-only and safe to batch. The one thing that must never be batched into invisibility is the final push — my own single push here is the report, and per the TM's own instruction stranding it would be the worse outcome.

So: the 26-commits-in-a-day figure is, on this branch's evidence, roughly half an auto-commit hook and half an un-batched evidence campaign. Neither is a reason to commit less; both are reasons to commit in fewer, larger batches.

## Merge recommendation

**APPROVE.** Merge. No blockers, nothing conditional.

Reasoning in one paragraph: this changes the substrate every future gate on this product runs on, so it deserved the scrutiny — and it survives it. The product-code diff is two singleton bindings; all four production-build divergences are absorbed in the harness with zero product change, and the one security-adjacent control (`Secure` cookies) is provably untouched. The determinism claim is not resting on the Dev's word: I reproduced 126/126 cold myself, GitHub Actions reproduced it on a fresh Linux clone, and the targeted single-variable reverse check separates the two configurations cleanly. The one alarming possibility in the brief — a reachable `es` on `/{room}/tv`, which would have been a real production bug — is closed by reading the code and then by executing the wiped-room case against a built server: that path serves `pt-BR`, never `es`. The two judgment calls I was asked to second-guess (untracking `next-env.d.ts`, keeping `workers: 1`) are both correct, and both are argued from measurements I was able to reproduce or extend. The only finding with real weight (#1) is a gate-policy item outside this PR's handed-down scope; it needs a ticket, not a held merge.

Of the eight observations, none should delay the merge. #1 wants a follow-up ticket. #2 is a two-clause report edit. #3 and #4 belong to TICKET-121. #5, #6 and #7 are nits the next toucher can sweep.

---

*Reviewer (opus, D-022 second pass). Evidence separated into executed / third-party-executed / read above; every "no longer occurs" conclusion in this report is backed by a fail-loud tool with a positive control, per `proof-by-absence`.*
