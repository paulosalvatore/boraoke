# TICKET-126 — Cyber Security report (PR #90, PR A: TICKET-119 + per-person caps + single-flight)

## Status
D-011 gate complete. **Verdict: PASS** (no BLOCKER/HIGH). Two MEDIUM, three LOW, four INFO, all non-blocking. Merge condition carried from M-1: run the x-vercel-forwarded-for probe against the deployed build (or a preview) before calling TICKET-119 closed. S1 caveat: boraoke has no `verify-green-local.sh` and PR #90 has no CI checks; full-suite GREEN is owned by the concurrent full-suite lane and must be GREEN before merge.

## Context
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t126-search-limits`
- Branch: `ticket/126-search-limits`, base `ticket/125-enter-idle-search` (PR #89, stacked)
- PR: #90 https://github.com/paulosalvatore/boraoke/pull/90 (draft)
- Head audited: `560c61c842560eef82eccf6febf91a759870414c` (equal to `origin/ticket/126-search-limits` after fetch)
- Scope: `git diff origin/ticket/125-enter-idle-search...HEAD` (29 files, +2136/-80), plus blast radius: every IP-keyed throttle call site, `lib/live-search-gate.ts`, `lib/youtube-search.ts` `cacheKey`, `lib/identity.ts`, `GET /api/queue`, and the production claim route on `origin/main`.

## Log

### 2026-10-15 audit

**Tests run (targeted only, per lane constraint):** `npx jest client-ip search-budget-principal search-single-flight api-search-personal-caps host-auth api-search-budget api-search host-claim` → 8 suites, 149/149 passed. No e2e, no build, no server, no Docker Redis (the Lua was audited by reading plus the Dev's recorded real-Redis run). Probes: ts-node scripts in the agent scratchpad, output quoted below.

#### Findings (severity-ranked)

**M-1 MEDIUM: the new first-trust header `x-vercel-forwarded-for` has not been tested against production. Only `x-real-ip` has.** `lib/client-ip.ts:46` puts `x-vercel-forwarded-for` first on Vercel. The 14-claim production probe ran against `origin/main`, whose `clientIpFrom` reads `x-real-ip` first, so it proves only that `x-real-ip` is overwritten. The Dev report says this. The module header at `lib/client-ip.ts:19-21` does not: it reads as if all three headers were verified. The Vercel doc (re-fetched 2026-10-15) says the header is "identical to the x-forwarded-for header" and does not say a client-sent copy is stripped. The inference is strong, because the header exists to survive a proxy placed in front of Vercel, which means Vercel writes it from the connection. It is still an inference. If it is wrong, this PR reopens both the host-code brute-force bound (login/claim) and the per-IP search cap in production. Today's code is not exposed to that. Probe P2: `clientIpFrom({x-vercel-forwarded-for:1.1.1.1, x-real-ip:2.2.2.2, x-forwarded-for:3.3.3.3})` → `1.1.1.1`. Remediation: before closing TICKET-119, re-run the same zero-data claim probe against the deployed build (or a preview) with ONLY `x-vercel-forwarded-for` rotated, and expect a 429 by attempt 11. Alternatively, put `x-real-ip` first, since it is the empirically proven one. Also correct the header comment to say which header the production check covered. Not blocking: the likelihood is low and the check is cheap, but it must not be skipped.

**M-2 MEDIUM (accepted design residual, restated with the arithmetic): two addresses drain the platform day.** IP cap 45 = half of 90. A dual-stack phone natively has two buckets (an IPv4 plus an IPv6 /64), and IPv6 is keyed at /64. Many ISPs delegate a /56 or a /48 to one subscriber. Probe P1: 256 addresses from one /56 → **256 distinct buckets** (one /64 → 1 bucket, correct). So a single ordinary subscriber, not a botnet, can still spend the whole day. The plan states the "many-IP attacker" trade-off explicitly, which is why this is MEDIUM and not HIGH. The PR still clearly improves on today (one device at 100%). Remediation direction (follow-up ticket, not this PR): key IPv6 at /56 (or add a coarser /48 counter in the same script), and/or bring the IP cap below half so draining takes three or more networks.

**L-1 LOW: single-flight lock and error-marker keys collide across queries.** `lockKey(ck)=sf:<ck>` and `errKey(ck)=sf:<ck>:err`. `cacheKey` lowercases `q` and allows `:`, so the query `X:err` owns the lock key that equals query `X`'s error key. Probe P4: `errKey(cacheKey("abc")) === lockKey(cacheKey("abc:err"))` → `sf:BR::abc:err`, collide `true`. Effect: while someone leads a billed search for `<song>:err`, waiters of a concurrent `<song>` flight read the lock token as an error marker and degrade with `reason:"error"`. A failed `<song>` leader also blocks `<song>:err` for 3 s. The attacker pays a billed call (inside their own caps) per hold, and only concurrent waiters are affected. This does not poison the cache, because waiters never write. Remediation: use a namespace the query side cannot produce, e.g. `sf:err:<ck>` / `sf:lock:<ck>`, or hash `ck`.

**L-2 LOW: a third party can spend a patron's device share.** `deviceKey` (`app/api/search/route.ts:80-85`) prefers the `boraoke_identity` cookie. That value is the patron uuid (`lib/identity.ts:206`), and `GET /api/queue` returns raw `QueueEntry` objects, including `patronUuid` (`lib/store/types.ts:20`, `app/api/queue/route.ts:44-60`), to anyone. Repro: read a room's queue, then send 10 live searches with `Cookie: boraoke_identity=<victim uuid>` and distinct queries. The victim gets `personal-limit` for the rest of the day. Cost to the attacker: 10 of their own IP's 45. The victim keeps index, cache and paste-link. The plan calls the device key "client-minted and rotatable" (attacker evasion) but does not mention this direction (charging a victim). Remediation: accept and document, or sign the identity cookie (HMAC) so a forged value falls through to the `u:` / `anon@ip` key. Low priority.

**L-3 LOW (doc accuracy, plan §1 item not fully done): two "server-derived" contract claims remain.** `app/api/host/claim/route.ts:50` ("keyed on the SERVER-DERIVED client IP … a caller cannot choose its own bucket key") and `lib/host-auth.ts:391` ("The key is **server-derived** (the edge-set client IP)"). This is the same class of false contract statement that TICKET-119 was filed to correct. Remediation: re-word both to the qualified statement already used at `lib/host-auth.ts:409-413`.

**I-1 INFO: a declared `TRUSTED_CLIENT_IP_HEADER` overrides the Vercel chain even on Vercel.** Probe P3: with `VERCEL=1` and `TRUSTED_CLIENT_IP_HEADER=X-Client-IP`, the client-sent `x-client-ip: 6.6.6.6` wins. This is only exploitable through operator misconfiguration. Production does not set it today (`vercel env ls production` names checked: no `TRUSTED_CLIENT_IP_HEADER`, no `SEARCH_*`). Consider ignoring the declaration when `VERCEL=1` (or allowing only the three edge headers there), or warn at boot.

**I-2 INFO: cap override parsing.** `parseCapOverride` (`lib/search-budget.ts`). Probe P5: `"0"`, `"-5"`, `"4.5"`, `"NaN"`, `"Infinity"`, `"abc"`, `"1_0"`, `""` → default; `"9999"` → 90 (clamped); `"0x2d"` → 45 and `"1e1"` → 10 (accepted through `Number()`). Every result lands in [1, 90], so a typo can never lift a cap above the platform budget or remove one. OK. Hex and exponent forms are odd but harmless.

**I-3 INFO: Lua partial charge on a corrupted counter is fail-closed.** In `RESERVE_PRINCIPAL_SCRIPT`, `used()` coerces a non-numeric value to 0. A later `INCR` on such a key errors after the platform `INCR` has already run, and Redis does not roll back. The route then denies (`reason:"store"`), so the failure is fail-closed. It is unreachable in practice: the `sb:<day>:ip|dev:<sha256>` keys are written only by this script.

**I-4 INFO: in-memory flight leak only on an unexpected throw.** In the memory driver, a leader that threw between `acquireSearchFlight` and `release` would leave the `memFlights` entry in place, and later identical queries in that process would defer. Every call in that window (`getCachedSearchPage`, `reserveSearchCall`, the try/catch around Google) is non-throwing by contract, and the Redis path self-heals through the lock TTL. No action needed.

#### Focus-area confirmations (evidence)

1. **`lib/client-ip.ts`**
   - Off Vercel with no declaration, every forged header lands in `"unknown"` (probe P3b; fail-closed).
   - On Vercel with no headers it returns `"unknown"` (P2b).
   - Precedence on Vercel is xvff → x-real-ip → XFF first hop. The declared header wins (see I-1).
   - IPv4-mapped IPv6 folds to IPv4 (`::ffff:1.2.3.4` and `::FFFF:0102:0304` → `1.2.3.4`).
   - Garbage values are length-capped at 64 characters (a 200-char value → 64).
   - **Call sites (proof-by-absence):** `git grep` over the tracked `app/`, `lib/`, `components/` and `middleware.ts` (108 files, tool ran over the fileset) finds zero reads of `x-forwarded-for` / `x-real-ip` / `x-vercel-forwarded-for` / `req.ip` outside `lib/client-ip.ts` (the other hits are comments). `clientIpFrom` is the only derivation used by host/claim, host/login, queue POST, rooms POST, search and telemetry `/api/t`. The search route's private `clientIp()` is gone. `middleware.ts` only sets a pathname header.

2. **Atomic charge**
   - Platform/IP/device are checked, then all three are INCR'd or none (one Lua EVAL, atomic in Redis). The memory path does the same in one synchronous block.
   - A non-integer reply is denied (the F-1 type guard is retained). A Redis error or an unusable store → `reason:"store"` deny (fail-closed).
   - **There is one `searchYouTubePage` call site** (`app/api/search/route.ts:324`). It sits strictly after a successful `reserveSearchCall` with a principal, and every live path reaches it only through that reserve:
     - `pageToken` (`liveAllowed` → true);
     - legacy no-`v=2` (`isLegacyClient` → true);
     - IDXLIVE escape (`INDEX_MORE_TOKEN` → live first page).
   - The `solo` (lock-store-error) path also goes through the reserve. Deferred and cooldown responses return before it, and so do single-flight waiters.
   - No other code calls `search.list` (`git grep googleapis`: only `youtube-search.ts` SEARCH_ENDPOINT; `harvest.ts`/`youtube.ts` use other endpoints).

3. **Single-flight**
   - `SET NX PX 10000` with a random token, and a compare-and-delete release.
   - Leader crash: the lock expires in 10 s and waiters defer at 6 s.
   - Maximum wait is about 12 s: one wait, then on `vacant` one re-acquire and one more wait, then `deferred`. No unbounded loop: `attempt >= 1` exits.
   - Waiters never call `reserveSearchCall` and never write the cache. They only read pages the leader wrote through `setCachedSearchPage`, and only successful Google responses get there. The only key-namespace problem is L-1.

4. **Env override clamps:** I-2.

5. **Production claim probe wrote no product data.**
   - On `origin/main`, `POST /api/host/claim` with a cookie runs `verifyClaim` → `verifyRoomClaimToken` → `getRoom` (read) → false for a non-existent room. It then runs `isClaimThrottled` (read) and `registerClaimFailure` (the `hostclaim:<ip>` throttle counter).
   - No room, queue or identity write, and no telemetry `track` on this route.
   - The only write was an ephemeral throttle counter keyed to the Dev's own edge IP, which the TM's approval condition covered. No YouTube key was involved.

6. **TICKET-127 (room-record RMW) is outside this diff and not made worse.** `git diff --stat … -- lib/rooms.ts lib/store lib/store.ts` → empty. The PR adds no room write. The only auth-path change is the read-only IP derivation.

## Friction
- `cacheKey`'s comment already records one key-namespace collision (the lowercase `p:` marker). L-1 is the same class in a new module. Recurring pattern: Redis keys derived from user text need a namespace marker the query side cannot produce. That is worth one line in the Dev agent prompt or a key-builder helper (W6).
- boraoke has no `verify-green-local.sh`, so S1 "CI green" depends on whichever lane runs the full suite. This needs a house decision for this repo.

## Delta re-gate (D-011), 2026-10-15, head `6a6854c`

**Verdict: PASS.** M-1, L-1, L-3 and #89's MEDIUM 7 are closed and probe-verified. The release-on-refusal, marker-clearing, legacy-429 and waiter-timer changes add no race that bills, no unbilled `search.list` path and no cap bypass. No new findings above INFO. M-2 and L-2 stay open as filed follow-ups (TICKET-131, TICKET-132), unchanged and non-blocking.

### Scope
- `git pull`: already up to date, head `6a6854c` (= `origin/ticket/126-search-limits`). `origin/main` is `8473de2`; merge-base with the PR is `4d1940e` (#89 squash), and `git diff HEAD...origin/main -- lib app components` is empty, so main's two newer commits are docs only.
- `git diff 560c61c..HEAD -- lib app components` (11 files). Merge noise from #89 was set aside by checking it against main: `git diff 4d1940e HEAD -- lib/rooms.ts app/api/host/login app/api/rooms lib/search-trigger.ts` is empty, and the rest of the `youtube-search.ts` / `SongSearch.tsx` / `route.ts` delta beyond the PR commits is #89 code that main already holds.
- PR-owned code commits audited line by line: `64a3369` (client-ip order, `sf:lock:`/`sf:err:` keys, comments), `0f61b7e` (`rateLimitOk` IP-first), `eb1b4d4` (legacy 429 on flight give-up, `FLIGHT_RETRY_MS = LIVE_COOLDOWN_MS`, `del(errKey)` on acquire, copy), `ac0f0f1` (waiter deadline timer cleared). The release-on-refusal itself (`await release("abandoned")` before the denial response) was already present at `560c61c` (`route.ts:314`); `eb1b4d4` adds its tests.

### Tests and probes
- Targeted jest: `npx jest client-ip search-budget-principal search-single-flight api-search-personal-caps host-auth api-search-budget api-search host-claim search-rate-isolation` → `Test Suites: 10 passed, 10 total` / `Tests: 191 passed, 191 total`.
- Real Redis (own `redis:7-alpine` on :6431, stopped afterwards, 0 left running): `REDIS_TEST_URL=redis://127.0.0.1:6431 npx jest principal-lua search-budget-lua` → `Tests: 13 passed, 13 total`.
- Scratch probe (jest, `VERCEL=1`, client IP sent as `x-real-ip`, budget reservation mocked as granted unless stated), output verbatim:
  - `(e) billed in 30s: IP B = 90, total A+B = 180 (per-IP ceiling 90 each)` (through the route).
  - `(e-unit) rateLimitOk allowed for B in 30s = 90 (ceiling 90)`.
  - `(e-old) 560c61c rateLimitOk allowed for B in 30s = 900 (ceiling 90)` (reverse check: the same probe on the pre-fix limiter reproduces the hole).
  - `(m1) clientIpFrom(xvff=1.1.1.1, xri=2.2.2.2, xff=3.3.3.3) on VERCEL=1 -> 2.2.2.2`.
  - `(l1) 180 keys over 15x4 query/page combos, cross-kind collisions = 0; old scheme P4 collide=true, new scheme P4 collide=false; lockKey("BR::abc")=sf:lock:BR::abc errKey=sf:err:BR::abc`.
  - `(r) refused leader: {"degraded":true,"reason":"personal-limit","results":[]} billed=0 reserves=1; next identical: results=1 deferred=- billed=1 reserves=2`.
  - `(r2) A={"degraded":true,"reason":"personal-limit","results":[]} B results=1 deferred=- degraded=-; search.list=1 reserves=2` (concurrent: A refused, B waits, sees the flight vacant, leads, reserves on its own principal, bills once).
  - `(lg) cooldown legacy: 429 {"error":"Muitas buscas — aguarde um instante e tente de novo."} | flight-giveup legacy: 429 {"error":"Muitas buscas — aguarde um instante e tente de novo."} | headers-equal-keys=true`.

