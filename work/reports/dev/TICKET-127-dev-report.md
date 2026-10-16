# TICKET-127 — dev report

**Status:** implemented and self-verified (full jest, build, full e2e, real-Redis suite, mutation pass all green). Draft PR #98, ready for the Cyber gate (mandatory) then Reviewer. App Tester N/A: no UI, route or copy change.
**Branch:** `ticket/127-room-write-race` · **Worktree:** `.worktrees/t127-room-write-race` · **Base:** `origin/main` 41b77bf (includes #96, 5f6bf40) · **App port:** 3127
**Plan:** `work/plans/TICKET-127-plan.md` (design, alternatives rejected, residuals).

## Picking up from

Fresh start. Read the ticket, TICKET-152, TICKET-156, the #96 Cyber re-gate notes R-1 / R-2 (`work/reports/security/TICKET-118-security.md`), `lib/rooms.ts`, `lib/host-auth.ts`, `lib/store/*`, every route that writes a room record (`login`, `session` logout, `revoke-sessions`, `rooms` create, `mode`, `language`, `moderation`) and every test that intercepts `roomBackend.update`. Exploration was done by direct reading rather than an Explore subagent: the surface is two files plus their call sites, and I needed the exact code in context to design against it.

## What changed

**One mechanism: the room record is written by compare-and-set on a revision field.**

- `Room.rev` (optional, absent = 0). `RoomBackend.update(room)` now writes only if the stored `rev` equals `room.rev`, stores `rev + 1`, and returns `"ok" | "conflict" | "missing"`. The expected revision rides inside the snapshot (`{ ...room }`), so no mutator can forget it.
- Upstash: `ROOM_CAS_SCRIPT`, one EVAL (GET, decode, compare, SET with KEEPTTL when retention is on). Memory: synchronous compare + set.
- `mutateRoom(roomId, change)`: read, compute, CAS, and on conflict re-read and recompute, up to `ROOM_WRITE_ATTEMPTS = 32`; then `RoomWriteConflictError`. Every mutator uses it: `issueRoomClaimToken`, `revokeRoomClaimToken`, the `revokeRoomHostSessions` rebind, `setRoomMode` / `Language` / `Moderation`.
- `revokeRoomHostSessions`: the 4-attempt "write, re-read, confirm" loop is replaced by one `mutateRoom`. A committed CAS write cannot be clobbered by a stale writer, so the confirm read had nothing left to catch.
- Unchanged: `get` is still one `MGET` (record + epoch counter), so `requireHost` still reads once and writes nothing. The epoch counter key from #96 is untouched. No route, UI or copy change.

**Why 32 attempts:** each conflict is a different write committing to the same room inside that attempt's read-to-write window, and one operation's windows do not overlap, so an operation fails only if 32 other writes commit to that room while it runs. I first wrote 8; the TICKET-120 barrier probe (30 simultaneous writers) exhausted it (`RoomWriteConflictError: room bar-barrier-2: write did not commit after 8 conflicting writes`), so the bound sits above the largest concurrency the suite exercises.

**Fail-closed on exhaustion:** login mint returns null (device keeps its session, loses the no-typing path); logout throws before the route clears anything (client never told it logged out); settings throw (500, nothing changed); revoke falls to the existing branch (sessions already ended by the atomic bump, owner minted a fresh pinned claim).

## Tests

| File | What |
|---|---|
| `__tests__/room-write-race.test.ts` + `__tests__/helpers/room-writers.ts` (new) | Every ordered pair of 7 writers (login mint, owner mint, staff logout, owner revoke, mode, language, moderation), worst order: A reads and its first write is held, B runs to completion, A's write is released. Checks B's effect, A's effect, owner-mint pin, and the global owner invariant (pin set, pinned claim live, still pinned after a later code login: the R1f shape). 45 pairs; 4 documented skips (same setting twice; revoke x revoke, where B is refused `not-owner` before writing). Public API only, so it runs unchanged against the pre-fix `lib/`. |
| `__tests__/room-write-cas.test.ts` (new) | Memory CAS contract; auth path makes zero writes and `requireHost` one read; every caller's behaviour when writes never commit; a write that loses 31 races still commits. |
| `__tests__/room-cas-lua.integration.test.ts` (new) | Real Redis (opt-in `REDIS_TEST_URL`): the shipped Lua (match, stale behind/ahead, missing, non-JSON value, 13 revision shapes checked for parity with `normaliseRoomRev`, KEEPTTL); `UpstashRoomBackend` on Redis via a RESP adapter (legacy record, conflict, missing, TTL); then all 45 pairs with the app's room backend pointed at Redis. |
| `__tests__/room-session-epoch-backend.test.ts` | Fake gains `eval`; 4 new tests pin the one-EVAL command shape, conflict, missing, KEEPTTL flag. |

## Hollowing-out (c)

The primitive beneath existing assertions changed: `roomBackend.update` went from "always writes" to "writes only on a matching revision". Every test that intercepts or calls it was re-examined:

- `host-session-revocation.test.ts` `withStaleWriter`: holds the first write only; that write is now refused and the writer's retry passes. The assertions (revoke not undone) still bite: with the CAS removed they fail (see mutation pass).
- `host-session-revocation.test.ts` randomized probe: held EVERY write of a stale writer, which would hold its retry forever. Now holds each writer's first write only (`staleCtx` carries `{ firstWrite }`).
- `host-session-revocation.test.ts` "every rebind is clobbered": the spy returned `undefined` 4 times, which the new code would retry past. Renamed "when the rebind never commits", returns `"conflict"` for `ROOM_WRITE_ATTEMPTS` calls, and now also asserts the call count (`ROOM_WRITE_ATTEMPTS + 1`: every attempt, then the mint), so it cannot pass by the rebind quietly succeeding.
- `host-session-revocation.test.ts` "a claim list written for an EARLIER epoch grants nothing": planted a stale snapshot via `update`, which is now a conflict (asserted). It now plants the old list with the current revision, the shape only an old-code write mid-deploy can still produce, so the epoch tag stays tested as defence in depth.
- `host-session-revocation.test.ts` "record keeps its pre-TICKET-118 shape": the key list gains `rev`, the one field a write adds.
- `claim-token-owner-pin.test.ts` barrier probe: holds the first 30 writes (all from one read), passes retries through. Its target (the cap never evicts the owner) is unchanged.
- `claim-token-owner-pin.test.ts` jitter probe: forwards the record unchanged, so unaffected.
- `room-session-epoch-backend.test.ts` "reports the COUNTER when a stale whole-record write lowered the record's copy": `update(stale)` is now refused (asserted), so the stale copy is planted with a raw `set`; otherwise the test would pass without the max() it guards.

## Prove the tests can fail

**(b) Reverse check, the pair suite against the pre-fix `lib/`** (run before any `lib/` change, worktree at 41b77bf). Full output: `work/evidence/TICKET-127/pairs-against-prefix-lib.txt`.

```
Tests:       44 failed, 2 passed, 46 total
```

Every failure is the interleaved writer's effect being erased by the stale write, for example:

```
  ● ... › stale mint, interleaved mint            Expected: true    Received: false
  ● ... › stale mint, interleaved logout          Expected: false   Received: true
  ● ... › stale mint, interleaved mode            Expected: "per-table-2"   Received: "full-karaoke"
  ● ... › stale moderation, interleaved revoke    Expected: true    Received: false
```

The 2 that pass on the pre-fix code: the pair-count meta test, and **stale revoke, interleaved logout**. That pair is already safe on main because the revoke's rebind prunes every staff hash anyway, so the stale rebind lands on a superset of what the logout wanted. It is kept in the suite (it must stay true), but it is not claimed as a regression proof. `stale X, interleaved revoke` for a moderation write and for a logout are Cyber's R1f and R1e, and both fail on main.

**(a) Mutation pass on the new compare-and-set logic** (`work/evidence/TICKET-127/mutation-pass.txt`, 7 suites incl. real Redis, 230 tests per run). All 12 KILLED:

```
M1 lua: revision compare removed: KILLED — 60 failed / 230
M2 lua: off-by-one compare: KILLED — 65 failed / 230
M3 lua: KEEPTTL dropped: KILLED — 2 failed / 230
M4 lua: fraction normalisation dropped: KILLED — 1 failed / 230
M5 lua: creates a missing record: KILLED — 2 failed / 230
M6 memory: compare removed: KILLED — 46 failed / 230
M7 mutateRoom: no retry: KILLED — 97 failed / 230
M8 mutateRoom: conflict treated as success: KILLED — 94 failed / 230
M9 mutateRoom: revision not carried: KILLED — 127 failed / 230
M10 upstash: expected revision sent +1: KILLED — 53 failed / 230
M11 upstash: keepTtl flag inverted: KILLED — 2 failed / 230
M12 memory: stored revision not advanced: KILLED — 48 failed / 230
```

Lua mutants M1-M5 are killed only by the real-Redis suite, as expected: nothing else interprets the Lua.

**(d) triggered mutation pass:** not triggered by the house rule (no new parsing/normalisation function on a money/quantity/identity path; `normaliseRoomRev` delegates to the existing `normaliseSessionEpoch`). The pass above was run anyway because the brief asked for one on the compare-and-set, and the Lua's own normalisation is parity-tested against `normaliseRoomRev` across 13 shapes.

## Self-verification

- **Real Redis**, own container `boraoke-t127-redis` (`redis:7-alpine`, redis_version 7.4.11, 127.0.0.1:6427), stopped afterwards: `Tests: 68 passed, 68 total` (`work/evidence/TICKET-127/real-redis-suite.txt`).
- **Full jest** (once, at the end): `Test Suites: 78 passed, 78 total` / `Tests: 89 skipped, 1461 passed, 1550 total`. The 89 skipped are the opt-in real-Redis suites without `REDIS_TEST_URL`.
- **`npm run build`**: exit 0, `✓ Compiled successfully`, `bundle-es-target: OK — all 52 chunk(s) parse at ES2019.`, `css-target: OK`.
- **Full e2e** (once, `PORT=3127 --workers=1`, no other boraoke e2e or server running beforehand): `143 passed (3.9m)`, exit 0, canary `_canary.spec.ts` tests 1/143 and 2/143 passed. Load at start `18.99 31.68 36.56`, at end `37.86 30.16 34.18`.
- boraoke has no `scripts/verify-green-local.sh`, so the local-Docker verdict does not apply here; the runs above are the green evidence (same as #96's gates).

## Friction

- My first mutation-pass script read jest's `--json` from stdout and broke on interleaved output. Stopping it mid-run left a mutant in `lib/rooms.ts` (the `finally` restore did not run on the signal). Caught by `git diff --stat lib` and restored from the commit before anything else ran. The rerun writes the JSON to a file.
- `worktree-create`'s `emit-event.sh` step appended to the worktree's `work/events/by-branch/main.jsonl`, not this branch's file. I reverted that line rather than commit a main-branch event log change on a ticket branch.

## Log

- e29f218: implementation, tests, plan, first dev report. Draft PR #98 opened.
- Mutation pass, real-Redis suite, full jest, build, e2e: all above.
- Plan written: `work/plans/TICKET-127-plan.md`.
