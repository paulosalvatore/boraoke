# [reviewer] REQUEST-CHANGES — D-022 opus pass, head cd3c9ef

PR #90 (TICKET-126 PR A: per-person daily share of the 90 billed searches, single-flight, TICKET-119 IP derivation, #89 MEDIUM 7 limiter fix). Reviewed `git diff origin/ticket/125-enter-idle-search...HEAD` at `cd3c9efea7c4acff4c844fb07378d28626102103` (= `origin/ticket/126-search-limits`).

## Verdict

The design is right and fixes the cause, not a symptom: the platform cap bounded the day but not one person's share of it, and concurrent identical misses each billed. The Lua all-or-none charge, the fail-closed paths, the IP derivation and the limiter reorder are correct. Two blocking items, both cheap: a single-flight wiring path that no test guards (a mutant survives), and copy that is false in the most common case where the per-IP cap binds.

## Blocking

1. **The route's "release the lock when the reserve is denied" is untested; deleting it survives every suite.** Mutant: remove `await release("abandoned")` before the personal/daily-limit return in `app/api/search/route.ts`. Result: SURVIVED, 82/82 pass across client-ip, search-single-flight, search-budget-principal, api-search-personal-caps, search-rate-isolation, api-search-budget. This is a real gap, not an equivalent mutant. On the in-process path the `memFlights` entry would never be removed, so every later identical query on that instance waits 6 s and gets `deferred: "single-flight"` for the life of the process. On Upstash the lock sits for the full 10 s TTL and every concurrent waiter defers instead of re-leading. The module-level test ("a leader that abandons ... leaves the flight VACANT") covers `release`, but nothing covers the route calling it, and this is exactly the path the plan promised a probe for ("leader denied: no call, no waiter charged"). Ask: a route-level test where the leader is denied (personal cap) while a waiter from another device is waiting, asserting the waiter re-leads and gets answered (1 billed call, charged to the waiter's own device), plus a follow-up identical request after a denial that is answered rather than deferred. Show it fails with the `release("abandoned")` line removed.

2. **`personalLimit` copy is false when the per-IP cap is what binds.** en "You've used today's live searches", es "Ya usaste tus búsquedas en vivo de hoy", pt-BR "Você já usou suas buscas ao vivo de hoje". The plan's own arithmetic says a busy bar night (~50 billed) is the expected case for hitting 45 per IP, so the usual reader of this message is a patron on the bar Wi-Fi who may not have searched at all, told they used up their searches. Keep one reason (no probing which key) but make it true for both: e.g. en "Live search is used up for today on this phone or network — karaoke catalogue results still work, or paste a YouTube link"; pt-BR "As buscas ao vivo de hoje acabaram neste aparelho ou nesta rede — o catálogo de karaokê continua funcionando, ou cole um link do YouTube"; es "Se acabaron las búsquedas en vivo de hoy en este dispositivo o red — el catálogo de karaoke sigue funcionando, o pega un enlace de YouTube". The e2e assertions (`/buscas ao vivo de hoje/`, `/catálogo de karaokê/`) still match that pt-BR line. Update the PR body's Testing Handoff quote with it.

## Non-blocking

3. **nit — single-flight retry collides with the live cooldown.** A waiter passed `liveCooldown` (which records it as billed) before it waited, so its one client retry at `FLIGHT_RETRY_MS` = 1500 lands inside `LIVE_COOLDOWN_MS` = 2000 and is deferred again as `live-cooldown`, and the client retries only once. Only on the timeout path (leader slower than 6 s, or dead), and the retry is still answered from cache if the leader has filled it. Fix: `FLIGHT_RETRY_MS >= LIVE_COOLDOWN_MS`.

4. **nit — a stale `sf:err:` marker fails a later flight's waiters.** After a failed leader, the 3 s marker outlives the release. A new leader for the same query inside those 3 s bills normally, but its waiters read the old marker and degrade with `reason: "error"`. Arguably acceptable as upstream backoff. If not, delete the marker when a leader acquires, or store the leader token in it.

5. **nit — legacy (no `v=2`) clients get `deferred: "single-flight"`**, which the cooldown path documents they render as an empty list (that path answers them with 429 instead). Same treatment here, or leave it to TICKET-133.

6. **nit — test can't see the fill-then-release order.** Mutant: `release("filled")` before `setCachedSearchPage`. SURVIVED. The window is a waiter seeing the lock gone before the page lands, so it re-leads and bills a second time, still inside every cap. The code order is right. Optional: give the fake a slow cache write in one seed. Also SURVIVED and accepted as optimisations or race-only: the leader's cache re-check removed, the waiter's late re-read removed, and the re-lead bound `attempt >= 1` → `>= 100` (still bounded by the deadline).

7. **nit — the shipped Lua runs only in the opt-in real-Redis suite.** Mutant `used(KEYS[2]) >= ipCap` → `>` SURVIVES the default jest run, because the fake re-implements the script in JS. The Dev's real-Redis run (12/12, plus a Lua mutant killed) is the evidence. Same pattern as the TICKET-87 Lua; worth a gate that runs `REDIS_TEST_URL` suites in the full-suite lane.