### Findings closed
- **M-1 closed.** `VERCEL_IP_HEADERS` is now `["x-real-ip", "x-vercel-forwarded-for", "x-forwarded-for"]` (`lib/client-ip.ts:50`), so the header read first is the one the 2026-10-14 production probe proved the edge overwrites. Probe (m1) shows a forged `x-vercel-forwarded-for` loses to `x-real-ip`. The module header now claims verification for `x-real-ip` only. Residual: the two fallbacks are read only when `x-real-ip` is absent, which the edge never allows on Vercel. The deploy-time probe from the original M-1 is no longer a merge condition, because the deployed key order is now the probed one.
- **L-1 closed.** Lock and marker keys use distinct leading namespaces (`sf:lock:<ck>`, `sf:err:<ck>`). `"sf:lock:" + a === "sf:err:" + b` would need `"lock:..."` to equal `"err:..."`, which differs at the first character, so no query can collide. Probe (l1) found 0 cross-kind collisions, including against the `sc:` cache namespace. The regression test in `__tests__/search-single-flight.test.ts` covers the old P4 case.
- **L-3 closed.** `app/api/host/claim/route.ts:50-55` and `lib/host-auth.ts:394-398` now state the qualified trust boundary (edge-written on Vercel or behind a declared proxy, the shared `"unknown"` bucket elsewhere).
- **#89 MEDIUM 7 closed.** `rateLimitOk` returns on an IP rejection before it touches a `u:` key (`lib/youtube-search.ts:458-466`), the same shape as `indexRateLimitOk`. A request that passes the IP bucket is still charged there even when its uuid bucket rejects, so rotating uuids still cannot dodge IP accounting. Probe (e) shows 900 billed before the fix and 90 after. One address now adds at most 30 uuid keys per 10 s window, so evicting another address's `ip:` bucket from the 2,000-entry LRU needs about 66 distinct real addresses. That falls into the accepted many-IP residual (M-2 class).

