# TICKET-151 dev report

Status: implemented, draft PR open, awaiting gates.

## Key list (source)
- `room:<slug>:meta` lib/rooms.ts:590
- `room:<slug>:session-epoch` lib/rooms.ts:597
- `room:<slug>:queue`, `room:<slug>:paused` lib/store/types.ts:125-126
- `room:<slug>:pending:index` and one `room:<slug>:pending:item:<id>` per index id, lib/pending-store.ts:115-116
- `rl:hostrevoke:<slug>` lib/host-auth.ts (revokeKey) + lib/rate-limit-counter.ts (redisKey), both now exported
- Not Redis keys: advance-rate-limit counters are in-memory. Telemetry events carry the room id as data, are not keyed by room, and are left alone.
- Membership: `identity:<creatorUuid>:rooms` (lib/identity-store.ts:61) from the record, plus read-only scan of `identity:*:rooms`; SREM only.

## Race with mutateRoom
Record deleted first. ROOM_CAS_SCRIPT (lib/rooms.ts:717) returns 0 on a missing key and never creates one, so a late CAS cannot resurrect the room; an earlier CAS is deleted with the record. Keys other writers can re-create (queue push, epoch INCR) are caught by the post-delete verification (exit code 2) and removed by a re-run since they are on the code-derived list. Real-Redis test proves the CAS returns 0 after delete.

## Verification
See PR body for test and mutation output.

## Friction
none
