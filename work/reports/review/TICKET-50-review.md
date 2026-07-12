# TICKET-50 Review — atomic Lua-EVAL for Redis `registerFailure`

**Reviewer (D-022 opus merge-counting pass). App Tester skipped (backend-only, no UI; precedent T-46/47/48). Cyber folded into this review.**

Verdict: **APPROVE** (deliver-not-merge — any boraoke main merge = live boraoke.com prod deploy; this APPROVE authorizes DELIVERY of an open PR, not an auto-merge).

## What I reviewed
Diff `origin/main...HEAD` (branch `ticket/50-registerfailure-lua`, tip `231fd14`), two real files:
- `lib/rate-limit-counter.ts`
- `__tests__/rate-limit-counter.test.ts`

(auto-generated `work/events/2026-07.jsonl` line ignored per instruction).

## Independent build/test verification
- `npx jest` → **Test Suites: 37 passed / 37; Tests: 524 passed / 524.** Matches Dev's claim.
- `npx next build` → **exit 0, "Compiled successfully".** Typecheck (tsc via next build) passed — confirms the dropped `.eval` generic typechecks against the raw `@upstash/redis` client.
- Deps already present (next-intl installed); no `npm ci` needed.

## Findings

1. **Fix correctness / atomicity — PASS.** `REGISTER_FAILURE_SCRIPT` does `INCR KEYS[1]`; iff result `== 1` then `PEXPIRE KEYS[1] ARGV[1]`; returns count. Redis executes Lua atomically (single-threaded, no interleave), so INCR+PEXPIRE are indivisible server-side. The old client-side gap between `incr` and `expire` (fail-open catch / crash / dropped 2nd round-trip leaving a TTL-less, never-expiring, permanently-throttled key) is genuinely closed: if the whole EVAL fails the key is never created (INCR is inside the script), so no orphaned TTL-less counter can exist. TTL now guaranteed set on creation.

2. **No behavior regression — PASS.** Read the full current file: memory path (`memIsThrottled`/`memRegisterFailure`/`memResetKey`, LRU `MAX_TRACKED_KEYS` bound), `isThrottled`, `resetKey`, driver resolution, and lazy client are byte-unchanged; only `registerFailure`'s Redis branch changed. Fail-open try/catch preserved (Redis error → silent no-op → a blip never locks out a legitimate host).

3. **TTL semantics — PASS, strictly more precise.** Old `EXPIRE max(1, ceil(windowMs/1000))` s → new `PEXPIRE max(1, round(windowMs))` ms. 60000ms → 60000ms both ways (identical for the real login window); PEXPIRE removes ceil-to-second rounding-up. `max(1,…)` floor guarantees ≥1ms for sub-ms windows (0.4 → 1). Any marginally-shorter TTL only resets the window marginally sooner → favors availability (the intended fail-open posture), not under-throttling in practice.

4. **`.eval` call — PASS.** `redis.eval(REGISTER_FAILURE_SCRIPT, [redisKey(key)], [ttlMs])` — script string, keys `[rl:<key>]`, args `[ttlMs]`. Matches raw `@upstash/redis` `eval(script, keys, args)`. Dropped generic is correct (raw client, not the `RedisLike` wrapper used in store/upstash.ts). Mirrors the established `MERGE_SCRIPT` EVAL pattern (`lib/store/upstash.ts:212`). Typecheck confirmed via build.

5. **Security (folded Cyber) — PASS, no new attack surface.** `rl:` namespace prefix intact via `redisKey()`. No Lua injection: key/TTL passed as EVAL KEYS/ARGV (Redis-native params), never string-interpolated; script is a static module-level constant. Fail-open still the intended posture. Memory-path LRU heap bound unaffected.

6. **Tests — PASS, meaningful.** Four Redis-EVAL tests via a `@upstash/redis` mock (`Redis.fromEnv()` → stub with spyable eval/incr/expire): (a) `.eval` called once with `rl:`-prefixed key + ms TTL `[60_000]` (proves no ceil-to-seconds); (b) `.incr`/`.expire` NOT called (locks the two-round-trip regression out); (c) sub-ms 0.4 floored to `[1]`; (d) fail-open resolves `undefined` on `.eval` throw. These prove the fix, not just pass.

## Non-blocking note (not a follow-up, inherent)
No test executes the Lua script's *behavioral* semantics (INCR-then-conditional-PEXPIRE) — that requires a live/embedded Redis, same limitation as the existing `MERGE_SCRIPT`. The script logic is trivial and the load-bearing regression-lock (no separate INCR+EXPIRE) is covered. Acceptable; left to integration/manual as before.

## Verdict
**APPROVE.** Correct, atomic, no regression, tested, no new attack surface. Build exit 0, 524/524. Deliver as an open PR (do not auto-merge — boraoke prod deploy).