8. **nit — dev report build section is stale.** It still says the Vercel order is `x-vercel-forwarded-for` → `x-real-ip` → XFF. The later Cyber-fix section corrects it, but correct it in place.

## Checked and correct

- **Cause, not symptom.** The per-person share is charged in the same atomic step as the platform counter, at the only `searchYouTubePage` call site, after cache, index, liveRequired and the cooldown. Free tiers never touch a personal counter.
- **Lua all-or-none** (`RESERVE_PRINCIPAL_SCRIPT`). It checks platform, then IP, then device before any INCR, then INCRs all three, with TTL set when a key is created. A denial charges nobody. The platform is checked first, so a drained day reads as `daily-limit`. The non-integer reply guard and the `reason: "store"` deny are kept (fail-closed). The memory path mirrors it in one synchronous block. Mutants C (mem device `>=`→`>`) and I (mem IP check removed): KILLED.
- **Single-flight.** Lock is `SET NX PX` with a random token, released by compare-and-delete. A crashed leader means waiters defer at 6 s and the lock expires at 10 s. A waiter that finds the flight vacant re-leads once and is then charged as itself. Waiters never reserve and never write the cache. Acquire fails open to solo, with the reserve still fail-closed. Mutant E (failed treated as fallthrough): KILLED.
- **Device key.** It uses the identity cookie, then the uuid, then `anon@ip`. Mutant F (uuid fallback dropped): KILLED. The public-uuid direction is filed as TICKET-132.
- **IP derivation.** `x-real-ip` comes first on Vercel (the production-verified header). Off Vercel with nothing declared, every request shares one fail-closed bucket. IPv6 is keyed by /64 (TICKET-131 tracks /56). `rateLimitOk` checks the IP first and inserts nothing on a rejection.
- **10/45 as a default.** Sound, and stated with its trade-off. 90 a day buys ~100 queued songs platform-wide, so a busy bar is most of the day whatever the cap. "No network takes more than half" protects a second venue. Ten per device clears a heavy honest patron (6 songs × 1.3). Both are env-tunable and clamped to [1, 90]. The TL should still see that a busy single-Wi-Fi night is expected to reach 45 before closing (that is why item 2 matters).
- **Reverse checks reproduced.** Targeted jest at the head: 6 suites, 98/98. Mutant table: `scratchpad/rev90/mut-out.txt` (KILLED C, E, F, I; SURVIVED A real gap, B, G, H, J, D as above). Working tree restored and verified clean.
- `triggered mutation pass:` the Dev's 14/14 on `normaliseIpBucket` stands and was not re-run. Its suite passes at the head.

## Gate state (not part of this verdict)

App Tester PASS is still unchecked. Full jest, real-Redis and e2e numbers are from `560c61c` and are owed on the final head (boraoke has no `verify-green-local.sh`). Before closing TICKET-119, carry Cyber M-1's condition: the zero-data claim probe against the deployed build.

---

# [reviewer] REQUEST-CHANGES — D-022 opus re-review, head fc91d17

Re-review of the fix commit `eb1b4d4` (head `fc91d17aad81f87b665bdfc4122fc022d6d1af80` = `origin/ticket/126-search-limits`, fetched). Read `git diff cd3c9ef eb1b4d4` locally plus the "Opus review fixes" section of the dev report on the PR branch.

## Verdict

Every item from the first pass is fixed, and each new test was mutated by me and fails. The code is ready. One small blocking item, found while chasing the Dev's unexplained flake: the cross-instance probe has no explicit timeout, and when it times out it keeps running into the next tests and makes them fail with numbers that look like double billing. It is a test-harness problem, not a billing race, and the fix is a few lines in the test file.

## Blocking

1. **`search-single-flight`: the seeds probe can time out under load and its leftover work fails the next tests with false billing counts.** "holds across 8 different interleavings (seeds)" runs 8 × 20 requests with real timers on jest's default 5 s timeout. My 70 runs at load average 107–158 (10 cores) took 1461–2773 ms (median 1647), so the margin is under 2×. When it times out, jest moves on but the abandoned loop keeps going: it swaps `fake`, resets the shared `searchListCalls` to 0 and fires more requests. I reproduced this with `--testTimeout=1000` (standing in for a slower machine), verbatim:
   ```
   ✕ holds across 8 different interleavings (seeds), not one lucky schedule (1001 ms)
   ✕ NEGATIVE CONTROL: with the lock disabled the same probe bills every request (82 ms)
   ✕ different queries are not serialised behind each other (102 ms)
     thrown: "Exceeded timeout of 1000 ms for a test.
     NEGATIVE CONTROL ... Expected: 20  Received: 21
     different queries ... Expected: 6   Received: 0
   Tests:       3 failed, 15 passed, 18 total
   ```
   One timeout plus one or two failures it causes matches the Dev's first run (`2 failed`, while another lane was loading the machine). "Received: 21" reads like a billing bug, and the full-suite lane will run under load. Fix: give the `fire()` probes an explicit timeout like the route-wiring tests have (e.g. `30_000` on "holds across 8 seeds", and on the 20-request, negative-control and upstream-failure probes). Recommended as well: split the seeds into `it.each([1..8])` so a timeout leaves at most one probe's stragglers behind, not seven. Proof to attach: the same `--testTimeout=1000` run shows the seeds probe passing on its own timeout, with no failures in the tests after it.

