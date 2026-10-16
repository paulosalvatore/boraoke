# TICKET-127 — Plan: room-record writes become compare-and-set

**Status:** written 2026-10-16, before implementation. APPROVED-BY: auto-approved (no plan-gate escalation; the TM brief said write the plan, then implement) — validated downstream by gates + merge of PR #98. Worktree `.worktrees/t127-room-write-race`, branch `ticket/127-room-write-race`, base `origin/main` 41b77bf (includes #96, 5f6bf40). App port 3127.

## 1. The problem in one line

Every room mutation (`issueRoomClaimToken`, `revokeRoomClaimToken`, `revokeRoomHostSessions`'s rebind, `setRoomMode` / `setRoomLanguage` / `setRoomModeration`) reads the whole `room:<id>:meta` record, changes it in memory, and writes the whole record back with a plain `SET`. A writer that read before another writer's commit and writes after it erases that commit. On the auth surface that means a settings toggle can undo a login or a logout, a stale write after a revoke's rebind drops the owner pin (Cyber R-1, probes R1f / R1e), and a stale login or logout write restores claim hashes a logout or revoke removed.

## 2. Chosen design: a revision number on the record, checked server-side (compare-and-set), with a bounded retry

- The record gets one new optional field, `rev` (absent reads as 0, same normalisation as `sessionEpoch`).
- `RoomBackend.update(room)` changes meaning: it writes `room` **only if the stored record's `rev` still equals `room.rev`**, and stores it with `rev + 1`. It returns `"ok" | "conflict" | "missing"`. The expected revision travels inside the snapshot itself, so every mutator that builds its write from `{ ...room }` carries the rev it read. No caller can forget to pass it, and a record built from scratch expects rev 0 and is refused on any room that has been written.
- **Upstash:** one tiny Lua script (`ROOM_CAS_SCRIPT`) does GET, decode, compare `rev`, then `SET` (with `KEEPTTL` when retention is on, plain `SET` otherwise, exactly the current `roomUpdateSetOptions()` behaviour). It is atomic because Redis runs a script to completion. Same EVAL mechanism `lib/store/upstash.ts`, `lib/search-budget.ts` and `lib/pending-store.ts` already use over the REST transport.
- **Memory:** the compare and the set are synchronous between awaits, so atomic in one process.
- **One retry helper, `mutateRoom(roomId, change)`:** read, compute, compare-and-set; on `conflict` re-read and recompute from the fresh record; up to `ROOM_WRITE_ATTEMPTS = 32`. Each conflict is a distinct other commit to the same room during this one operation (an attempt's read-to-write windows do not overlap), so an operation fails only if 32 other writes commit to that room while it runs. (First drafted as 8; the TICKET-120 barrier probe fires 30 simultaneous writers, and 8 attempts was measured to exhaust there, so the bound is set above the largest concurrency the suite exercises.) Every mutator goes through it. All the mutation logic (cap, owner pin, epoch tag) stays in TypeScript, where it is already tested; the Lua does not know what a claim token is.
- The session-epoch counter key from #96 is unchanged. It is still bumped by `INCR` outside the record, and `get` is still one `MGET` of record + counter.

### Why it makes the three failures impossible

A write can only commit if nothing else committed to the record since that writer's read. A writer that lost the race re-reads and recomputes from the record that includes the other writer's change. So:

1. **A settings write cannot undo a login or a logout:** its retry spreads the record that already holds the new hash, or already lacks the removed one.
2. **A stale write cannot drop the owner pin:** the only writes that change `ownerClaimTokenHash` are now fresh-read writes: the revoke's rebind (sets it), a logout on the owner's own device (clears it on purpose, R-2, unchanged), and a mint on a list that is not live (only between a bump and its rebind, and the rebind then re-asserts the pin over it).
3. **A stale write cannot restore a revoked claim:** the hash list a logout or a rebind committed can only be replaced by a write computed from it.

Settings-vs-settings lost updates (mode vs moderation) go away too, which the ticket also lists.

### What the failure mode is when contention never lets a write commit

After 32 conflicts `mutateRoom` throws `RoomWriteConflictError`. Each caller fails closed:

| Writer | On exhausted retries |
|---|---|
| `issueRoomClaimToken` (login, creation, revoke fallback) | returns `null`, so `attachClaimCookie` returns false. The device keeps the session cookie; it loses only the no-typing path, as today when a mint fails. |
| `revokeRoomClaimToken` (logout) | throws, the route 500s, the client is not told it logged out, a retry is safe (the route's own stated contract). |
| settings | throws, the route 500s, nothing changed. |
| `revokeRoomHostSessions` rebind | the existing "rebind failed" branch: sessions are already ended by the atomic bump, the route mints the owner a fresh owner-pinned claim. |

Nothing on that path re-validates a revoked credential. Reaching it needs 32 other writes to commit to one room during one operation.

### Constraints, checked

- **`requireHost` write-free, no extra round trip.** Untouched: `get` is still one `MGET`; `rev` rides inside the record that read already returns. No write is added to any read path. A test counts backend calls on `requireHost` and the claim path.
- **Epoch-0 / legacy compatibility.** No field changes meaning. A legacy record has no `rev`, reads as 0, and its first write stamps `rev: 1`. Claim hashes, owner pin, `claimTokenEpoch` and `sessionEpoch` are read exactly as before, so nobody is logged out on deploy and no migration write runs. `createRoom` still writes the record without `rev`, byte-for-byte as before.
- **Both stores.** Memory and Upstash both implement the same compare-and-set contract; the unit suite pins the Upstash side's command shape with a fake, and a real-Redis suite runs the actual Lua.

## 3. Alternatives rejected

### A. Move the owner pin and the claim list into their own keys with atomic scripts (the #96 epoch pattern). REJECTED.
- The claim list's mutations are not single commands: the cap keeps the owner and the newest others, a list is tied to an epoch tag, a login on a dead-tagged list starts fresh. That logic would have to be reimplemented in Lua for each mutation, a second copy of the auth logic in a language our jest suite cannot run.
- Legacy rooms hold the list inside the record. Every reader would need a "new key, else record" fallback, and the first migration write would race with old-code whole-record writes during the deploy window.
- It leaves the settings fields as whole-record RMW, so mode vs moderation can still lose an update.
- `MGET` grows to 3-4 keys (still one round trip, but more state to keep consistent and to delete with the room, TICKET-151).

### B. One Lua script per mutation that does the whole read-modify-write server-side. REJECTED.
Same objection as A, worse: all six mutators, including the revoke's rebind and the cap, become Lua. The bug surface moves to the place least covered by tests.

### C. Per-field `HSET` (turn the record into a Redis hash). REJECTED.
Changes the key's Redis type from string to hash. During the rollout old lambdas would `GET`/`SET` a hash (WRONGTYPE) or overwrite it with a string, and every existing record needs a migration. A mass-migration deploy on the auth record is the opposite of "no mass logout".

### D. `WATCH` / `MULTI`. REJECTED: not available.
Upstash over REST is stateless, so `WATCH` has no connection to hold, and `MULTI/EXEC` only pipelines a fixed command list (already documented in `lib/store/upstash.ts`).

### E. Compare-and-set on the raw JSON bytes instead of a revision field. REJECTED.
No schema change, but `@upstash/redis` auto-parses on read, so the client would compare `JSON.stringify(parse(stored))` with the stored bytes. Any record whose bytes do not round-trip exactly (a hand edit, whitespace, a different serializer) would refuse every write to that room forever, which is a lockout of logins' claim mints and of settings.

## 4. Residuals, stated

- **Deploy window.** Until every old lambda has drained, an old-code write is a plain `SET` of `{ ...room }`, which carries the `rev` it read, so a new-code compare-and-set cannot see it. That is today's behaviour, for minutes, and it can only happen once.
- **Adversarial contention.** A code holder flooding logins can, in principle, make a revoke's rebind exhaust its retries. That fails closed (sessions ended, claims dead, owner minted a fresh pinned claim, or keeping the session cookie if that mint also exhausts). A code holder can already log in at will; TICKET-156's step-up is the recovery for a room that loses its pin.
- `rev` is not exposed in `PublicRoom`.

## 5. Files touched

| File | Change |
|---|---|
| `lib/rooms.ts` | `rev` field; `ROOM_CAS_SCRIPT`; `RoomBackend.update` becomes compare-and-set on both backends; `mutateRoom` + `RoomWriteConflictError` + `ROOM_WRITE_ATTEMPTS`; every mutator routed through it; the revoke's rebind loop replaced by one `mutateRoom` (the re-read-and-confirm step is no longer needed: a committed write cannot be clobbered by a stale one); docblocks that describe the TICKET-127 residual updated. |
| `__tests__/room-write-race.test.ts` (new) | Deterministic worst-order interleaving for every ordered pair of writers, invariants, `requireHost` no-write/one-read check, retry-exhaustion behaviour. |
| `__tests__/room-cas-lua.integration.test.ts` (new) | Real Redis (`REDIS_TEST_URL`, opt-in like the existing Lua suites): the shipped script's semantics, plus `UpstashRoomBackend` driven over a RESP adapter, plus a stale-writer interleaving end to end. |
| `__tests__/room-session-epoch-backend.test.ts` | Fake gains `eval` for the CAS; tests that planted a stale write through `update` plant it with a raw `set` (otherwise they would now be vacuous). |
| `__tests__/host-session-revocation.test.ts`, `__tests__/claim-token-owner-pin.test.ts`, `__tests__/host-claim.test.ts` | Harnesses that hold writes now hold only each writer's first write (its retry must pass), and the "every rebind is clobbered" test returns `conflict` for `ROOM_WRITE_ATTEMPTS` writes. Each re-examined for vacuity (hollowing-out). |

No route, UI or copy changes. App Tester gate not needed.

## 6. Test strategy

- **Pairs.** Writers: login mint, owner mint, logout (a staff device), revoke (owner), mode, language, moderation. For every ordered pair (A, B): A reads, A's first write is held, B runs to completion, A's write is released. Then check each writer's own postcondition plus the global invariant "the owner pin is set and its hash is live". Same-setting self-pairs (mode/mode etc.) are skipped: last-writer-wins on one field is not a lost update. The file is run against `origin/main`'s `lib/` to show which pairs fail there (verbatim output in the dev report); pairs that main already handles are reported as such rather than claimed.
- **Real Redis:** own `redis:7-alpine` container on a free port, stopped afterwards.
- **Mutation pass** on the compare-and-set: Lua compare removed, Lua off-by-one, Lua `KEEPTTL` dropped, memory compare removed, `mutateRoom` with no retry, `mutateRoom` treating conflict as success. Each must be killed.
- Final: one full jest, `npm run build`, one full e2e (workers 1, port 3127, canary must pass), started only when no other boraoke e2e is live, load recorded at start and end.
