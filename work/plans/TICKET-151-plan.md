# TICKET-151 plan: gated delete-room (ops script)

APPROVED-BY: boraoke Tech Manager (ops-script path chosen over a host UI; no patron or host surface, so no TL sign-off needed to merge).

- Engine `lib/room-delete.ts`, CLI `scripts/delete-room.ts` (`npm run room:delete`).
- Dry run by default; `--apply` plus typed slug; snapshot (value + TTL per key) to gitignored `.room-delete-snapshots/` before any delete; `--restore <snapshot>`.
- Key list derived from the app's own key builders (no wildcard delete); SCAN `room:<slug>:*` is a cross-check only and a hit refuses apply.
- Membership: from the record's `creatorUuid`, plus a read-only scan of `identity:*:rooms`; removal by SREM only.
- Race: record deleted first; the CAS script never creates a missing record.
- Tests: shared suite over an in-memory fake (CI) and a real Redis (`REDIS_TEST_URL`); mutation pass.
- Not run against prod by the Dev; the TM schedules that.
