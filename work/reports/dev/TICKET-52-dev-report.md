# TICKET-52 — Dev Report — Adopt shared `rate-limit-counter` in room-create throttle

**Status:** Implemented, self-verified (521 tests green, build exit 0), committed + pushed to `ticket/52-adopt-rate-counter`. Awaiting gates (Reviewer opus D-022; App Tester N/A, Cyber N/A per ticket). Deliver-not-merge — TL merges (auto-deploys live boraoke.com).

## What changed

Refactored `lib/room-create-throttle.ts` to delegate to the reusable `lib/rate-limit-counter.ts`, matching the pattern `lib/host-auth.ts`'s login throttle already uses. Three tracked files touched:

- `lib/room-create-throttle.ts` — Deleted the local `Map<string, {count, windowStart}>`, the fixed-window logic, and the private 1000-entry LRU. Now imports `isThrottled`, `registerFailure`, `_clearAll`, `CounterOptions` from `./rate-limit-counter`. Public surface preserved: `roomCreateLimit()` unchanged; `isRoomCreateThrottled(ip)` / `registerRoomCreation(ip)` are now thin `async` wrappers (return `Promise<boolean>` / `Promise<void>`) delegating to the counter; `_clearRoomCreateThrottle()` delegates to `_clearAll()`. Key namespace `room-create:<ip>` (helper prefixes `rl:`, so `rl:room-create:<ip>` — collision-free with login's `rl:login:<ip>`). Opts built per call via a `roomCreateOpts()` helper: `{ max: roomCreateLimit(), windowMs: 60*60*1000 }` — `max` evaluated at call time so a live `ROOM_CREATE_LIMIT` env override still applies. Module doc comment updated to be honest about the delegation, the cross-instance Upstash behavior, and the now-shared LRU pool.
- `app/api/rooms/route.ts` — `await`ed the two calls: `(await isRoomCreateThrottled(ip))` in the 429 guard and `await registerRoomCreation(ip)` after a successful create. No other logic changed.
- `__tests__/room-create-throttle.test.ts` — Converted to the async API (`await` on both wrappers). Proves the same properties: trips at the limit, `ROOM_CREATE_LIMIT` env override respected (both the pure `roomCreateLimit()` test and a new "raised limit trips at 5" behavioral test), window resets after 1h (fake timers), and independent IPs don't cross-count (replaces the old private-LRU-cap test, which asserted an implementation detail — the 1000-key cap — that is now owned by the shared counter and covered by its own test in PR #32).

## Behavior-preservation notes (for the Reviewer)

- **Fixed-window equivalence.** Both the old standalone throttle and the shared counter's memory path anchor the window at the *first* hit and self-expire the stale window; `max` and the 1h window are unchanged. So the trip point and window semantics are byte-identical on the memory path, and on Upstash the same fixed-window (INCR + EXPIRE-on-create) semantics now run cross-instance.
- **SHARED 1000-key LRU pool (call-out).** The shared counter's memory-path LRU cap `MAX_TRACKED_KEYS = 1000` is now shared across ALL its consumers (login keys + room-create keys), where room-create previously had its own private 1000-entry cap. This is an intentional, acceptable consolidation consequence: it is still a strong heap bound against a spoofed-IP flood, and it is irrelevant on the Redis/prod path (Redis TTLs, not the LRU, bound growth there). Stated explicitly in the module doc comment.
- **Cross-instance gain.** When Upstash is configured, room-creation now has a cross-instance cap (previously each Vercel lambda kept its own Map → per-instance only). Closes TICKET-48 FU-2 for room-create.
- **Fail-open inherited.** A Redis blip → not throttled (counter's try/catch), matching the codebase ethos and the login throttle. Unchanged on the memory path.

## Scope discipline — protected files left UNTOUCHED

Confirmed via `git diff --name-only` (empty output for all three):
- `lib/rate-limit-counter.ts` — untouched (owned by open PR #32).
- `__tests__/rate-limit-counter.test.ts` — untouched (owned by open PR #32).
- `lib/youtube-search.ts` (search limiter `rateLimitOk`) — untouched (dual-bucket sliding-window; out of scope, deferred as FU-2b).

`git diff --stat` shows exactly three files changed: `__tests__/room-create-throttle.test.ts`, `app/api/rooms/route.ts`, `lib/room-create-throttle.ts`. No overlap with PRs #31/#32/#33. `package-lock.json` unchanged; `node_modules` is gitignored (had to `npm install` in the fresh worktree to run the build — the parent repo's node_modules was stale/missing `next-intl`).

## Verification (real output)

**Tests** (`npm test` → jest):
```
Test Suites: 37 passed, 37 total
Tests:       521 passed, 521 total
Snapshots:   0 total
Time:        2.157 s
```
(A `console.warn` from `telemetry-instrumentation.test.ts` exercising a would-block advance path is expected test output, not a failure.)

**Build** (`npm run build`):
```
 ✓ Compiled successfully in 1188ms
BUILD_EXIT=0
```
All routes compiled; `/api/rooms` built.

## Follow-up filed (not implemented here)

- **TICKET-48 FU-2b (deferred):** search limiter (`youtube-search.ts` `rateLimitOk`) cross-instance adoption requires a dual-bucket (per-uuid + per-IP) counter variant — a design change, not a mechanical swap. Left as a separate LOW follow-up per the ticket.
