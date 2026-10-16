---
ticket: TICKET-158
product: boraoke
status: backlog
---

# TICKET-158 — A host-code login flood can still cost a room its owner pin: cap successful logins and back off on write conflicts

**Filed:** 2026-10-16, from the Cyber Security gate on PR #98 (TICKET-127), findings M-1 and L-1 (`work/reports/security/TICKET-127-security.md`, PR comment 6210422336). L-2 (comments overstating the fallback) was fixed in PR #98 itself.
**Priority:** MEDIUM (M-1 is MEDIUM, L-1 is LOW).
**Type:** Security / reliability (host auth surface, room-record store)
**Size:** M
**Patron-facing:** no directly. Host-facing only through the owner pin behind "Sign out other devices".
**Depends on:** TICKET-127 (merged in #98). Coordinate with TICKET-156 (see "Constraint on TICKET-156").

## What

TICKET-127 made every room-record write a compare-and-set with up to `ROOM_WRITE_ATTEMPTS = 32` immediate retries (`mutateRoom`, `lib/rooms.ts`). That closes the single-stale-write pin loss (Cyber R-1). Two residuals remain under sustained contention.

### M-1 (MEDIUM): a login flood by a host-code holder can drop the owner pin

- Someone with the host code runs about 50-500 concurrent successful-login loops on the room around, or continuously through, the owner's "Sign out other devices".
- The revoke's rebind exhausts its 32 attempts. The fallback in `app/api/host/revoke-sessions/route.ts`, `attachClaimCookie(res, roomId, { owner: true })`, is another `mutateRoom` racing the same flood, and in most exhausted trials it returned null.
- The attacker's next post-bump login then mints onto the dead-tagged list (`bound=false` in `issueRoomClaimToken`), which deletes `ownerClaimTokenHash`. The room ends with no pin.
- Measured: pin lost in 1/6 trials at 50 attackers with 5+3 ms hops, 3/6 at 200, and 4-6/6 at 200-500 with 15+10 ms hops.
- What still holds: the sessions and every pre-revoke claim are always ended, so the revoke's security effect holds. What is lost is the lever for next time and the no-typing path, the same end state as R-1.
- Not HIGH: it needs the host code (which this lever never evicted), it needs a sustained high-concurrency flood, the owner keeps a live rolling session, and on the pre-#98 code the same loss took one well-timed stale write.
- Successful logins are unthrottled today (`app/api/host/login/route.ts`).

### L-1 (LOW): the retry loop has no backoff

- `mutateRoom` retries immediately, up to 32 times.
- Under a flood each request makes about 27-30 CAS EVALs (`CAS-evals/flood-req` up to 29.8) plus one read per attempt: about 55-60 store commands per login against about 3-4 before #98, roughly 15x amplification. Most attacker requests also exhaust themselves (livelock).
- Impact: Upstash command quota or bill and lambda time per request, on a store the queue and rooms may share. Not a new lever: the flooder needs the host code or a live session.

## Proposed change

1. **Cap successful logins / claim mints per IP and per room.** A venue legitimately mints a handful per hour. Exempt requests that present the live owner token. This is deliberately NOT a per-room write rate limit: a write budget is spendable by the same code holder and would refuse the owner's rebind just as surely as the contention does. Capping successful mints bounds the commit rate an attacker can sustain, which is the only input to exhaustion.
2. **Make the revoke's fallback owner mint robust**, so it does not lose to the same flood. For example: retry it with backoff inside the revoke's own budget, or have a rebind that cannot commit write the owner pin through a path that does not compete with ordinary mints.
3. **Add jittered exponential backoff to `mutateRoom` retries**, and consider a lower attempt bound for non-owner mints.

## Constraint on TICKET-156

If TICKET-156 adopts the #96 option (a) style "a pin-less room: the next code login becomes owner", this flood becomes a route for a code holder to TAKE ownership. TICKET-156 must never hand the pin to a plain code login on a room that lost it, under contention or otherwise.

## Note for TICKET-151 (Cyber I-3, INFO)

`rev` resets on room create: `createRoom` writes the record without `rev` using a plain `SET`, and its existence check is check-then-set (pre-existing). If a room is deleted, or expires under retention, and a same-slug room is created, a writer still holding a rev-0 snapshot of the old room would pass the new room's compare. Unreachable today (no deletion path, millisecond window). When TICKET-151 (delete room) lands, create with `SET NX` and/or seed `rev` from a value that cannot repeat, and write any soft-delete flag through `mutateRoom`.

## Acceptance

- The Cyber M-1 flood probe (`work/evidence/TICKET-127/security/cyber-probes.test.ts.txt`) at 200-500 attackers loses the pin in 0/6 trials, or the cap refuses the flood before it reaches the store.
- Store commands per flooded login drop well below the measured 55-60.
- A request presenting the live owner token is never throttled by the new cap.
- The revoke's fallback owner mint commits under the measured flood, with a test that fails on the #98 code.
- No change makes a plain code login able to acquire the owner pin.
