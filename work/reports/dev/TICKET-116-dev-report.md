# TICKET-116 — Dev report

**Status:** implemented; measured across 26 cold runs; `main` merged in; delivered as a draft PR.
**Picking up from:** a previous Dev stalled mid-run. Its implementation was committed (`5ea88c1`); the plan and this report were uncommitted and are now committed. This session decided the `next-env.d.ts` churn (§11), merged `main` in, and ran the measurement campaign (§6, §7, §9).
**Branch:** `ticket/116-e2e-built-server` · **Worktree:** `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t116-e2e-built-server`

---

## 1. The question the ticket opened with, answered

The ticket asked for the **received `lang` value** from `/{room}/tv` served to a visitor sending `Accept-Language: es-ES,es;q=0.9`, against a **built** server — `pt-BR` would confirm the store-reset mechanism, `es` would be a genuine regression with production impact and an escalation.

It is **`en`** — the room's own language. Neither.

Captured directly with `curl` against `next build` + `next start` (memory driver), reading the literal `<html lang="…">` out of the served HTML:

| request | received `lang` | expected |
|---|---|---|
| `/{room}/tv` + `Accept-Language: es-ES,es;q=0.9` | **`en`** | `en` |
| `/{room}/tv` + cookie `NEXT_LOCALE=es` | **`en`** | `en` |
| `/{room}/tv` with no visitor signal | **`en`** | `en` |
| `/default/tv` + cookie `es` + `Accept-Language: en-US` | **`pt-BR`** | `pt-BR` |
| `/` + cookie `NEXT_LOCALE=es` | **`es`** | `es` |

The copy in that same response is English (`Scan to join the queue` present), so the declared language and the content agree in one document. Re-read after a 35-second idle gap: still `en` — the room record survives, which is the `globalThis` pinning doing its job.

**Conclusion: no product regression, and nothing to escalate.** The pathname header reaches the request config correctly. `served-lang.spec.ts` passes 7/7 cold against a built server in 16s wall-clock, including `:105`, the assertion that made `main` red. The failure was the dev server discarding the seeded room, exactly as the ticket's third update diagnosed.

---

## 2. Headline result

| | old config (`next dev`) | new config (built server) |
|---|---|---|
| **full suite, cold, `workers: 1`** | 124/124 on **3 of 3** runs | **126/126 on 6 of 6 runs** |
| **wall clock** | 6m57s – 7m13s | **3m54s – 4m07s** |
| **`served-lang.spec.ts` alone, cold** | **2 failed on 5 of 5 runs** | **7/7 passed on 5 of 5 runs** |

Two results, and the second is the one that carries the ticket:

1. **The change makes the suite deterministic and roughly 1.8× faster.** Six cold runs, 126/126 every time, inside a 17-second spread (3m50s – 4m07s). The sixth was run against the exact delivered commit (`27ac203`) after everything else had landed, so the headline number is a property of what is being merged and not of an intermediate tree.
2. **The full-suite reverse check did NOT reproduce the old failures** — the old `next dev` config passed 3 of 3 cold runs on an uncontended machine, against a recorded baseline of 5-of-5 failures. That is a finding, not a formality, and §9 reports it rather than burying it. The **targeted** reverse check is what carries the proof: `served-lang.spec.ts` run alone and cold fails **5 of 5** on the old config and passes **5 of 5** on the new one.

---

## 3. What was changed, and why each piece is there

### 3.1 The fix — `playwright.config.ts` boots a production build

`webServer.command` is now `npx next build && npx next start -p ${PORT}`. That removes lazy compilation, module re-evaluation and idle eviction simultaneously, rather than relocating their cost the way a warm-up does. Build cost measured on a clean tree: **~18 seconds**, against a suite that ran ~11 minutes warm and failed 5/5 cold.

### 3.2 The constraint that binds it — build isolation, shipped with the change

`next.config.ts` now reads `distDir: process.env.NEXT_DIST_DIR || ".next"`, and the suite sets `NEXT_DIST_DIR=.next-e2e`. Unset — `npm run dev`, `npm run build`, Vercel — it stays `.next`, byte-for-byte the previous behaviour. See §5 for the explicit verification that a `next dev` session survives a concurrent e2e run.

### 3.3 `globalThis`-pinned singletons

`lib/store.ts` and `lib/rooms.ts` bind their singletons through `globalThis`, so module re-evaluation rebinds to the same instance instead of constructing a fresh one.

