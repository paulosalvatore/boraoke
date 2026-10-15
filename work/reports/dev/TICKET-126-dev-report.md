# TICKET-126 — Dev report (PR A: TICKET-119 + per-person caps + single-flight)

## Status
Opus review (D-022) REQUEST-CHANGES at `cd3c9ef`: both blocking items and nits 3, 4, 5, 7, 8 fixed (see "Opus review fixes" at the end), awaiting the re-review. Earlier: Cyber Security gate PASS (D-011, `work/reports/security/TICKET-126-security.md`); the in-PR fixes it asked for (M-1, L-1, L-3) are applied and M-2 / L-2 are filed as TICKET-131 / TICKET-132. The #89 re-gate's MEDIUM 7 (billed limiter churn across two IPs) is fixed here too, and its LOW 3 (legacy path sunset) is filed as TICKET-133. Merged `ticket/125-enter-idle-search` @ `638d427`. Verified with targeted jest only (lane constraint: no e2e, no build, no server); the full suite runs after #89 merges. PR B (TICKET-120) not started.

## Context
- Picking up from: fresh start. Phase 1 plan approved by the Product TM 2026-10-14 with amendments (recorded at the top of `work/plans/TICKET-126-plan.md`).
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t126-search-limits`
- Branch: `ticket/126-search-limits`, cut from `origin/ticket/125-enter-idle-search` @ `7be6824` (PR #89, which already contains #88).
- App/e2e port: 3126.
- PR: #90 https://github.com/paulosalvatore/boraoke/pull/90 (draft, base `ticket/125-enter-idle-search`; retarget to `main` after #89 merges).
- Ticket: `work/tickets/TICKET-126-per-person-search-limit-and-single-flight.md`. Follow-up filed: `work/tickets/TICKET-127-room-record-write-race.md`.

## Pre-build facts established

### Which IP header to trust (TICKET-119)
Primary source: https://vercel.com/docs/headers/request-headers
- `x-forwarded-for`: "we currently overwrite the X-Forwarded-For header and do not forward external IPs. This restriction is in place to prevent IP spoofing." (custom XFF only with the Enterprise Trusted Proxy add-on).
- `x-vercel-forwarded-for`: "identical to the x-forwarded-for header. However, x-forwarded-for could be overwritten if you're using a proxy on top of Vercel."
- `x-real-ip`: "identical to the x-forwarded-for header."

**Production check (TM-approved on condition of no prod data write).** `POST https://boraoke.com/api/host/claim?room=zzprobe126x` with a garbage `boraoke_claim_zzprobe126x` cookie. The room does not exist and the claim route charges the failure throttle without any room lookup or write, so the only write is the ephemeral `rl:hostclaim:<ip>` throttle counter. Each request rotated all three headers (`x-forwarded-for: 198.51.100.<rand>`, `x-real-ip: 203.0.113.<rand>`, `x-vercel-forwarded-for: 192.0.2.<rand>`). Raw status sequence:

```
1 401
2 401
3 401
4 401
5 401
6 401
7 401
8 401
9 401
10 401
11 429
12 429
13 429
14 429
```

One bucket despite rotating every header, so the edge overwrote what the client sent, and the host-code brute-force bound **holds in production**. Production's `clientIpFrom` reads `x-real-ip` first, so this directly proves `x-real-ip` is overwritten. That `x-vercel-forwarded-for` is overwritten rests on the doc ("identical"), not on this probe, because production code does not read it yet. TICKET-119's 1200-claim reset was a non-Vercel run (nothing overwrites headers under `next start`). No YouTube key was used.

### Upstash database type
Read-only, via `vercel env pull` to a mode-600 scratch file that was deleted right after, with no value printed: `INFO` reports `redis_mode:standalone`, `cluster_enabled:0`, `redis_version:8.4.0`, `upstash_version:1.18.1`. A read-only three-key `EVAL` (`EXISTS` x3 on absent keys) returned `200 [0,0,0]`. A multi-key script needs no hash tags. `UPSTASH_REDIS_REST_URL` and `KV_REST_API_URL` are the same database.

## Implementation log

