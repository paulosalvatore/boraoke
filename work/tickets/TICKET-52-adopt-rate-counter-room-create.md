# TICKET-52 — Adopt shared `rate-limit-counter` in room-create throttle (TICKET-48 FU-2)

**Source:** TICKET-48 reviewer follow-up FU-2 ("adopt `lib/rate-limit-counter.ts` for the still-in-memory `lib/room-create-throttle.ts` and the search limiter — the helper was built reusable for exactly this").

**Severity:** LOW (architectural debt / reusability consolidation). Delivered by the heartbeat as an OPEN PR — **deliver-not-merge** (any merge to boraoke `main` auto-deploys live boraoke.com; the TL merges).

## Scope (this ticket = room-create ONLY)

Refactor `lib/room-create-throttle.ts` to delegate to the reusable `lib/rate-limit-counter.ts` (Upstash-backed `INCR`+`EXPIRE` with in-memory LRU fallback), exactly as `lib/host-auth.ts`'s login throttle already does. This gives room-creation a **cross-instance** cap when Upstash is configured (today each Vercel lambda keeps its own in-memory Map, so the throttle is per-instance only), while preserving byte-identical behavior on the memory path.

**Do NOT touch the YouTube search limiter** (`lib/youtube-search.ts` `rateLimitOk`) in this ticket. It is a **dual-bucket** (per-uuid 5/10s AND per-IP 30/10s) **sliding-window** limiter; the shared counter is single-bucket fixed-window. Converting it would change security-gated, quota-sensitive semantics and is NOT a clean swap — file a separate follow-up (see below) rather than force it here.

## Current behavior to preserve exactly (memory path)

`lib/room-create-throttle.ts` today: in-memory `Map<string, {count, windowStart}>`, fixed 1h window anchored at first creation, `max = roomCreateLimit()` (env `ROOM_CREATE_LIMIT`, default 3), LRU cap 1000 IPs. Public exports:
- `roomCreateLimit(): number`
- `isRoomCreateThrottled(ip): boolean`  → becomes `Promise<boolean>`
- `registerRoomCreation(ip): void`      → becomes `Promise<void>`
- `_clearRoomCreateThrottle(): void`

Sole importer: `app/api/rooms/route.ts` (the POST handler is already async — just `await` the two calls).

## Required changes

1. Import `isThrottled`, `registerFailure`, `CounterOptions` (and `_clearAll` for the test reset) from `lib/rate-limit-counter`.
2. Delete the local `Map`/bucket/LRU management — the shared counter owns that now.
3. Keep `roomCreateLimit()` (env-tunable) exactly as is. Build opts per call: `{ max: roomCreateLimit(), windowMs: 60 * 60 * 1000 }` (evaluate `max` at call time so the env override still applies live).
4. Namespace the key to avoid any collision with the login counter: `room-create:<ip>` (the counter already prefixes Redis keys with `rl:`, yielding `rl:room-create:<ip>` vs the login `rl:login:<ip>`).
5. Make `isRoomCreateThrottled`/`registerRoomCreation` thin `async` wrappers delegating to the counter; `await` both in `app/api/rooms/route.ts`.
6. `_clearRoomCreateThrottle()` → delegate to `_clearAll()` (memory-only counter reset) so tests stay isolated.
7. Keep the module doc comment honest: update it to say the throttle now delegates to the shared counter (cross-instance on Upstash), and note the LRU pool is now shared with the other counter consumers.

## Behavior-preservation notes (call out in the Dev report + for the Reviewer)

- **Fixed-window semantics are identical** (both anchor the window at the first hit and self-expire), so the trip point and window are unchanged.
- **Shared LRU pool:** the shared counter's memory-path LRU cap (`MAX_TRACKED_KEYS = 1000`) is now shared across login + room-create keys, where room-create previously had its own private 1000-entry cap. This is an intentional, acceptable consequence of consolidation (still a strong bound; irrelevant on the Redis/prod path). State it explicitly.
- **Fail-open** is inherited from the counter (a Redis blip → not throttled), matching the codebase ethos and the login throttle.

## Tests (must stay green + prove equivalence)

- Update `__tests__/room-create-throttle.test.ts` to the async API (`await`), asserting the SAME properties: trips at the limit, resets after the 1h window, env `ROOM_CREATE_LIMIT` override respected, and independent keys don't cross-count. Use fake timers / `_clearAll()` between tests as the existing suite does.
- Confirm the full suite + `npm run build` are green. Do NOT modify `lib/rate-limit-counter.ts` or its test (that file is owned by open PR #32 — leave it untouched to stay conflict-free).

## Collision / safety

- Branches off `origin/main`. Touches only `lib/room-create-throttle.ts`, `app/api/rooms/route.ts`, `__tests__/room-create-throttle.test.ts` (+ this ticket + reports). No overlap with open PRs #31/#32/#33.
- Backend-only, no UI/render change → App Tester N/A. No new external surface (same route, same limits) → Cyber N/A. Reviewer opus D-022 applies.

## Follow-up to file (do NOT implement here)

- **TICKET-48 FU-2b (deferred): search limiter cross-instance.** Adopting the shared counter for `youtube-search.ts` `rateLimitOk` requires a **dual-bucket** counter variant (per-uuid + per-IP, both charged) — a real design change, not a mechanical swap; the current sliding-window dual-bucket is correct and quota-sensitive. File as a separate LOW follow-up so the search path can go cross-instance deliberately when warranted.