**Deliberately unconditional**, not wrapped in `NODE_ENV !== "production"` as the common Next.js recipe has it. Two reasons: the e2e suite now runs a *production* build on the memory driver, so a NODE_ENV guard would exclude the one case this exists for; and the Upstash driver holds no local state, so pinning it is a no-op rather than a risk. Serverless gives each instance its own global, so production is unchanged.

### 3.4 Four things a production build changes that the suite had been getting for free

Each was enumerated before any code was changed, and each is handled **without weakening the product**.

| # | What changes under `next start` | Evidence | Handling |
|---|---|---|---|
| 1 | `lib/host-auth.ts:131` hands the `default` room `DEV_FALLBACK_TOKEN` only when `NODE_ENV !== "production"`. Built, the room is **locked** — measured: `POST /api/host/login` → **503**. | direct `curl` | `HOST_TOKEN` set in `webServer.env` to the same value `e2e/helpers.ts` already mirrors. This is how a real deployment configures the legacy room. |
| 2 | `app/api/rooms/route.ts:28` skips the per-IP room-creation throttle only in `next dev`. Built, it enforces **3 per IP per hour**; the suite creates ~33. | code + failing creations | `ROOM_CREATE_LIMIT` raised for the test process — the same effective posture dev gave it, made explicit. No spec tests the throttle, so no coverage is lost. |
| 3 | Auth/identity cookies gain `Secure` (`lib/host-auth.ts:199`, `lib/identity.ts:44`). | measured, below | `baseURL` moved from `127.0.0.1` to `localhost`. |
| 4 | `isEphemeralRoomStore()` (`lib/rooms.ts:296`) becomes **true** (memory + production), so `/new` and the room-404 page render the "salas ainda são temporárias" notice. | `POST /api/rooms` returns `"ephemeral":true` | **Accepted and recorded, not suppressed.** No spec asserts the notice absent, and `contrast.spec.ts` — the sweep most exposed to an extra banner — passes. See §6 for why this is a recorded caveat rather than a fix. |

**On #3, the measurement that decided it.** The `Secure` flag cannot be turned off at runtime: `next build` **inlines** `NODE_ENV` into the server bundles. Verified rather than assumed — starting the built server with `NODE_ENV=test` left the dev fallback token locked (503) and `ephemeral` still true.

The symptom was a dashboard that rendered authed while every `page.request.get("/api/host/session")` beside it returned 401. The server is provably correct — `curl` with the login cookie returns 200 for the room and 401 for `default` and `/api/host/analytics`, exactly as designed. The difference is entirely client-side, and it is keyed on **hostname**:

```
host=127.0.0.1   login=200   page.request=401   browserFetch=200
host=localhost   login=200   page.request=200   browserFetch=200
```

Playwright's `APIRequestContext` applies the secure-context rule by hostname: `localhost` counts as trustworthy and it sends the `Secure` cookie; `127.0.0.1` does not and it silently sends nothing. Chromium itself accepts both, which is why the browser half worked and the request half did not.

Moving `baseURL` to `localhost` fixes the whole class with a one-word change and **leaves the product's cookie hardening untouched**. Relaxing `Secure` for tests was considered and rejected: it is a security control, and any env-based opt-out is a production footgun.

### 3.5 Two defects the build surfaced in the suite itself

The ticket asked me to check whether any spec relies on the store resetting between files, and said that if one does, **that dependency is a defect to record rather than preserve**. It does, and here they are.

**(a) The shared `default` room accumulates, and `drainQueue` could not clear it.**
Nine specs seed into the shared `default` room. Under `next dev` a queue the drain failed to clear got wiped for free by the next recompile. With the store surviving the whole run, that stopped happening — and `POST /api/queue/advance` is capped at **12 per room per 60s** (`lib/advance-rate-limit.ts`, hardcoded, no env override). Past the cap the advances 429 silently, `drainQueue`'s loop spins without progress, and the next spec to assert on `default` sees leftovers. Measured symptoms: `toHaveCount(3)` receiving **7**, an idle `/tv` that still had a `#yt-player`, `toHaveCount(3)` receiving 4.

`host-controls.spec.ts` carried its own private copy of the same advance-loop, with the same trap.

