# TICKET-118 — Dev report

**Status:** EXPLORING → planning. Worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t118-session-revocation`, branch `ticket/118-session-revocation`.

## Picking up from

Fresh ticket, no prior Dev. Read: the ticket, `work/reports/cyber/TICKET-104-security-gate.md`, `work/reports/cyber/TICKET-104-security-regate.md` (finding O-A is this ticket), `prove-your-test-can-fail`.

## The defect, restated from the code

- `sessionValue(token)` (`lib/host-auth.ts:151`) = `HMAC(token, "cantai-host-session-v1")`. Pure function of the room secret. `issueSession` → `sessionValue(resolveRoomToken(roomId))`; `verifySessionValue` recomputes the same value and compares.
- `resolveRoomToken(roomId)` (`:125`) returns the room's `hostCodeHash`, which is immutable (the raw code is shown once and never stored, so it cannot be rotated).
- Therefore every session cookie for a room is the same 64 hex chars for the room's whole life, and nothing anywhere can invalidate one.
- `POST /api/host/session` (logout) already does `revokeRoomClaimTokens(roomId)` — which clears **every** device's claim hash (`lib/rooms.ts:210`). So the claim credential is already revocable house-wide; the session is the only part with no lever.
