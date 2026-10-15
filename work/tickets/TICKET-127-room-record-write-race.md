# TICKET-127 — Room records are written by whole-record read-modify-write, so concurrent writes lose updates, including revocations

**Filed:** 2026-10-14, by the TICKET-126 Dev (found while planning TICKET-120). Not fixed in TICKET-126 by TM decision.
**Priority:** MED, rising to HIGH once TICKET-118 ships (see scenario 3).
**Type:** Bug / security (auth surface)
**Size:** M

## What

Every write to a room record reads the whole record, changes one field in memory, and writes the whole record back:

- `issueRoomClaimToken` (`lib/rooms.ts`, login, room creation and claim paths): append a claim-token hash.
- `revokeRoomClaimTokens` (logout): delete `claimTokenHashes`.
- `setRoomMode`, `setRoomLanguage`, `setRoomModeration`: host settings.
- On `ticket/118-session-revocation`: `revokeRoomHostSessions` (bump `sessionEpoch`, prune claim hashes).

`UpstashRoomBackend.update` is a plain `SET` of the whole JSON record, with no version check, no `WATCH` (unavailable over the Upstash REST transport) and no script. `RoomBackend` has no compare-and-swap. So two concurrent writers both read version N, and whichever writes last silently erases the other's change. Nothing detects it.

## Scenarios, from mildest to worst

1. **Two concurrent logins, one device is silently handed a dead credential.** Logins A and B both read hashes `[h1]`. A writes `[h1, hA]`, B writes `[h1, hB]`. Device A's claim cookie now matches nothing. It is a lockout of A's *new* credential only (A still knows the host code and can retype it), and it happens with no attacker, just two staff members logging in at the same moment. Same class as the round-4 TICKET-104 race (`aLives=false bLives=true`), on the login path instead of the roll path.

2. **A settings change and a login race: either the setting or the credential is lost.** A host flips moderation while a staff device logs in. One of the two writes disappears: either moderation silently reverts, or the staff device's claim token is dead.

3. **A login racing a revocation UNDOES the revocation.** This is the dangerous one.
   - **On `main` today (logout):** a login reads the record while it still holds the old hashes, logout writes the record without `claimTokenHashes`, then the login writes back the OLD list plus its new hash. Every token logout just revoked, including any copy an attacker took, is live again. Logout reported success.
   - **On TICKET-118 (`revokeRoomHostSessions`):** same shape, worse outcome. A login (or a settings change) reads `sessionEpoch = 3` and the full hash list, the revoke writes `sessionEpoch = 4` and prunes the hashes to the acting device's, re-reads and **confirms the epoch advanced** (118's bounded retry loop), returns success, and then the stale writer lands with `sessionEpoch = 3` and the full old hash list. The epoch rolls BACK, so every session the owner just revoked verifies again, and every pruned claim token, including the attacker's, is restored. 118's "re-read and confirm" cannot catch this: the clobber happens after its confirmation. The owner was told "signed out all devices" and nothing was signed out.
   The attacker does not need to win a tight race by luck. An attacker who knows the host code (the exact case a revocation is for) gets a cheap, repeatable write on that record: every `POST /api/host/login` runs `issueRoomClaimToken`, a read-modify-write. They can keep logging in around the moment the owner revokes. (A claim or a cookie roll does NOT write, so a stolen claim token alone does not give this lever; any concurrent settings change by staff does, by accident.)

## Why it matters

TICKET-118 exists to give a compromised venue a recovery lever, and TICKET-104's whole history is "every mechanism that writes on the auth path recreated the lockout". This race means any revocation, today's logout or 118's epoch bump, can be silently undone by an ordinary concurrent write. It also means TICKET-120's eviction policy, and any future per-room auth state, inherits a lost-update hazard.

## What's needed

- **Make every room mutation atomic.** Either:
  - per-field keys for the mutable auth state (claim hashes as a Redis set, `sessionEpoch` as an `INCR`-able integer), so each mutation is a single atomic command and settings writes cannot touch them; or
  - one Lua script per mutation that reads, modifies and writes the record server-side (the pattern `lib/search-budget.ts` and `lib/pending-store.ts` already use), or a version field checked inside the script (compare-and-swap) with a bounded retry.
- **Revocation must be monotonic**: a stale writer must never be able to lower `sessionEpoch` or re-add a pruned hash. If a version/CAS approach is used, a revoke must win against any writer that read before it.
- Needs a room-backend test seam that can interleave two writers deterministically. 118's report already notes this seam does not exist.

## Constraints

- Read **`prove-your-test-can-fail`**: the regression test must interleave a login read before a revoke and its write after, and must FAIL against today's plain `SET`.
- **Concurrency probe required** (MANAGER-LOG auth-surface rule): show that no interleaving of login / claim / settings / revoke loses a revocation or locks the legitimate owner out.
- Sequence with TICKET-118 and TICKET-120; all three write the same record.
- Not in scope of TICKET-126 (TM decision 2026-10-14).