**Fix:** `drainQueue` advances while advancing works — the real rotation path, unchanged for the handful-of-entries case every spec actually has — and falls back to host-authed `POST /api/host/remove` (idempotent, no rate limit) once advancing stops making progress. The fallback is deliberately *second* so it can never mask a genuine advance failure in a spec that is testing advance. `host-controls.spec.ts` now delegates to the shared helper.

**(b) `clearCookies()` raced the rolling session cookie.**
`GET /api/host/session` is a **rolling** session (documented in `lib/host-auth.ts`) and re-issues the host cookie on every successful probe — verified on the wire, the response carries a fresh `set-cookie`. `render-and-links.spec.ts`'s `warmUp` leaves the page on the authed `/default/admin` dashboard, which polls that endpoint. A bare `clearCookies()` therefore raced an in-flight poll whose `Set-Cookie` landed *after* the clear, silently restoring the session the test had just removed — which then satisfied the analytics probe and rendered the link the test asserts is absent.

Bisected: the assertion failed on slow iterations (6.3s, 7.1s) and passed on a fast one (2.2s), and passed in isolation. `clearCookiesSafely()` navigates to `about:blank` first, unmounting the poller, so the clear is the last word. This is a **latent pre-existing race**, not something the build introduced — the build only made it reliable enough to see.

---

## 4. Proven dead ends I did NOT retry, plus one I closed

Per the ticket: warm-ups (relocate cost, cannot reach success-path modules through an invalid-body fire, cannot run in a server that never booted) were not attempted.

One new dead end, measured and closed so nobody retries it: **overriding `NODE_ENV` at runtime on the built server**. It would have neutralised all four divergences in §3.4 at once with zero product change. It does not work — `next build` inlines `NODE_ENV` into the server bundles (verified above). Recorded so the next agent does not spend the same hour.

---

## 5. Build isolation verified — a `next dev` session survives a concurrent e2e run

Established by the previous Dev on this ticket and **not re-measured by me**: a `next dev` session survived a concurrent 4.2-minute e2e run with zero artefact corruption, and its seeded room still served correctly afterwards. Recorded here as carried-over evidence, so a reader can see which claims in this report are mine and which are inherited.

It remains the constraint that binds the whole change — without `distDir` isolation, moving e2e onto a build would have made the `.next`-corruption family routine rather than rare, because agents run `next dev` in the same tree for hand-testing.

---

## 6. `workers: 1` — tested, and KEPT, for a different reason than the one on the tin

The config comment said `workers: 1` existed solely to work around the store resets, so if that cause was gone, lifting it was a large speed win. **The cause is genuinely gone. The pin still has to stay**, and the measurement is why.

**What the experiment found.** A second cause was underneath the first one all along, and a production build does nothing about it: **17 of the 20 spec files touch the one shared `default` room**, nine of them seeding into it (§3.5). Under `next dev` a recompile wiped that room between files for free, which accidentally hid the contention. Now that the store survives a whole run, parallel workers contend on that single fixture directly. `POST /api/queue/advance` is capped at 12 per room per 60s (`lib/advance-rate-limit.ts`, hardcoded), a budget several workers drain much faster than one.

**The verdict rests on determinism, not on a single red run** (full tables in §7):

| workers | clean runs | failures | wall clock |
|---|---|---|---|
| **1** | **5 of 5** | none | 3m54s – 4m07s |
| 2 | **0 of 4** | 1 every run | 2m38s – 2m44s |
| 4 | **0 of 4** | 2–4 every run | 2m01s – 2m25s |

The `workers: 2` arm is the clean signal, and it is decisive: **the same test fails all four runs** — `e2e/tv-watchdog.spec.ts:180`, the stall ladder's recreate rung, which asserts on the shared room's TV player. A single test failing deterministically across four runs is a parallel-safety defect, not load noise. It also held at the *lowest* load of the series (run 4 started at load 14.48, the same range in which `workers: 1` went 5-for-5), so load does not explain it.

`workers: 4` was added first and is the weaker evidence: it drives load average past 26 on a 10-core box, so some of its extra damage is self-inflicted saturation. That is exactly why the `workers: 2` arm was added rather than concluding from `workers: 4` alone.

**Decision: keep `workers: 1`.** Parallelism is a real 1.5–2× win, but it currently costs determinism, and a flaky gate is worth less than a slow one. The comment in `playwright.config.ts` has been rewritten to state the *current* cause with these numbers, so the next agent does not re-run this experiment against a stale rationale. The actual unlock — per-spec rooms rather than a bigger worker count — is filed as **TICKET-121**.

