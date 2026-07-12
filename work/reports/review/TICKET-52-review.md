# TICKET-52 — Reviewer Report (D-022 opus merge-counting review)

**Branch:** `ticket/52-adopt-rate-counter` (off `origin/main`, base `0dfa5fc`)
**Verdict:** **APPROVE**
**Scope:** Mechanical refactor — `lib/room-create-throttle.ts` delegates to the reusable `lib/rate-limit-counter.ts`, mirroring `lib/host-auth.ts`'s login throttle. No behavior change on the memory path; cross-instance cap gained on Upstash.

## What I reviewed

- Ticket spec `work/tickets/TICKET-52-adopt-rate-counter-room-create.md`, Dev report `work/reports/dev/TICKET-52-dev-report.md`.
- Full diff `git diff origin/main...HEAD` on the three code files + the untouched counter (`lib/rate-limit-counter.ts`) for equivalence comparison.
- Ran the suite and build myself in a fresh `npm install`ed worktree.

## Findings against the review focus

**1. Behavior equivalence (memory path) — PASS.** The original `isRoomCreateThrottled` (no bucket → `false`; stale window `Date.now()-windowStart >= WINDOW_MS` → delete+`false`; else `count >= roomCreateLimit()`) is byte-identical to the counter's `memIsThrottled(key, {max, windowMs})`. The original `registerRoomCreation` LRU/window logic (insertion-order eviction at capacity, delete-then-re-set to refresh order, `count += 1`) matches `memRegisterFailure` exactly. Window is fixed, anchored at first hit, self-expiring. No off-by-one, no window-anchoring drift. Trips at exactly `roomCreateLimit()` (test: 3 pass, 4th trips).

**2. Counter delegation correctness — PASS.** Key namespace `room-create:<ip>` → helper prefixes `rl:` → `rl:room-create:<ip>`, collision-free with login's `rl:login:<ip>` (confirmed `host-auth.ts:201` uses `login:${ip}`). `roomCreateOpts()` builds `{ max: roomCreateLimit(), windowMs: WINDOW_MS }` fresh per call, so a live `ROOM_CREATE_LIMIT` override applies (test "raised limit trips at 5"). Both call sites in `app/api/rooms/route.ts` correctly `await` — the 429 guard (`(await isRoomCreateThrottled(ip))`) and post-create `await registerRoomCreation(ip)`. No unawaited promise, no lost throttle check. The other importer `__tests__/api-rooms.test.ts` drives throttling only through `POST` (which awaits internally), so no missed await there either.

**3. Fail-open — PASS (inherited).** Redis errors in `isThrottled`/`registerFailure` are caught → not throttled / no-op, identical to the login throttle. Unchanged on the memory path.

**4. Shared-LRU consequence — ACCEPTABLE, correctly disclosed.** The shared `MAX_TRACKED_KEYS = 1000` LRU pool is now shared across login + room-create keys (previously room-create had a private 1000-cap). Called out explicitly in both the module doc comment and the Dev report. Still a strong heap bound against spoofed-IP floods; irrelevant on the Redis/prod path (TTLs bound growth there). Same consolidation host-auth already accepted. No DoS/eviction concern that wasn't already present for login.

**5. Tests — genuinely prove properties, not tautological.** Trips-at-limit, raised-env-limit-trips-at-5 (behavioral, not just the pure `roomCreateLimit()` getter), 1h window reset via fake timers, and independent-IPs-don't-cross-count. The old private-LRU-cap test was correctly dropped (it asserted an implementation detail now owned by PR #32's counter and covered by that file's own test) and replaced with a genuine isolation assertion. `_clearRoomCreateThrottle()` → `_clearAll()` keeps suites isolated; no cross-suite dependency on partial clearing exists.

**6. Conflict-safety — PASS.** `git diff --name-only` confirms `lib/rate-limit-counter.ts`, `__tests__/rate-limit-counter.test.ts`, and `lib/youtube-search.ts` are ALL absent from the diff. Only `lib/room-create-throttle.ts`, `app/api/rooms/route.ts`, `__tests__/room-create-throttle.test.ts` (+ ticket/report/event log) changed. No overlap with PRs #31/#32/#33.

## Green verification (run by Reviewer, not trusting prose)

- `npm install` → exit 0 (fresh worktree; node_modules gitignored).
- `npm test` → **Test Suites: 37 passed / 37; Tests: 521 passed / 521; exit 0.**
- `npm run build` → **Compiled successfully, BUILD_EXIT=0**, `/api/rooms` route built.

Matches the Dev report's 521/521 + build 0 claim exactly.

## Verdict

**APPROVE.** Clean, faithful mechanical refactor. Memory-path behavior is provably byte-identical; the intended cross-instance gain on Upstash is achieved via the already-reviewed counter; scope discipline is exact and conflict-free with the open PRs. No follow-ups required from this review. (Deliver-not-merge: the TL merges, since a boraoke `main` merge auto-deploys live boraoke.com.)
