---
ticket: TICKET-151
product: boraoke
status: filed
---

# TICKET-151 — Gated "delete room" capability (so test rooms can be removed without hand-run Redis commands)

**Filed:** 2026-10-15, by the boraoke Tech Manager, on a Global TM request (TL decision context: room retention is left as is; this is only about removing test rooms on demand).
**Priority:** LOW–MEDIUM
**Type:** Ops / security
**Size:** S–M
**Patron-facing:** no (host/admin or ops only). **Gates:** Cyber Security gate (destructive, keyed deletion on prod data). **TL OK before merge if a host-facing UI is added.**

## Why

There is no supported way to remove a room. The test room `t125-prod-verify-throwaway` exists on prod: key `room:t125-prod-verify-throwaway:meta` plus an `identity:<uuid>:rooms` membership. Today it can only go away through hand-run Redis commands, which the house avoids.

## What

Pick one in the plan and say which:

- an **ops script** (`scripts/`) run through the gate chain with an explicit room slug and a dry-run default, or
- a **host/admin action** (host-authenticated, confirmation step) that deletes a room.

Either deletes every key of the room (meta, queue, history, rotation and any per-room keys; enumerate them from the code, not by guess) and removes the room from each `identity:<uuid>:rooms` membership set. Soft-delete or a printed key list before the destructive step, per the reversible-changes preference. Never a wildcard delete.

## Acceptance

- Test: deleting a room leaves no `room:<slug>:*` key and no membership entry; other rooms untouched; a wrong slug deletes nothing.
- The prod throwaway room `t125-prod-verify-throwaway` removed through the new path, with the before/after key list as evidence.
- Cyber gate report on authorization (who may delete) and blast radius.

## References

- Related: TICKET-91 (room and queue data retention, left unchanged), `lib/` room storage.