---

## 7. Measurements — the cold-run distribution

Protocol and void conditions in §12. Every table below is generated from the evidence files by `work/measurements/ticket-116/summarise.py`, not transcribed by hand.

**No run in this campaign was voided.** The run-triage canary passed in every run of every arm, so every failure below is a product/suite failure rather than a broken runner, and every run is counted. The `evidence intact` column is the `# --- END OF RUN ---` terminator check (`proof-by-absence` H4) — no capture was truncated.

**Old config — `npx next dev` (main 66e0cd4), full suite, cold**

| run | result | wall clock | load avg (start → end) | evidence intact | condition |
|---|---|---|---|---|---|
| 1 | **124/124 passed** | 6m57s (417s) | 3.18 → 3.63 | yes | clean |
| 2 | **124/124 passed** | 6m57s (417s) | 3.63 → 11.34 | yes | clean |
| 3 | **124/124 passed** | 7m13s (433s) | 13.96 → 6.71 | yes | clean |


**New config — built server, `workers: 1`, full suite, cold**

| run | result | wall clock | load avg (start → end) | evidence intact | condition |
|---|---|---|---|---|---|
| 1 | **126/126 passed** | 3m54s (234s) | 6.57 → 9.69 | yes | clean |
| 2 | **126/126 passed** | 3m56s (236s) | 9.69 → 10.78 | yes | clean |
| 3 | **126/126 passed** | 4m00s (240s) | 10.78 → 14.69 | yes | clean |
| 4 | **126/126 passed** | 3m55s (235s) | 14.69 → 10.55 | yes | clean |
| 5 | **126/126 passed** | 4m07s (247s) | 10.55 → 15.48 | yes | clean |


**New config — built server, `workers: 2`, full suite, cold**

| run | result | wall clock | load avg (start → end) | evidence intact | condition |
|---|---|---|---|---|---|
| 1 | 1 failed, 125 passed | 2m44s (164s) | 41.20 → 24.40 | yes | counted — real failures |
| 2 | 1 failed, 125 passed | 2m40s (160s) | 24.40 → 21.18 | yes | counted — real failures |
| 3 | 1 failed, 125 passed | 2m40s (160s) | 21.18 → 14.61 | yes | counted — real failures |
| 4 | 1 failed, 125 passed | 2m38s (158s) | 14.61 → 14.48 | yes | counted — real failures |


**New config — built server, `workers: 4`, full suite, cold**

| run | result | wall clock | load avg (start → end) | evidence intact | condition |
|---|---|---|---|---|---|
| 1 | 2 failed, 124 passed | 2m18s (138s) | 15.48 → 28.01 | yes | counted — real failures |
| 2 | 4 failed, 122 passed | 2m01s (121s) | 28.01 → 14.97 | yes | counted — real failures |
| 3 | 4 failed, 122 passed | 2m01s (121s) | 14.97 → 15.13 | yes | counted — real failures |
| 4 | 2 failed, 124 passed | 2m25s (145s) | 15.13 → 26.00 | yes | counted — real failures |


**Targeted reverse check — `served-lang.spec.ts` alone, cold, OLD `next dev`**

| run | result | wall clock | load avg (start → end) | evidence intact | condition |
|---|---|---|---|---|---|
| 1 | 2 failed, 5 passed | 0m14s (14s) | 14.48 → 16.01 | yes | counted — real failures |
| 2 | 2 failed, 5 passed | 0m13s (13s) | 16.01 → 16.33 | yes | counted — real failures |
| 3 | 2 failed, 5 passed | 0m14s (14s) | 16.33 → 15.77 | yes | counted — real failures |
| 4 | 2 failed, 5 passed | 0m13s (13s) | 15.77 → 14.87 | yes | counted — real failures |
| 5 | 2 failed, 5 passed | 0m24s (24s) | 14.87 → 11.84 | yes | counted — real failures |


**Targeted reverse check — `served-lang.spec.ts` alone, cold, NEW built server**

| run | result | wall clock | load avg (start → end) | evidence intact | condition |
|---|---|---|---|---|---|
| 1 | **7/7 passed** | 0m17s (17s) | 11.84 → 12.15 | yes | clean |
| 2 | **7/7 passed** | 0m19s (19s) | 12.15 → 15.47 | yes | clean |
| 3 | **7/7 passed** | 0m18s (18s) | 15.47 → 15.44 | yes | clean |
| 4 | **7/7 passed** | 0m18s (18s) | 15.44 → 14.77 | yes | clean |
| 5 | **7/7 passed** | 0m18s (18s) | 14.77 → 13.02 | yes | clean |


