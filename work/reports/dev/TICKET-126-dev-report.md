# TICKET-126 — Dev report (PR A: TICKET-119 + per-person caps + single-flight)

## Status
PR A implemented and self-verified with jest, the real-Redis Lua suites and `npm run build`. **e2e not run yet**: the machine was busy with #89's gate run (an App Tester headless Chrome was live), so per the TM's machine rule it is deferred. Draft PR, no gate requested. PR B (TICKET-120) not started; it follows on its own branch from `main`.

## Context
- Picking up from: fresh start. Phase 1 plan approved by the Product TM 2026-10-14 with amendments (recorded at the top of `work/plans/TICKET-126-plan.md`).
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t126-search-limits`
- Branch: `ticket/126-search-limits`, cut from `origin/ticket/125-enter-idle-search` @ `7be6824` (PR #89, which already contains #88).
- App/e2e port: 3126.
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

### Build (commit: see PR)
- **`lib/client-ip.ts` (new): the one IP derivation.** A declared `TRUSTED_CLIENT_IP_HEADER` wins. Otherwise on Vercel (`VERCEL=1`) the order is `x-vercel-forwarded-for` → `x-real-ip` → `x-forwarded-for` (first hop). Otherwise the shared `"unknown"` bucket (fail-closed). IPv6 is keyed by /64, IPv4-mapped IPv6 folds to IPv4, garbage is one length-capped bucket. `lib/host-auth.ts` re-exports it, so login, claim, rooms, queue, telemetry and search all use it. The search route's private XFF-first `clientIp()` is gone.
- **"server-derived" claims corrected** in `lib/host-auth.ts` (the `claimKey` docblock and the `clientIpFrom` docblock), `app/api/t/route.ts` and the search route. The round-3 report line lives in TICKET-104's report on its own (merged) branch history; the corrected statement is now in the code where the next reader looks.
- **`lib/search-budget.ts`: per-person sub-budgets.** `DEFAULT_DEVICE_DAILY_CAP = 10`, `DEFAULT_IP_DAILY_CAP = 45`, overridable by `SEARCH_DEVICE_DAILY_CAP` / `SEARCH_IP_DAILY_CAP` (positive integer, clamped to 90; anything else ignored with a warning). `reserveSearchCall(now, principal)` runs the new `RESERVE_PRINCIPAL_SCRIPT`: check platform, IP and device, then INCR all three or none, returning `-1/-2/-3` for which cap denied (platform checked first). Counter keys hold a sha256 digest, not the raw IP or uuid. A malformed reply or store error stays fail-closed. Calls without a principal keep the old platform-only script.
- **`lib/search-single-flight.ts` (new).** `SET sf:<cacheKey> <token> NX PX 10000`. The leader reserves, calls Google, fills the cache and releases with a compare-and-delete script. A failed upstream writes a 3 s `:err` marker first. Waiters poll the cache (150 ms, 6 s deadline). Outcomes: page (free), failed (degrade), vacant (one chance to lead), timeout (`deferred: "single-flight"` instead of billing). Acquire fails open to "solo" on a store error; the reservation behind it stays fail-closed. Without Upstash an in-process promise map does the same per process.
- **Route (`app/api/search/route.ts`).** Order: validate → velocity limit → cache → index → liveRequired → key → cooldown → single-flight → leader re-checks the cache → reserve (platform + IP + device) → Google. The device key is the httpOnly `boraoke_identity` cookie, else the uuid param, else `anon@ip`. Denial: `200 {degraded: true, reason: "personal-limit", results: []}`, one reason for both personal caps, no remaining counts.
- **Client (`components/SongSearch.tsx`).** `dailyLimited` became `limitCopy` (`dailyLimit` | `personalLimit` | null). Same notice slot, and load-more retires on either limit. New `Search.personalLimit` copy in en/es/pt-BR, in the existing em-dash register.
- **Test env.** `jest.env.ts` sets `VERCEL=1` (jest runs routes under Vercel's header trust; `client-ip.test.ts` covers off-Vercel by deleting it). `playwright.config.ts` declares `TRUSTED_CLIENT_IP_HEADER=x-forwarded-for` for the e2e server. `.env.example` documents all three env vars.

## Self-verification
- jest (full, load ~11 on 10 cores): **68 suites, 1,152 passed, 12 skipped, 0 failed** (the 12 skips include the opt-in real-Redis suites when `REDIS_TEST_URL` is unset).
- Real Redis (`docker run redis:7-alpine` on :6426, `REDIS_TEST_URL=redis://127.0.0.1:6426 npx jest principal-lua search-budget-lua`): **12 passed** (7 new, 5 existing).
- `npm run build`: compiled; `bundle-es-target: OK — all 50 chunk(s) parse at ES2019`; `css-target: OK` for the TV surface (6 pre-existing phone/desktop advisories).
- `tsc`: no errors outside `__tests__` / `e2e/advance-auth.spec.ts` (both pre-existing classes; the new test files only add the same missing-jest-types class).
- `node --test` at the repo root picks up the jest suites and fails on every one. CI runs it only for the rotation engine, so this is pre-existing and unrelated.
- **e2e: NOT RUN YET** (machine rule: #89's App Tester Chrome was live). One new spec: `personal search share spent: own copy + paste-link still queues a song` in `e2e/search.spec.ts`.

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
- `emit-event.sh --repo <worktree>` appended the `worktree_created` event to `work/events/by-branch/main.jsonl` inside the worktree, not to a ticket-branch file. I restored the file rather than commit a `main` event log line on a ticket branch.
