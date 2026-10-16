# TICKET-127 — dev report

**Status:** implemented; self-verification in progress (see the log at the bottom).
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

## Log

- Plan written: `work/plans/TICKET-127-plan.md`.
- Pair suite run against the pre-fix `lib/` first: **44 failed, 2 passed** (details below).