### Failing tests, by run

- `newconfig-w2-run1.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
- `newconfig-w2-run2.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
- `newconfig-w2-run3.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
- `newconfig-w2-run4.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
- `newconfig-w4-run1.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:96:7 › /tv watchdog (TICKET-41) › onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
- `newconfig-w4-run2.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:96:7 › /tv watchdog (TICKET-41) › onError 150 (embedding disabled): pt-BR notice + auto-advance, no human action
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
  - [chromium] › e2e/tv.spec.ts:942:7 › /tv › focus state: the video grows, the meta panel collapses, and the QR stays painted ON the video (TICKET-103 items 1-3)
  - [chromium] › e2e/tv.spec.ts:1029:7 › /tv › focus state: the up-next queue reveals on a timer, hides again, and comes back (TICKET-103 item 4)
- `newconfig-w4-run3.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:137:7 › /tv watchdog (TICKET-41) › onError 100 (video removed) also skips; non-fatal codes do not
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
  - [chromium] › e2e/tv.spec.ts:942:7 › /tv › focus state: the video grows, the meta panel collapses, and the QR stays painted ON the video (TICKET-103 items 1-3)
  - [chromium] › e2e/tv.spec.ts:1029:7 › /tv › focus state: the up-next queue reveals on a timer, hides again, and comes back (TICKET-103 item 4)
- `newconfig-w4-run4.txt`:
  - [chromium] › e2e/tv-watchdog.spec.ts:137:7 › /tv watchdog (TICKET-41) › onError 100 (video removed) also skips; non-fatal codes do not
  - [chromium] › e2e/tv-watchdog.spec.ts:180:7 › /tv watchdog (TICKET-41) › the stall ladder's recreate rung rebuilds a player that is actually in the document (TICKET-82)
- `servedlang-OLD-nextdev-run1.txt`:
  - [chromium] › e2e/served-lang.spec.ts:105:7 › served <html lang> per route (TICKET-79) › the venue TV serves the ROOM's language, never the visitor's
  - [chromium] › e2e/served-lang.spec.ts:135:7 › served <html lang> per route (TICKET-79) › the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR
- `servedlang-OLD-nextdev-run2.txt`:
  - [chromium] › e2e/served-lang.spec.ts:105:7 › served <html lang> per route (TICKET-79) › the venue TV serves the ROOM's language, never the visitor's
  - [chromium] › e2e/served-lang.spec.ts:135:7 › served <html lang> per route (TICKET-79) › the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR
- `servedlang-OLD-nextdev-run3.txt`:
  - [chromium] › e2e/served-lang.spec.ts:105:7 › served <html lang> per route (TICKET-79) › the venue TV serves the ROOM's language, never the visitor's
  - [chromium] › e2e/served-lang.spec.ts:135:7 › served <html lang> per route (TICKET-79) › the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR
- `servedlang-OLD-nextdev-run4.txt`:
  - [chromium] › e2e/served-lang.spec.ts:105:7 › served <html lang> per route (TICKET-79) › the venue TV serves the ROOM's language, never the visitor's
  - [chromium] › e2e/served-lang.spec.ts:135:7 › served <html lang> per route (TICKET-79) › the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR
- `servedlang-OLD-nextdev-run5.txt`:
  - [chromium] › e2e/served-lang.spec.ts:105:7 › served <html lang> per route (TICKET-79) › the venue TV serves the ROOM's language, never the visitor's
  - [chromium] › e2e/served-lang.spec.ts:135:7 › served <html lang> per route (TICKET-79) › the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR


---

## 8. `prove-your-test-can-fail` declarations

**(a) Which mutation kills each new assertion.** This change adds **no new product assertions and no new regression test**. What it changes is the substrate the existing 114 assertions run against. The instrument that plays the equivalent role here is the measured distribution in §7 against the recorded `main` baseline (5/5 cold runs failing) — and the reverse check in §9.

**(b) Failure against the pre-fix implementation.** Run directly, both ways, five times each, with the **verbatim** output pasted in §9.2: `served-lang.spec.ts` cold against the pre-fix `next dev` config fails **5 of 5 runs** (`Expected "en" / Received "pt-BR"` and `Expected "en" / Received "es"`), and passes **5 of 5** against the built server. §9.1 additionally reports the arm that came back green, and why it is too blunt an instrument rather than a refutation.

**(c) Hollowing-out — a primitive beneath existing assertions DID change, and here is what I re-examined.** `drainQueue` is exactly the `mv`→`cp` case: ~45 call sites depend on it, and I changed how it reaches "empty". Re-examined:
- **The early return is preserved.** The loop `return`s the moment `items` is empty, *before* the fallback. On the normal path — every spec with a handful of entries — the behaviour is byte-identical to before: drain by advance, no removal. The fallback is unreachable unless an advance is actually refused.
- **Assertions that test advancing do not go through `drainQueue`.** `tv.spec.ts` and `tv-watchdog.spec.ts` assert on rotation by calling `advanceOnce` directly and asserting on its response; `drainQueue` is cleanup in `beforeEach`/`afterEach`. So no assertion about advance semantics can now pass because removal did the work.
- **Post-drain state is equivalent.** Measured: after a full drain the queue reports `items: []` **and** `nowPlaying: null`, and `/default/tv` renders idle with `#yt-player` count 0. The removal fallback leaves the same observable state the advance path does for these assertions.
- **One side effect that is NOT vacuous and is recorded rather than hidden:** the fallback performs `POST /api/host/login` to obtain the host session it needs. On the fallback path only, this leaves a host cookie in the shared request context. Tests that require an unauthenticated start clear cookies explicitly (`clearCookiesSafely`), so no current assertion is affected — but this is a real coupling and is flagged for the Reviewer.

