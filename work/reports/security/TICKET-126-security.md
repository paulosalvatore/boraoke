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