## Flake investigation (open risk from the dev report)

- **Runs: 79, failures: 0.**
  - 40 runs of the suite alone, 4 loops in parallel, at load 107–122.
  - 30 runs of the suite alone, 6 loops in parallel plus 12 induced busy loops, at load 121–158.
  - 9 runs of the 16-suite targeted set (multi-worker jest), 3 loops in parallel, at load 89–108. Every run: `Test Suites: 16 passed`, `Tests: 13 skipped, 249 passed`.
  - Raw per-run logs: `scratchpad/rr90/{par,busy,multi}-*.txt`.
- **The mechanism was reproduced on purpose** (see blocking 1). It is the only way I found for this suite to fail as "2 failed".
- **No real double-billing race in the code.** Leader order: re-check the cache under the lock → reserve → call → `setCachedSearchPage` (L1, then an awaited Redis SET) → release. So the lock is never gone before the page is visible. A late request that missed the cache and takes the lock after the release re-checks the cache and bills nothing. A waiter that sees no lock and no page re-reads the cache once before calling the flight vacant. A waiter that gives up defers and does not bill. The one stated residual (a leader slower than the 10 s lock TTL lets one waiter lead again, still inside every cap) is not reachable at these timings. In all 79 runs every seed showed exactly 1 call.
- Verdict: **a test-timing flake, with a cascade that makes it look like a billing bug.** Fixed in the test (blocking 1), not in the code.

## First-pass items, verified (mutants applied and restored by me, `scratchpad/rr90/mut.py`, output `mut-out.txt`, tree verified clean)

| Item | Mutant | Result |
|---|---|---|
| B1 release on refusal | `await release("abandoned")` removed | KILLED: 4 failed (both new tests × memory and upstash) |
| B1, extra | refused leader releases as `"failed"` instead | KILLED: 2 failed ("releases the flight" × both stores) |
| nit 3 | `FLIGHT_RETRY_MS = 1500` | KILLED: `Expected: >= 2000 Received: 1500` |
| nit 3, boundary | `LIVE_COOLDOWN_MS - 1` | KILLED: `Expected: >= 2000 Received: 1999` |
| nit 4 | no `del(errKey)` on acquire | KILLED: `Expected: "page" Received: "failed"` |
| nit 5 | legacy branch off on the flight deferral | KILLED: `Expected: 429 Received: 200` |
| nit 7 | Lua `>=` → `>` (IP cap) | Dev's real-Redis kill accepted. I re-ran the real-Redis suites on my own `redis:7-alpine` (:6438, stopped after): `Tests: 13 passed, 13 total` |

- **B1** is guarded at the route level, on both stores, with deterministic control points (a gate inside the reservation, a signal when a waiter appears), so the test does not depend on a lucky interleaving. The upstash variant also checks that the charge landed on device 2 (`:dev:` counters `[1, 1]`) and that no lock is left.
- **B2** copy is true whichever cap binds, in all three locales: en "…on this device or network…", es "…en este dispositivo o en esta red…", pt-BR "…neste aparelho ou nesta rede…". `i18n` suites: 21/21. The e2e spec adds `/neste aparelho ou nesta rede/i`, not run (lane constraint). The PR body's Testing Handoff quotes the new en and pt-BR strings.
- **nit 8**: the dev report's build section now gives the corrected header order in place.
- **nit 6**: left as optional, accepted.

## New diff, checked for regressions

- Clearing the err marker on acquire also helps the waiters of the old flight. If they had not read the marker yet, they now see the new leader's lock and wait for its page instead of degrading. The delete is best-effort and the reserve stays fail-closed. Correct.
- The legacy 429 on a flight deferral mirrors the cooldown path. A v2 client is unchanged (the test checks both).
- `FLIGHT_RETRY_MS` is imported from `LIVE_COOLDOWN_MS`, not repeated as a literal, and it is not exported (Next.js route-export rule). Correct.
- The new tests use `jest.doMock` inside `isolateModules` and `dontMock` afterwards, so no mock leaks into later tests.
- optional nit (pre-existing, not new here): on the in-process path, a waiter's `Promise.race` leaves its 6 s `sleep` timer running after the flight settles. That is why jest prints "did not exit one second after the test run". It is harmless in production. A cleared timer would quiet it.

## Lines that must appear

- `triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path` (the fix commit adds none; the first-pass NORM table stands).
- design-parity: not a UI-surface change beyond copy strings. The App Tester gate is still owed, as before.

## Gate state (not part of this verdict)

Unchanged from the first pass: App Tester PASS unchecked; full jest, real-Redis and e2e are owed on the final head after #89 merges; Cyber M-1's deployed-build probe carries to TICKET-119's close. Targeted evidence from me at `fc91d17`: single-flight 18/18 (×79 runs), the 16-suite set 249 passed / 13 skipped, real-Redis 13/13, i18n 21/21.