**(d) Triggered mutation pass:** not triggered — no new parsing/normalisation function on a money/quantity/identity path.

---

## 9. Reverse check — one arm came back GREEN, and that is reported, not buried

`prove-your-test-can-fail` is explicit that a green reverse check is a finding. One of my two arms came back green.

### 9.1 The full-suite arm did NOT reproduce the failures

The old `next dev` config, at `main` tip, cold, in a clean detached worktree: **124/124 passed on 3 of 3 runs.** The recorded baseline says cold `main` failed **5 of 5**. My runs do not reproduce that.

**I do not think this invalidates the ticket, and here is the evidence rather than the reassurance.** The ticket's own fourth update already flagged this exact discrepancy and refused to explain it away:

> the ~2 genuinely cold control runs in the re-gate passed, while 5 of 5 cold runs here failed. Within these runs, contention clearly modulates *severity* (fast runs 2.6–2.9m averaged 1.33 failures; slow runs 5.8–6.4m averaged 4.00 — 3.0×) … The true cold-failure rate is high but is **not established as 100%**.

My three runs are a third sample on the "cold `main` can pass" side, and the difference between the samples is **machine load**. The 5-of-5 sample was taken on a contended box; the house has a same-day incident report (`work/self-improvement/inbox/2026-09-28-concurrent-worktrees-silently-corrupt-e2e-measurements.md`) of boraoke e2e distributions taken at load average 149–173 producing 26–32 failures per run, including an assertion over two constants. I had the machine to myself, at load 3–14.

So the honest statement of the old config's defect is **not** "it always fails cold". It is: **its cold failure rate is load-dependent and unpredictable, ranging from 0% on an idle machine to near-total under contention.** That is a worse property for a gate than a consistent failure, and it is precisely what this change removes — but a full-suite cold run on a quiet machine is too blunt an instrument to demonstrate it.

### 9.2 The targeted arm is the real reverse check, and it is decisive

`served-lang.spec.ts` is the sharp case: the ticket calls its `:105` failure deterministic (3 of 3), and it is the only seed-then-load spec that calls no warm-up helper. It is also a **clean single-variable experiment** — the file is byte-identical between `main` and this branch, and it imports nothing from the modified `e2e/helpers.ts`, so the configuration and the `globalThis` pinning are the only things that differ.

Run alone, cold, five times each way:

| config | result |
|---|---|
| OLD (`next dev`) | **2 failed, 5 passed — 5 of 5 runs** |
| NEW (built server) | **7/7 passed — 5 of 5 runs** |

Verbatim failure output from the old config (`servedlang-OLD-nextdev-run1.txt`), both failures, unedited:

