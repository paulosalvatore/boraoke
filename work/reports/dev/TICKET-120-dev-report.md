# TICKET-120 — Dev report (PR B of TICKET-126)

## Status
Implemented and self-verified (jest, build, full e2e 127/127). Draft PR, no gate requested. Needs the Cyber Security gate: it writes on the authentication path.

## Context
- Ticket: `work/tickets/TICKET-120-claim-token-cap-evicts-the-owner.md`, folded into TICKET-126 as its own PR. TICKET-126's ticket and plan live on PR A's branch (`ticket/126-search-limits`, PR #90): `work/tickets/TICKET-126-per-person-search-limit-and-single-flight.md`, `work/plans/TICKET-126-plan.md` §4.
- Worktree: `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t120-claim-token-owner-pin`
- Branch: `ticket/120-claim-token-owner-pin`, cut from `origin/main` @ `af080ca`. App/e2e port 3120.
- Read first: the MANAGER-LOG auth-surface warnings (TICKET-104: every mechanism that wrote on this path recreated the lockout, three times; concurrency probe required).

## What changed
1. **Devices, not issues, on login** (`app/api/host/login/route.ts`). A login that already presents a live claim token for the room gets that token re-sent via the existing `rollClaimCookie`: no mint, no store write. Only a device without a live token gets a fresh one (`attachClaimCookie`). Five logins from one tablet now use one slot.
2. **Owner pin** (`lib/rooms.ts`). New optional `Room.ownerClaimTokenHash`, a POINTER to one entry of `claimTokenHashes`, set once when the creator's device gets its token (`POST /api/rooms` → `attachClaimCookie(..., { owner: true })`).
   - `verifyRoomClaimToken` is unchanged and never reads the pointer, so the pointer grants nothing; a dangling pointer pins nothing.
   - Eviction moved from `slice(-5)` to `capClaimHashes`: keep the owner's hash, fill the other 4 slots with the newest other hashes, preserve order.
3. **Logout** (`revokeRoomClaimTokens`) clears the pointer along with every hash.
4. **Not re-pinned on a later login, deliberately.** Deciding "this login is the owner" would need `creatorUuid`, which is client-readable (PR #81 gate). Anyone holding code + uuid could take the pin and evict the owner, which would recreate the lockout. After a logout the creator's next token is an ordinary slot. Documented in the field's docblock.
5. **Docblocks fixed** on `MAX_CLAIM_TOKENS` (now true on both paths, and it says why raising the constant is not the fix), `attachClaimCookie` and both routes.

**Why the lockout risk is ruled out structurally.** The fix adds no new write on the auth path: the dedupe REMOVES a write, and the eviction change only alters which hash a write that already happened drops. Every login read-modify-write reads a list that contains the owner's hash and writes back a list that still contains it, whatever order concurrent writes land in. A lost update (TICKET-127, still present) can drop a concurrent *staff* hash, but never the pinned owner's.

**Coexistence with TICKET-118** (parked, untouched). 118's `revokeRoomHostSessions` prunes `claimTokenHashes` to the presented hash and never reads the new field. A pruned owner hash just leaves a dangling pointer (pins nothing, grants nothing), so revocation stays complete with zero 118 code change. The textual overlap is adjacent hunks in `lib/rooms.ts` (the new `Room` field next to 118's `sessionEpoch`) and the login route. Optional tidy-up for whichever lands second: have 118's prune also clear the pointer when it drops that hash.

## Self-verification
- jest: **56 suites, 1,007 passed, 5 skipped, 0 failed** (load ~4-7 on 10 cores).
- `npm run build`: compiled; `bundle-es-target: OK` (49 chunks at ES2019); `css-target: OK` (TV surface).
- `tsc`: no errors outside the pre-existing `__tests__` / `e2e` classes.
- **e2e full suite: 127/127 in 4.0 min**, `workers: 1`, `PORT=3120`. Load 4.8 at the start and 4.2 at the end. No other playwright runner, `next start` or App Tester Chrome was live. `e2e/_canary` passed.

### Concurrency probe (required)
`__tests__/claim-token-owner-pin.test.ts`:
- The owner creates the room through `POST /api/rooms`. Then **30 host-code logins from 30 distinct clients**, all in flight together and arriving over ~60 ms, with every `roomBackend.get` / `update` yielding a seeded random 0-5 ms so the read-modify-writes genuinely interleave (`maxInFlight > 1` asserted).
- Over **8 seeds**, the owner's token verifies after every run: `[true x8]`. The list stays ≤ 5, and the pointer equals the owner's hash.
- A second probe runs 6 waves of 5 concurrent logins and checks the owner after every wave: `[true x6]`.
- Plus: the ticket's sequential five-staff scenario (owner in, oldest staff out); same-device logins (token re-sent, zero `update` calls); a dead token still gets a fresh one; a pointer is not a credential; logout clears the pointer and a later login is not re-pinned; `capClaimHashes` unit cases.

**Finding while building the probe:** with all 30 logins starting at the same instant, every one reads the record before any writes. Lost updates then keep the owner's hash by accident, and the probe PASSED on the pre-fix `slice(-5)`. The arrival spread was added so the probe can fail; that is recorded in the test's comment.

## Prove-your-test-can-fail
**(a) Mutations** (`t120-mut.py`, each restored). All KILLED:

| Mutant | Result |
|---|---|
| REVERSE-1: pre-fix eviction `slice(-MAX_CLAIM_TOKENS)` | 3 failed (30-concurrent probe, waves, five-staff) |
| REVERSE-2: login always mints (pre-fix) | 1 failed (same-device dedupe) |
| MUT-3: creation not pinned | 4 failed |
| MUT-4: logout keeps the pointer | 1 failed |
| MUT-5: cap keeps the OLDEST others | 4 failed |
| MUT-6: pin dropped when the owner is outside the newest window | 5 failed |
| MUT-7: a dangling pointer still reserves a slot | 1 failed |
| MUT-8: every login re-pins as owner | 4 failed |

**(b) The 30-concurrent-logins probe fails against today's `slice(-5)`**, verbatim:

```
  ● the owner survives other people's logins (TICKET-120) › 30 CONCURRENT logins from distinct clients never evict the owner (8 interleavings)

    expect(received).toEqual(expected) // deep equality

    - Expected  - 8
    + Received  + 8

      Array [
    -   true,
    -   true,
    -   true,
    -   true,
    -   true,
    -   true,
    -   true,
    -   true,
    +   false,
    +   false,
    +   false,
    +   false,
    +   false,
    +   false,
```

**(c) Hollowing-out.** A primitive changed beneath existing assertions: `issueRoomClaimToken`'s eviction, and the login route's mint.
- Re-examined `host-claim.test.ts`. "MORE devices than the cap still evicts the oldest" issues tokens with no owner, so it still exercises the plain newest-5 window: not vacuous, and MUT-7 shows that path is covered.
- "entering the host code after a logout mints a FRESH token" presents a revoked cookie, which does not verify, so it still exercises the mint path.
- The "devices, not issues" roll-path tests are unchanged.

**(d) Triggered mutation pass:** not triggered — no new parsing/normalisation function on a money/quantity/identity path. `capClaimHashes` is list trimming over server-minted hashes, not user input. It was mutated anyway (MUT-5/6/7).

## Residual
- TICKET-127 (filed on PR A's branch): whole-record read-modify-write still loses concurrent updates on the room record. This PR does not make it worse. It removes most login writes, and the owner's hash survives any lost update.