### New-change review (no findings above INFO)
- **Release on refusal: no cap bypass, no unbilled call.** A refused leader releases with `"abandoned"`, which writes no marker and deletes only its own lock (compare-and-delete). A waiter then sees the flight vacant and makes one bounded re-acquire (`attempt >= 1` exits). If it leads, it goes through `reserveSearchCall` with its own `{device, ip}` before the only `searchYouTubePage` call site (`route.ts:343`, `git grep` confirmed it is the single caller in `app/`). Every `search.list` therefore still has a granted reservation charged to the caller's own principal (probes (r) and (r2)). A refused leader bills nothing, and a waiter is never charged for, or able to spend, another principal's share.
- **Clearing the stale error marker: no new race that bills.** The new leader runs `DEL sf:err:<ck>` only after winning `SET NX` on `sf:lock:<ck>`. That is possible only after the previous leader's lock is gone, and the previous leader sets its marker before its release. So the previous flight's waiters either read the marker first (degrade) or, after the clear, see a live lock and wait on the new leader (page or defer). Neither path bills: waiters never reserve and never call upstream.
- **INFO-5 (pre-existing, cosmetic).** If a leader outlives its 10 s lock, a new leader can clear the marker and then the old leader can fail and set a fresh one. The new leader's waiters then degrade early with `reason:"error"`. This was already possible before the change (the marker was simply never cleared), it affects only waiters, and it costs no budget. No action.
- **Legacy 429 leaks no state.** The single-flight give-up for a non-`v=2` client returns a body byte-identical to the existing cooldown 429, `{"error": <localized searchRateLimited>}`, with the same header set (probe (lg)). It carries no `retryAfterMs`, no counts and no flight or lock detail. The only signal ("an identical query is in flight") is already exposed to v2 clients through `deferred:"single-flight"` and costs the observer a live attempt inside their own cooldown. `FLIGHT_RETRY_MS = LIVE_COOLDOWN_MS` is a static hint.
- **Waiter timer cleanup (`ac0f0f1`).** It only replaces `sleep()` with a cleared `setTimeout` in the in-process race. Behaviour is unchanged, and it removes a 6 s pending timer per waiter (a minor heap and timer-pressure gain under flood).
- **Copy changes.** `personalLimit` reworded in en/es/pt-BR. It is static i18n text rendered through React (escaped) and reveals neither which key, IP or device was exhausted nor any count.

### S1 (CI-verified-green)
boraoke still has no `scripts/verify-green-local.sh` (Friction, above). The authoritative evidence is the Dev's full-jest run on code head `ac0f0f1`: `Test Suites: 70 passed, 70 total` / `Tests: 18 skipped, 1182 passed, 1200 total` (dev report). `ac0f0f1..6a6854c` changes only docs and the event log. My targeted and real-Redis runs above are green on `6a6854c`.