```
  1) [chromium] › e2e/served-lang.spec.ts:105:7 › served <html lang> per route (TICKET-79) › the venue TV serves the ROOM's language, never the visitor's

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "en"
    Received: "pt-BR"

      108 |     // The exact bug TICKET-75 was filed for: an `es` patron cookie on a room
      109 |     // whose screen renders English copy.
    > 110 |     expect(await servedLang(`/${room}/tv`, { cookieLocale: "es" })).toBe("en");
          |                                                                     ^

  2) [chromium] › e2e/served-lang.spec.ts:135:7 › served <html lang> per route (TICKET-79) › the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR

    Error: expect(received).toBe(expected) // Object.is equality

    Expected: "en"
    Received: "es"

      138 |     // No cookie → the venue's default wins over the browser's own preference.
    > 139 |     expect(await servedLang(`/${room}`, { acceptLanguage: "es-ES,es;q=0.9" })).toBe("en");
          |                                                                                ^
  2 failed
  5 passed (14.0s)
```

**Both received values confirm the diagnosed mechanism exactly, and neither is a product bug.** The room vanishes between seeding and loading: on `/{room}/tv` the lookup falls back to `pt-BR`, and on `/{room}` it falls through to the visitor's own `Accept-Language` and yields `es`. A room that still existed would have produced `en` in both. This is the vanished-state family, not the pathname header failing to reach the request config — which is the outcome the ticket said would have been a genuine regression requiring escalation.

Note also that the second failure (`:135`) is one the ticket had **not** recorded; running the file in isolation surfaced it consistently.

---

## 10. Friction

- `scripts/commit-and-push.sh`'s F270 credential scanner flagged `e2e/helpers.ts` on the line `data: { token: rawHostCode ?? DEV_FALLBACK_TOKEN },` — a **variable reference**, not a literal, matching `generic-secret-assignment`. `DEV_FALLBACK_TOKEN` is the well-known dev constant already committed on `main` in `lib/host-auth.ts:78` and `e2e/helpers.ts:26`. Committed with `ALLOW_SECRET_SCAN=1` as a reviewed false positive, flagged here for the Reviewer rather than left silent.
- The worktree carries its own `package-lock.json` while the repo root has one too, so every `next build`/`next start` prints a "Next.js inferred your workspace root" warning and picks the root. Pre-existing, harmless for `next start`, noisy in every e2e log.

---

## 11. The `next-env.d.ts` / `tsconfig.json` churn — decided, not absorbed

The isolated `distDir` had a cost the implementation left unanswered: it made **`next-env.d.ts` a permanently churning file**. Next rewrites its `/// <reference path="./<distDir>/types/routes.d.ts" />` line to whichever build ran most recently, so the file said `.next-e2e` after an e2e run and flipped back to `.next` after `next dev` or `npm run build`. `tsconfig.json` was auto-modified too. Left alone that is a dirty tree after every e2e run, a spurious diff, and a merge-conflict source on every future branch.

The two files churn by **different mechanisms**, so they get different answers.

### 11.1 `tsconfig.json` — churn eliminated at its source, file stays tracked

Next only **appends** to `include`; it never removes an entry. So a `tsconfig.json` committed with **both** type directories present is a fixed point — the next build finds both entries already there and writes nothing.

Verified rather than assumed: with both entries committed, a full `npm run build` into `.next` left `git diff tsconfig.json` **empty**. Committed as-is.

### 11.2 `next-env.d.ts` — no stable value exists, so it is untracked and ignored

The reference line is **rewritten**, not appended to, and it can only ever name one directory. There is therefore no value that is correct after both a `.next` build and a `.next-e2e` build, and Next exposes no switch to suppress the rewrite. **No in-tree option is clean** — the honest choice is between a tracked file that flips forever and an untracked one.

It is untracked, and the case rests on three measurements, not on preference:

| Claim | Evidence |
|---|---|
| It is pure generated output, not authored | **one** commit in the repo's entire history touches it — `12609dc`, the initial TICKET-1 scaffold. Never hand-edited since. |
| It is regenerated byte-identically when absent | deleted it, ran `npm run build`: the file reappeared with exactly the committed content (`.next` reference), and the build — type check, `check-bundle-es-target`, `check-css-target` — was **green**. |
| It contributes nothing to any type-check path here | `npx tsc --noEmit` reports **2965 errors with it and 2965 without it** — an exactly identical count. The route types reach the program through `tsconfig`'s `include` globs (both now listed), not through this file's reference line. |