### Build (commit `d2633d4`)
- **`lib/client-ip.ts` (new): the one IP derivation.** A declared `TRUSTED_CLIENT_IP_HEADER` wins. Otherwise on Vercel (`VERCEL=1`) the order is `x-real-ip` → `x-vercel-forwarded-for` → `x-forwarded-for` (first hop) (corrected in place after the opus review; this order landed with the Cyber M-1 fix below). Otherwise the shared `"unknown"` bucket (fail-closed). IPv6 is keyed by /64, IPv4-mapped IPv6 folds to IPv4, garbage is one length-capped bucket. `lib/host-auth.ts` re-exports it, so login, claim, rooms, queue, telemetry and search all use it. The search route's private XFF-first `clientIp()` is gone.
- **"server-derived" claims corrected** in `lib/host-auth.ts` (the `claimKey` docblock and the `clientIpFrom` docblock), `app/api/t/route.ts` and the search route. The round-3 report line lives in TICKET-104's report on its own (merged) branch history; the corrected statement is now in the code where the next reader looks.
- **`lib/search-budget.ts`: per-person sub-budgets.** `DEFAULT_DEVICE_DAILY_CAP = 10`, `DEFAULT_IP_DAILY_CAP = 45`, overridable by `SEARCH_DEVICE_DAILY_CAP` / `SEARCH_IP_DAILY_CAP` (positive integer, clamped to 90; anything else ignored with a warning). `reserveSearchCall(now, principal)` runs the new `RESERVE_PRINCIPAL_SCRIPT`: check platform, IP and device, then INCR all three or none, returning `-1/-2/-3` for which cap denied (platform checked first). Counter keys hold a sha256 digest, not the raw IP or uuid. A malformed reply or store error stays fail-closed. Calls without a principal keep the old platform-only script.
- **`lib/search-single-flight.ts` (new).** `SET sf:<cacheKey> <token> NX PX 10000`. The leader reserves, calls Google, fills the cache and releases with a compare-and-delete script. A failed upstream writes a 3 s `:err` marker first. Waiters poll the cache (150 ms, 6 s deadline). Outcomes: page (free), failed (degrade), vacant (one chance to lead), timeout (`deferred: "single-flight"` instead of billing). Acquire fails open to "solo" on a store error; the reservation behind it stays fail-closed. Without Upstash an in-process promise map does the same per process.
- **Route (`app/api/search/route.ts`).** Order: validate → velocity limit → cache → index → liveRequired → key → cooldown → single-flight → leader re-checks the cache → reserve (platform + IP + device) → Google. The device key is the httpOnly `boraoke_identity` cookie, else the uuid param, else `anon@ip`. Denial: `200 {degraded: true, reason: "personal-limit", results: []}`, one reason for both personal caps, no remaining counts.
- **Client (`components/SongSearch.tsx`).** `dailyLimited` became `limitCopy` (`dailyLimit` | `personalLimit` | null). Same notice slot, and load-more retires on either limit. New `Search.personalLimit` copy in en/es/pt-BR, in the existing em-dash register (reworded after the opus review to name "this device or network", see the review-fix section).
- **Test env.** `jest.env.ts` sets `VERCEL=1` (jest runs routes under Vercel's header trust; `client-ip.test.ts` covers off-Vercel by deleting it). `playwright.config.ts` declares `TRUSTED_CLIENT_IP_HEADER=x-forwarded-for` for the e2e server. `.env.example` documents all three env vars.

## Self-verification
- jest (full, load ~11 on 10 cores): **68 suites, 1,152 passed, 12 skipped, 0 failed** (the 12 skips include the opt-in real-Redis suites when `REDIS_TEST_URL` is unset).
- Real Redis (`docker run redis:7-alpine` on :6426, `REDIS_TEST_URL=redis://127.0.0.1:6426 npx jest principal-lua search-budget-lua`): **12 passed** (7 new, 5 existing).
- `npm run build`: compiled; `bundle-es-target: OK — all 50 chunk(s) parse at ES2019`; `css-target: OK` for the TV surface (6 pre-existing phone/desktop advisories).
- `tsc`: no errors outside `__tests__` / `e2e/advance-auth.spec.ts` (both pre-existing classes; the new test files only add the same missing-jest-types class).
- `node --test` at the repo root picks up the jest suites and fails on every one. CI runs it only for the rotation engine, so this is pre-existing and unrelated.
- **e2e full suite: 132/132 passed in 3.9 min**, `workers: 1`, `PORT=3126`, cold `.next-e2e` build. Load 5.8 at the start and 5.4 at the end on 10 cores. Before starting I checked that no playwright runner, `next start` or App Tester Chrome was live (#89's gate run had finished). `e2e/_canary` passed, and so did `e2e/tv.spec.ts:740`. The new spec `personal search share spent: own copy + paste-link still queues a song` passed.
- **e2e prove-can-fail:** with `limitCopyFor("personal-limit")` mutated to return null (generic copy), the new spec FAILS: `Error: expect(locator).toContainText(expected) failed ... Received string: "Busca indisponível — cola o link do YouTube"` (canary 2/2 passed in that run; source restored and tree verified clean).

### Concurrency probes
- **Single-flight** (`__tests__/search-single-flight.test.ts`): 20 concurrent identical requests on 4 simulated instances (separate module registries, so separate L1 caches) sharing one fake Upstash with seeded random per-command latency. **Exactly 1 `search.list` call**, all 20 answered with the same rows, platform +1, exactly one IP key and one device key charged, lock released. **8 seeds: `[1,1,1,1,1,1,1,1]`.** Negative control (lock disabled): **20 calls**. Upstream failure: 1 call, all 20 degraded.
- **Principal script under concurrency (real Redis):** 100 pipelined evals from one device → exactly 10 grants with distinct slots, 90 `-3`, platform counter 10.

## Prove-your-test-can-fail

**(a) Mutations** (`python3 t126-mut.py`, each restored afterwards). Every mutant KILLED:

| Mutant | Killed by |
|---|---|
| REVERSE: pre-fix `clientIpFrom` | client-ip (7 failed) |
| REVERSE: route reserves without a principal | personal-caps (13 failed) |
| REVERSE: no single-flight (waiter → solo) | single-flight (4 failed) |
| release skips the err marker | "upstream failure costs ONE call" |
| vacant reported as timeout | "abandons ... VACANT" |
| -2 maps to cap | "maps reply -2 ... ip" |
| personal denial reported as daily-limit | personal-caps (13 failed) |
| device key ignores identity cookie | "keys on the identity cookie" |
| memory path checks a personal cap before the platform | "reports a drained PLATFORM as daily-limit" |
| no clamp on override | "clamps an override" |
| override accepts 0 | "ignores a malformed override \"0\"" |
| Lua: INCR platform before the device check (real Redis) | 2 failed: `Expected: 10 Received: 12`; `Expected length: 90 Received length: 80` |
| TRUST-1 declared header falls back to the Vercel chain | added test (was SURVIVED, now KILLED) |
| TRUST-2 Vercel precedence `x-real-ip` first | "prefers x-vercel-forwarded-for" |

**(b) The new test file fails against the pre-fix implementation.** `client-ip.test.ts` against the TICKET-78 `clientIpFrom`, verbatim:

```
  ● off Vercel, with no declared trusted header › puts every rotating forged header into ONE bucket

    expect(received).toEqual(expected) // deep equality

    - Expected  -  1
    + Received  + 50

      Array [
    -   "unknown",
    +   "203.0.113.1",
    +   "203.0.113.2",
    +   "203.0.113.3",
    ...
```

The route-level reverse checks (no principal → 13 of 15 personal-cap tests fail; no single-flight → the probe sees 20 calls) are in the table above.

**(c) Hollowing-out.** A primitive DID change beneath existing assertions: `clientIpFrom` (every IP-bucket test) and the route's reservation call (`api-search-budget.test.ts`).
- The existing IP suites (`host-auth`, `host-claim`, `api-search`, `api-t`, `api-rooms`, `host-api`, `queue-rate-limit`) now run under `VERCEL=1`, the trust model production actually has. Their "different IP → different bucket" and "same IP → throttled" assertions still discriminate.
- The TICKET-78 test "same bucket regardless of forged XFF" proves `x-real-ip` precedence only. It was never a spoof-proofness test, and its describe now says so and points at `client-ip.test.ts`. The title that claimed "dev / non-Vercel" fallback was false under the new rules and is renamed "on Vercel".
- `api-search-budget.test.ts`'s drain tests use a distinct uuid and IP per request, so the platform cap (not a personal one) is still what binds. Re-examined, not vacuous: the drains still issue exactly 90 calls.

**(d) Triggered mutation pass: TRIGGERED.** `normaliseIpBucket` is a new normalisation function on an identity path (the IP is the anti-drain identity). 11 mutants (NORM-1 to NORM-11) plus 2 trust mutants. First pass: **3 SURVIVED-real-gap**:
- NORM-6, octet range unchecked;
- NORM-7, `::` may expand to zero groups;
- TRUST-1, a declared header falls back to the Vercel chain.

All three were fixed in-PR with new assertions (`::ffff:300.1.1.1` stays raw, `1:2:3:4::5:6:7:8` stays raw, a declared-but-absent header on Vercel is the shared bucket). **Second pass: 14/14 KILLED.** Raw outputs: scratchpad `t126-mutation.txt`, `t126-mutation-r2.txt`, `t126-lua-mutation.txt`, `t126-reverse-clientip.txt`.

## Friction
- `emit-event.sh --repo <worktree>` appended the `worktree_created` event to `work/events/by-branch/main.jsonl` inside the worktree, not to a ticket-branch file. I restored it at first; the commit script's own auto-commit then showed this is the repo's normal pattern (PR #89's branch also carries `main.jsonl` lines), so later events are committed as-is.

## 2026-10-15 — Cyber Security fixes (M-1, L-1, L-3) + follow-up tickets

**Merge.** `origin/ticket/125-enter-idle-search` @ `638d427` merged in `f0721c7` (no rebase, no force-push). One conflict, the import block of `app/api/search/route.ts`: #89 added `isLegacyClient` to the `live-search-gate` import, this branch added the client-ip / identity / single-flight imports. Resolved by keeping both. `npx jest api-search` after the merge: 4 suites, 60/60 passed.

**M-1, `lib/client-ip.ts`.** Vercel order is now `x-real-ip` → `x-vercel-forwarded-for` → `x-forwarded-for`. `x-real-ip` is the only header the 2026-10-14 production probe proved the edge overwrites, because the deployed code read it first. The module header no longer implies all three headers were verified; it says which one was and that the other two are fallbacks backed by the docs only. `lib/host-auth.ts`'s re-export note now says "`x-real-ip` verified against production". Tests: the precedence test now expects `x-real-ip` first, plus a new test where 20 forged `x-vercel-forwarded-for` values all land in the `x-real-ip` bucket.

**L-1, `lib/search-single-flight.ts`.** Lock and error-marker keys are now `sf:lock:<cacheKey>` and `sf:err:<cacheKey>`. The marker sits in front of the user-typed text, so no query can produce the other namespace. `lockKey` / `errKey` are exported for the regression test. The in-process path is a single map keyed by the cache key and was never affected.

**L-3.** `app/api/host/claim/route.ts` contract item 5 and the `lib/host-auth.ts` claim-throttle note no longer say "server-derived". Both now say: the client IP from `clientIpFrom`, edge-written (not client-chosen) on Vercel or behind a declared trusted proxy, and the shared "unknown" bucket elsewhere. `grep -rn -i 'server-derived' app lib` → only `lib/host-auth.ts:451`, which is the line that already says it is "not server-derived in any stronger sense".

**Follow-up tickets.**
- `work/tickets/TICKET-131-ipv6-per-ip-search-cap.md` (M-2): the per-IP cap of 45 is half the day, and IPv6 is keyed at /64. Probe numbers: 256 addresses in one /56 → 256 buckets, one /64 → 1 bucket. Options: /56 keying, a coarser counter in the same script, or a cap below half.
- `work/tickets/TICKET-132-identity-cookie-lets-strangers-spend-a-patrons-searches.md` (L-2): the patron uuid is public via `GET /api/queue` and is the device key. While writing it I found a second door: the `u:<uuid>` fallback key comes from the `uuid` query parameter, which is the same public value. So signing the cookie alone is not enough, and the ticket says so.

### Self-verification (targeted jest only)

```
$ npx jest client-ip search-single-flight search-budget-principal api-search-personal-caps host-auth api-search-budget api-search host-claim
PASS __tests__/client-ip.test.ts
PASS __tests__/search-budget-principal.test.ts
PASS __tests__/api-search-index-tier.test.ts
PASS __tests__/api-search.test.ts
PASS __tests__/host-auth.test.ts
PASS __tests__/api-search-personal-caps.test.ts
PASS __tests__/api-search-budget.test.ts
PASS __tests__/host-claim.test.ts
PASS __tests__/search-single-flight.test.ts
Test Suites: 9 passed, 9 total
Tests:       172 passed, 172 total
```

Every other suite that references `VERCEL`, `x-vercel-forwarded-for` or the `sf:` keyspace (client-ip, host-auth, search-budget, search-principal-lua.integration, search-single-flight): 6 suites, 109 passed, 7 skipped (the real-Redis integration suite skips with no Redis, the same as before).

### prove-your-test-can-fail

**(a) Which mutation kills each new assertion.**
- M-1 precedence test and forged-xvff test: swap `x-real-ip` and `x-vercel-forwarded-for` back in `VERCEL_IP_HEADERS`.
- L-1 regression test: make the two prefixes equal and append `:err` (the old scheme). This kills both the key-level assertions and the behaviour assertions.

**(b) The new tests FAIL against the pre-fix implementation (verbatim).**

M-1, test file run against the pre-fix `lib/client-ip.ts` (stashed):
```
    ✕ prefers x-real-ip (the production-verified header), then x-vercel-forwarded-for, then x-forwarded-for (1 ms)
    ✕ a forged x-vercel-forwarded-for cannot move the bucket while x-real-ip is present (2 ms)
  ● on Vercel (edge-written headers) › prefers x-real-ip (the production-verified header), then x-vercel-forwarded-for, then x-forwarded-for
    Expected: "192.0.2.2"
    Received: "192.0.2.1"
  ● on Vercel (edge-written headers) › a forged x-vercel-forwarded-for cannot move the bucket while x-real-ip is present
    - Expected  -  1
    + Received  + 20
Tests:       2 failed, 22 passed, 24 total
```

L-1, against the old key scheme (`sf:<ck>` / `sf:<ck>:err`, with the builders exported so the test could load):
```
    ✕ a lock for query X:err is never read as query X's error marker (key namespaces cannot collide) (40 ms)
  ● module protocol (Redis path) › a lock for query X:err is never read as query X's error marker (key namespaces cannot collide)
    Expected: not "sf:BR::abc:err"
Tests:       1 failed, 10 skipped, 11 total
```

The same test with the two key-level assertions removed, so only the behaviour assertions run, also against the old scheme. The `abc` waiter got `failed` instead of `vacant`:
```
    ✕ a lock for query X:err is never read as query X's error marker (key namespaces cannot collide) (23 ms)
  ● module protocol (Redis path) › a lock for query X:err is never read as query X's error marker (key namespaces cannot collide)
    - Expected  - 1
    + Received  + 1
Tests:       1 failed, 10 skipped, 11 total
```

After restoring the fix, `npx jest search-single-flight` gives 11/11 passed.

**(c) Hollowing-out.** A primitive changed beneath existing assertions: the Vercel header precedence in `clientIpFrom`. I re-examined the assertions that depend on it:
- The `host-auth` "same bucket regardless of forged XFF" test sends `x-real-ip` plus forged XFF. It still discriminates, and is now aligned with the first-trust header.
- The `client-ip` IPv6 /64 test sends only `x-vercel-forwarded-for`, so it still exercises normalisation through the fallback.
- The single-flight probe's "lock released" assertion filters on `startsWith("sf:")`. It still covers both new namespaces, which share the `sf:` stem.

**(d)** `triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path` (the change is a key-prefix rename and a header reorder; `normaliseIpBucket` is unchanged and its 14/14 mutation pass above stands).

**Not run, by lane constraint:** e2e, `next build`, servers. These are owed in the full-suite run after #89 merges.

## 2026-10-15 — #89 re-gate MEDIUM 7 (billed limiter churn) + legacy sunset ticket

The source is the TICKET-125 re-gate report (`work/reports/security/TICKET-125-security.md`, on `ticket/125-enter-idle-search` at `c496cbc`; not yet in this tree because it landed after `638d427`).

**MEDIUM 7, `lib/youtube-search.ts` `rateLimitOk`.** The billed limiter gets the same treatment the index limiter got on #89.
- The `ip:` bucket is checked first, and a request it rejects returns before any `u:<uuid>` key is inserted. An address can therefore add at most RATE_IP_MAX uuid keys per window, whatever it floods, so it cannot churn the 2,000-key LRU and evict a second address's `ip:` bucket.
- A request that passes the IP bucket is still charged there even when its uuid bucket rejects, so the "rotating uuids cannot dodge IP accounting" property holds.
- The MEDIUM #2 header comment no longer claims the IP key is "never the LRU victim"; that was only ever true for the flooding address's own key.
- I did not add a separate `ip:` map (the optional suggestion). With no insert on rejection the probe already holds. The remaining churn source is many distinct addresses, which is the TICKET-131 (IPv6 /56) class.

**Regression tests** (`__tests__/search-rate-isolation.test.ts`, new describe):
- "probe (e)": over 30 simulated seconds, IP B sends 40/s and IP A sends 2,100/s with fresh uuids. IP B must stay ≤ 90 (3 windows × RATE_IP_MAX).
- A second test checks that 5,000 requests from one IP leave exactly RATE_IP_MAX + 1 buckets.

Pre-fix run (verbatim, current `rateLimitOk`):
```
    ✕ probe (e): IP B stays at its per-IP ceiling while IP A floods fresh uuids (280 ms)
    ✕ a request rejected by the IP bucket adds no uuid key (26 ms)
    Expected: <= 90
    Received:    900
    Expected: 31
    Received: 2000
Tests:       2 failed, 3 passed, 5 total
```
900 is exactly the gate's probe (e) figure. Post-fix, every suite that touches the search route, limiter or live gate:
```
PASS __tests__/live-search-gate.test.ts
PASS __tests__/api-search-index-tier.test.ts
PASS __tests__/youtube-search.test.ts
PASS __tests__/api-search.test.ts
PASS __tests__/api-search-personal-caps.test.ts
PASS __tests__/search-pagination.test.ts
PASS __tests__/api-search-budget.test.ts
PASS __tests__/search-rate-isolation.test.ts
PASS __tests__/search-single-flight.test.ts
Test Suites: 9 passed, 9 total
Tests:       134 passed, 134 total
```
The combined targeted set (client-ip, single-flight, budget/principal incl. Lua integration, personal caps, host-auth, host-claim, api-search*, rate isolation, youtube-search): 14 suites, 244 passed, 12 skipped (Redis integration skips without Redis).

**Prove-your-test-can-fail.**
- (a) Mutation that kills the new assertions: restoring the uuid-first order, or any insert of the uuid key before the IP verdict.
- (b) The pre-fix run is shown above.
- (c) Hollowing-out: `rateLimitOk`'s order is a primitive under the existing `youtube-search.test.ts` limiter tests. Re-examined:
  - "caps rotating uuids from one IP" still trips on the IP bucket.
  - "uuid bucket" / "recovers after the window slides" / "no IP" still exercise the uuid bucket. The uuid bucket is reached only after the IP passes, and those tests stay under RATE_IP_MAX.
  - The LRU-cap tests use `ip=""` or rotate across many IPs, so they still bound the map.
- (d) `triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path` (reorder of an existing limiter).

**Ticket filed.** `work/tickets/TICKET-133-retire-legacy-search-live-fallback.md` (Cyber LOW 3 on #89): sunset the no-`v=2` live fallback once pre-#125 tabs have aged out.

## Opus review fixes (REQUEST-CHANGES at `cd3c9ef`, `work/reports/review/TICKET-126-review.md`)

Lane constraint unchanged: targeted jest and the real-Redis suite only. No e2e, no `next build`, no server.

**Blocking 1, the route's lock release on a personal-cap refusal is now guarded.** New `route wiring` block in `__tests__/search-single-flight.test.ts`, run on both the in-process store and the fake Upstash keyspace. The harness adds control points only: a gate inside one device's reservation and a signal when a waiter appears, so the order is fixed, not lucky.
- "releases the flight": device 1 has spent its one search (`SEARCH_DEVICE_DAILY_CAP=1`), leads "shared song" and is paused inside its reservation. Device 2 asks the same query and becomes its waiter. Device 1 is refused with `personal-limit`. Device 2 is then answered with the rows (no `deferred`), 1 new billed call, and the charge lands on device 2: its next fresh query is refused `personal-limit`, and on Upstash the two `:dev:` counters are `[1, 1]` with no lock left behind.
- "a later identical request after the refusal is ANSWERED": device 1 is refused alone, then device 3 sends the same query and gets the rows, not `deferred`.

**Blocking 2, copy is true for both caps.** Used the reviewer's wording, with "device" rather than "phone" in en (laptops search too):
- en: "Live searches are used up for today on this device or network — karaoke catalogue results still work, or paste a YouTube link"
- es: "Se acabaron las búsquedas en vivo de hoy en este dispositivo o en esta red — el catálogo de karaoke sigue funcionando, o pega un enlace de YouTube"
- pt-BR: "As buscas ao vivo de hoje acabaram neste aparelho ou nesta rede — o catálogo de karaokê continua funcionando, ou cole um link do YouTube"

`i18n-completeness` passes (parity kept). `e2e/search.spec.ts` keeps its two assertions and adds `/neste aparelho ou nesta rede/i`. The e2e was not run (lane constraint). The five regexes it uses were checked against the new pt-BR string with node: `/buscas ao vivo de hoje/i=true /neste aparelho ou nesta rede/i=true /catálogo de karaokê/i=true /Busca indisponível/i=false /Chegamos ao limite/i=false`.

**Nit 3.** `FLIGHT_RETRY_MS = LIVE_COOLDOWN_MS` (2000, imported, not a second literal). Not exported, because Next.js route files may only export route fields. Test: a waiter that times out is told `retryAfterMs >= LIVE_COOLDOWN_MS`, and its retry at exactly that time, with the real cooldown, is answered rather than deferred.

**Nit 4.** A leader that acquires the Redis lock now deletes the `sf:err:` marker (best effort, inside try/catch), so the marker is scoped to the flight that set it. Module test: flight 1 fails, flight 2 leads inside the marker's 3 s life, its waiter polls a few times, and flight 2 fills. The waiter must get the page, not `failed`. The in-process path needs no change because each flight has its own settle promise.

**Nit 5.** A legacy (no `v=2`) client whose wait gives up now gets the same 429 `searchRateLimited` as the cooldown path. Test: a legacy request gets 429 with no `deferred`, and a v2 request in the same state still gets `deferred: "single-flight"`.

**Nit 7.** Added "the IP cap is INCLUSIVE" to `search-principal-lua.integration.test.ts`: a network exactly at its cap is refused, even for a brand-new device. Real Redis (`docker run --rm -d --name t126-redis-fix -p 6427:6379 redis:7-alpine`, `REDIS_TEST_URL=redis://127.0.0.1:6427 npx jest principal-lua search-budget-lua --verbose`), container stopped after:
```
    ✓ grants the device cap, then returns -3 and charges NOTHING on the denial (17 ms)
    ✓ returns -2 at the IP cap before the device cap, charging nothing (5 ms)
    ✓ the IP cap is INCLUSIVE: a network at exactly its cap is refused, even for a brand-new device (4 ms)
    ✓ returns -1 when the platform is spent, ahead of any personal reason (3 ms)
    ✓ sets TTLs on create only, on all three keys (7 ms)
    ✓ grants exactly the device cap under 100 pipelined concurrent evals from one device (8 ms)
    ✓ deletes the lock only for the token that holds it (5 ms)
    ✓ an expired leader cannot delete the next leader's lock (125 ms)
    ✓ counts down to 0 then returns the -1 sentinel, which never collides (24 ms)
    ✓ sets the TTL on CREATE only (the day key must not have its life extended) (22 ms)
    ✓ treats a missing key as zero used (9 ms)
    ✓ FAILS CLOSED (errors) rather than granting when the key holds garbage (12 ms)
    ✓ grants exactly `budget` times under 300 pipelined concurrent evals (23 ms)
Tests:       13 passed, 13 total
```
Mutant `used(KEYS[2]) >= ipCap` → `>` against the same Redis:
```
    ✕ returns -2 at the IP cap before the device cap, charging nothing (18 ms)
    ✕ the IP cap is INCLUSIVE: a network at exactly its cap is refused, even for a brand-new device (7 ms)
Tests:       2 failed, 6 passed, 8 total
  ● RESERVE_PRINCIPAL_SCRIPT executed by a real Redis › the IP cap is INCLUSIVE: a network at exactly its cap is refused, even for a brand-new device
    Expected: -2
    Received: 87
```
The existing -2 test already killed this mutant on real Redis (`Expected: -2 Received: 86`). It only survives the default jest run because that suite is skipped without `REDIS_TEST_URL`. Running the opt-in suites in the full-suite lane is a gate question for the TM, not a fix in this PR.

**Nit 8.** The build section's Vercel header order is corrected in place to `x-real-ip` → `x-vercel-forwarded-for` → `x-forwarded-for`.

**Nit 6 not changed.** The reviewer marked it optional, and the code order is already right.

### Prove-your-test-can-fail
(a)/(b): each mutant was applied to the shipped code, the single-flight suite was run, and the file was restored (`cmp` against a saved copy).

| Mutant | Result |
|---|---|
| M1 remove `await release("abandoned")` (route) | KILLED: 4 failed (both new tests × both stores), `Tests: 4 failed, 14 passed, 18 total` |
| M3 `FLIGHT_RETRY_MS = 1500` | KILLED: `Expected: >= 2000 Received: 1500`. With that assertion removed too, the behavioural half still fails: `expect(retry.deferred).toBeUndefined() Received: "live-cooldown"` |
| M4 no `del(errKey)` on acquire | KILLED: `Tests: 1 failed, 17 passed, 18 total` (stale-marker test) |
| M5 legacy branch disabled on the flight deferral | KILLED: `Tests: 1 failed, 17 passed, 18 total` (legacy 429 test) |
| Lua IP `>=` → `>` (real Redis) | KILLED: see above |

M1 verbatim:
```
  ● route wiring › a leader refused for its PERSONAL cap (memory store) › releases the flight: the waiting device leads, is answered, and is charged to ITS OWN device

    expect(received).toBeUndefined()

    Received: "single-flight"

    > 401 |         expect(answered.deferred).toBeUndefined();

  ● route wiring › a leader refused for its PERSONAL cap (upstash store) › a later identical request after the refusal is ANSWERED, not told to try again

    expect(received).toBeUndefined()

    Received: "single-flight"

    > 431 |         expect(later.deferred).toBeUndefined();
```
(c) The only primitive change is the marker delete on acquire. The existing "upstream failure costs ONE call and every waiter degrades" test was re-examined: its waiters still see the failed leader's marker because no new leader acquires in that window. It still passes, and it is not vacuous, because it counts calls and checks every body is degraded.
(d) `triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`.

### Self-verification
16 targeted suites, every one that touches the search route, limiter, live gate, flight, budget, IP derivation or i18n parity:
```
Test Suites: 16 passed, 16 total
Tests:       13 skipped, 276 passed, 289 total
```
(The 13 skips are the real-Redis suites without `REDIS_TEST_URL`. They passed 13/13 against real Redis above.) `npx tsc --noEmit -p .` exits 0.

**Flake note, not reproduced.** The very first run of the 14-suite set, while another lane was loading the machine, showed `search-single-flight` with 2 failed (`Tests: 2 failed, 5 skipped, 243 passed`). The output was not kept, so the failing tests are unknown. After that, 6 sequential reruns, 2 cold-cache reruns, 4 concurrent ×5-suite runs and 10 concurrent single-suite runs all passed: about 22 runs, 0 failures. The likeliest candidate is the existing cross-instance probes under heavy CPU: a request that arrives after the leader has finished becomes a second leader and bills again. That exposure existed before this change. Flagged for the full-suite lane to watch.

## 2026-10-15 — merge main (#89 squash), re-review blocking item, final-head verification

**Status:** re-review blocking item fixed; full verification green on `4761cd4` (code head `ac0f0f1`). Waiting on Reviewer re-check and App Tester.

### Merge of main (`5d95dd2`)
#89 was squash-merged as `4d1940e`; this branch carried #89's commits unsquashed (last merged-in #89 tip `638d427`). Merged `origin/main` with no rebase or force-push. Resolution: index and tree set to main's exact tree, then the net TICKET-126 diff (`638d427..51ea5b3`) re-applied with a 3-way apply. One hunk conflicted: the response-shape doc comment in `app/api/search/route.ts`, where main added the legacy-cooldown line (#89 nit) and this branch added the `single-flight` and `personal-limit` lines. Kept all three. Check: `git diff --numstat 638d427 51ea5b3` and `git diff --numstat origin/main <merge>` are byte-identical (37 files, TICKET-126 only).

### Reviewer blocking 1 (PR comment 6192701774): probe timeouts (`ac0f0f1`)
- Every cross-instance `fire()` probe has an explicit `PROBE_TIMEOUT_MS = 30_000` (the 20-request, negative-control, upstream-failure and distinct-queries probes).
- The 8-seed probe is now `it.each([1..8])`, one test per seed, so a timeout strands at most one probe's requests.
- Optional nit taken: the in-process waiter clears its 6 s deadline timer once the leader settles.

Before (the merge head `8e27971`, tests as reviewed), `npx jest __tests__/search-single-flight.test.ts --testTimeout=1000`, load 103.93:
```
    ✓ 20 requests on 4 instances produce ONE billed call (350 ms)
    ✕ holds across 8 different interleavings (seeds), not one lucky schedule (1028 ms)
    ✕ NEGATIVE CONTROL: with the lock disabled the same probe bills every request (80 ms)
    ✓ an upstream failure costs ONE call and every waiter degrades instead of retrying (185 ms)
    ✓ different queries are not serialised behind each other (74 ms)
    ...
    thrown: "Exceeded timeout of 1000 ms for a test.
    Expected: 20
    Received: 21
Tests:       2 failed, 16 passed, 18 total
```
After (`ac0f0f1`), same command, load 120.84, run twice, both:
```
    ✓ 20 requests on 4 instances produce ONE billed call (778 ms)
    ✓ holds across different interleavings: seed 1 bills ONE call (253 ms)
    ... seeds 2-8 ✓ ...
    ✓ NEGATIVE CONTROL: with the lock disabled the same probe bills every request (231 ms)
    ✓ an upstream failure costs ONE call and every waiter degrades instead of retrying (244 ms)
    ✓ different queries are not serialised behind each other (272 ms)
Tests:       25 passed, 25 total
```
(c) no primitive beneath existing assertions changed (the timer clear does not change what `waitForSearchFlight` returns; its timeout path is still covered by "a waiter whose leader never answers times out").
(d) `triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path`.

### Final-head verification (`4761cd4`)
The machine was not quiet (other tabs keep load at 100-250 on 10 cores); per the TM, ran once no other boraoke jest/playwright/next run was live, load recorded per run.
- **Full jest** (load 149.00 → 145.06): `Test Suites: 70 passed, 70 total` / `Tests: 18 skipped, 1182 passed, 1200 total`.
- **Real Redis** (own `redis:7-alpine` on :6446, `REDIS_TEST_URL=redis://127.0.0.1:6446 npx jest principal-lua search-budget-lua`, load 144.41 → 150.79): `Test Suites: 2 passed, 2 total` / `Tests: 13 passed, 13 total`. Container stopped after (0 left running).
- **`npm run build`** (load 152.06 → 148.04): exit 0, `✓ Compiled successfully`, `bundle-es-target: OK — all 50 chunk(s) parse at ES2019.`, `css-target: OK — the TV surface uses nothing newer than Chrome 68`.
- **e2e, one full run**, `PORT=3126 npx playwright test --workers=1` (load 139.54 → 102.11): canary 2/2 green, `134 passed (7.4m)`, 0 failed, 0 flaky. Includes the new `/neste aparelho ou nesta rede/` assertion.

### Correction
Earlier sections say `npx tsc --noEmit -p .` exits 0. In this worktree it does not: `@types/jest` is not a declared dependency (never in `package.json` history), so every `__tests__/` and `e2e/` file reports `Cannot find name 'jest'/'expect'` (3,908 errors). Zero errors are outside `__tests__/` and `e2e/`, and `next build` type-checks the app clean. Pre-existing and not from this diff (`package.json` is untouched here); worth a small ticket if the TM wants `tsc` over tests.

## 2026-10-15 — caps raised at the TL OK (30/device, 90/IP)

TL (via Global TM prompt 033): "Lets increase the numbers, because we are rebuilding the search mechanism to allow more searchs. Otherwise the app will be shitty". The caps only stop one abuser; they must never throttle a normal patron.

- `lib/search-budget.ts`: `DEFAULT_DEVICE_DAILY_CAP` 10 → **30**; `DEFAULT_IP_DAILY_CAP` 45 → **`SEARCH_DAILY_BUDGET` (90)**, so the per-network share never binds before the platform cap in one bar. Reasoning comment rewritten with the new intent and the TL quote. Env overrides and the clamp to the platform budget unchanged. No Vercel env vars set; the defaults carry it.
- `.env.example`: commented defaults now 30/90.
- `__tests__/api-search-personal-caps.test.ts`: new `default caps` block (defaults load as 30/90 and `ipDailyCap() === SEARCH_DAILY_BUDGET`; overrides load and clamp; with default caps one network spends the whole platform day and the 91st call is `daily-limit`, not `personal-limit`). The per-IP cap test now sets `SEARCH_IP_DAILY_CAP=5` (at 90 the platform cap answers first). `parseCapOverride` fallbacks 45 → 30.
- Mutation check: with the old defaults (10/45) restored, `-t "default caps"` gives `Tests: 2 failed, 15 skipped, 1 passed` (the 30/90 assertion and the one-network-drains-the-day test fail); restored to 30/90 after.
- Targeted (load 88.59): personal-caps, budget-principal, search-budget, api-search-budget, single-flight, client-ip, i18n-completeness, i18n-locales → `Test Suites: 8 passed, 8 total` / `Tests: 150 passed, 150 total`.
- Full jest (load 70.70 → 68.09): `Test Suites: 70 passed, 70 total` / `Tests: 18 skipped, 1185 passed, 1203 total` (1182 + 3 new).
- `tsc --noEmit`: zero errors outside `__tests__/` and `e2e/` (pre-existing `@types/jest` gap, see Correction above).
- e2e: no spec asserts 10/45 (only `e2e/search.spec.ts` mocks a `personal-limit` reply), so no re-run for a constant change.