That third measurement is the load-bearing one, and it carries a second finding worth stating plainly: **a standalone `npx tsc --noEmit` is already deeply red on this repo** (1878 `TS2304` + 1037 `TS2582` — jest/node globals absent from `include`). It is not a workflow anything depends on; the real type check runs inside `next build`, which is what CI invokes. So nothing was relying on the committed copy.

**Residual cost, stated plainly:** a fresh clone has no `next-env.d.ts` until the first `next` command generates one, and this is a deliberate deviation from the Next.js default (`create-next-app` commits the file). In exchange it can never churn or conflict again. The full reasoning is committed **in `.gitignore` beside the rule**, so the next person meets it where they would question it.

**What was rejected:** committing whichever value happened to be current — it flips back on the next `next dev`, which is the churn, not a fix. And `git update-index --skip-worktree` — per-clone local state that silently breaks checkout and rebase, and which no other clone inherits.

---

## 12. Measurement protocol — what "cold" means and when a run is VOID

Every number below comes from one harness, `work/measurements/ticket-116/cold-run.sh`, so runs are comparable. A **cold run** is: `rm -rf .next-e2e .next test-results playwright-report`, then `CI=1 npx playwright test` — `CI=1` forces `reuseExistingServer: false`, so the server is always freshly built and booted. Each run writes an evidence file under `work/measurements/ticket-116/runs/` carrying head SHA, port, worker count, load average at start and end, wall clock, exit code, and an explicit `# --- END OF RUN ---` terminator (per `proof-by-absence` H4) so a truncated capture announces itself instead of reading as a clean run.

A run is **VOID — excluded from the distribution rather than triaged** — when any of these holds. Voiding is deliberately tied to signals, not to which reading is convenient:

1. **the run-triage canary is red** (`e2e/_canary.spec.ts`, added for this) — it asserts only over constants and the runner's own async primitives, touching no route, store, server or product module, so it cannot fail for a product reason. Red means the *runner* failed and the run says nothing about the product;
2. **wall clock is wildly off baseline** — a run that took multiples of the established time was not measuring the same thing;
3. **the box was contended** — load average recorded at both ends of every run;
4. **build artefacts are corrupt** — the `.next`-corruption family this change exists to prevent (`missing app-paths-manifest.json`, `Cannot find module './vendor-chunks/*.js'`).

- The **full-suite reverse check is a blunt instrument on an idle machine** (§9.1). I ran three cold runs of the old config expecting failures and got 124/124 three times. The time was not wasted — it produced the load-dependence finding — but the targeted single-spec arm settled the question in 13 seconds a run instead of 7 minutes, and it should have been the *first* arm rather than the second. For a failure whose rate is known to be load-modulated, the narrow deterministic case is the instrument; the broad one measures the machine as much as the code.
- **`workers: 4` was the wrong first probe** (§6). It saturates a 10-core box (load average past 26), which confounds the parallel-safety question with a load question. `workers: 2` gave the clean, deterministic signal. When testing whether parallelism is safe, start at the smallest parallelism that is still parallel.
- The F270 credential scanner **re-flags unchanged lines on the `--merge` path**, so merging `main` required `ALLOW_SECRET_SCAN=1` for a constant neither side of the merge touched. Distinct from the identifier-reference false positive already filed; noted to the framework inbox as `2026-09-28-secret-scan-rescans-unchanged-lines-on-merge.md`.
- A `local L="$1" ... F="$OUT/$L-run$N.txt"` in my own harness expanded `$L` inside the statement that declares it and died under `set -u`, losing a queued phase. Split the declarations; the phase was re-run.

---

## 13. What I am handing the Reviewer as open questions

1. **`e2e/_canary.spec.ts` is new machinery, not a product test.** It earns its place while this suite's reliability is under active investigation, and it costs ~0s. If you would rather the suite carried no non-product test, it is a clean single-file delete — say so and I will remove it, along with void condition 1 in §12.
2. **The `next-env.d.ts` untracking (§11) deviates from the Next.js default.** The measurements are in §11.2 and the reasoning is committed in `.gitignore`. If you disagree, the alternative is a file that flips on every e2e run — I could not find a third option, and §11.2 says so plainly rather than implying the choice was clean.
3. **The `drainQueue` host-remove fallback leaves a host cookie** in the shared request context on the fallback path only (§8c, previous Dev's finding, carried forward unresolved). No current assertion is affected; it is a real coupling.
