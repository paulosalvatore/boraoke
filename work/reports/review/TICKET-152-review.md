# TICKET-152 — Reviewer report (D-022 opus pass)

**PR:** #94, branch `ticket/152-owner-pin-flake`, head `d8b60f91a2e8e05619f07558c372098cc5754e19` (code commit `85879ae`).
**Verdict:** APPROVE (conditions below).
**Scope reviewed:** `__tests__/claim-token-owner-pin.test.ts` (+60/-1), the ticket file, event-log lines. No product code in the diff.

## 1. Is the "owner can never be lost" argument right for every write path?

I listed every write to the room record. Fail-loud search: `/usr/bin/grep -rna "roomBackend|:meta|claimTokenHashes|ownerClaimTokenHash"` over `app/ lib/ scripts/`, excluding `node_modules` and tests. The positive control is that `lib/rooms.ts` shows 5 `roomBackend.update` call sites. No file outside `lib/rooms.ts` writes the record. `lib/host-auth.ts` has no direct write. It reaches the store only through `attachClaimCookie -> issueRoomClaimToken`. `lib/retention.ts` and `lib/room-create-throttle.ts` mention the key only in comments.

| # | Write path | Callers | Owner hash + pointer preserved? |
|---|---|---|---|
| 1 | `createRoom` -> `roomBackend.create` | `POST /api/rooms` | Runs before the pin and has no claims yet. This is the starting state, not a risk. |
| 2 | `issueRoomClaimToken` -> `update({...room, claimTokenHashes: capClaimHashes([...hashes, new], owner)})` | `attachClaimCookie` from `/api/rooms` (`owner:true`) and `/api/host/login` | Yes. `owner` comes from `room.ownerClaimTokenHash`. `capClaimHashes` pins it whenever it is in the list, and the pointer is re-written. |
| 3 | `setRoomMode` -> `{...room, settings}` | `/api/host/mode` | Yes, through the spread. |
| 4 | `setRoomLanguage` -> `{...room, settings}` | `/api/host/language` | Yes, through the spread. |
| 5 | `setRoomModeration` -> `{...room, settings}` | `/api/host/moderation` | Yes, through the spread. |
| 6 | `revokeRoomClaimTokens` -> deletes both fields | `/api/host/session` logout, after `requireHost` | Removes the owner on purpose. |

Every write saves f(some earlier persisted snapshot). Paths 2 to 5 keep the owner hash and pointer whenever the snapshot had them. By induction, once the owner pin has persisted, every later persisted state still contains the owner, in any interleaving, until a deliberate logout. That is what the ticket says, and it holds for all six paths.

Two edges I checked by hand:
- **Pre-pin window.** A writer that read the record between `create` and the owner mint would write back a record with no owner. To be authenticated in that window, a writer needs the host code or a session. The host code exists only in the creation response, which has not reached the browser yet. Unreachable, as the ticket says.
- **The memory backend returns stored objects by reference.** All writers build new objects and arrays (`...room`, `[...hashes, hash]`), so nothing mutates them in place. The memory backend therefore behaves the same as Upstash's deserialized copies for this property.

A logout racing a login can bring a revoked token back (TICKET-127). That is not an eviction and is out of scope here. The ticket already records it.

## 2. Does the worst-order test model the lost-update case (TICKET-127)?

Yes, for the eviction property. The update spy holds every write until all 30 writers have read. The 30 writers are 26 mints and 4 `setRoomMode` calls. The held writes are then released in a seeded shuffle, after 0-7 pre-filled staff tokens. That is maximal staleness: every write comes from the same snapshot, so the result is last-writer-wins over stale copies. That is exactly the TICKET-127 shape. The test checks the final state three ways: the owner verifies, the pointer equals the owner's hash, and the list length is `<= MAX`.

It does not exercise chained staleness, where a writer reads a state that an earlier stale write produced. By the induction in section 1 that case adds nothing, and the two real-timer probes still sample chained interleavings. It is a sufficient model.

## 3. Mutation pass (I re-ran it; `lib/rooms.ts` was restored after each run, `git status` clean)

Command: `npx jest __tests__/claim-token-owner-pin.test.ts -t "worst-case lost updates"`

| Mutant | Result |
|---|---|
| M1: the old eviction, `return hashes.slice(-MAX_CLAIM_TOKENS)` in `capClaimHashes` | **KILLED**, 99/200 seeds locked out (counted from `--json`). Matches the ticket's 99/200. |
| M2: `setRoomMode` drops `ownerClaimTokenHash` | **KILLED** (several dozen seeds) |
| M3: a mint forgets the inherited owner (`owner = opts.owner ? hash : undefined`) | **KILLED** (same seed set as M1) |
| M4: `setRoomMode` drops `claimTokenHashes` | **KILLED** (several dozen seeds) |

M2 to M4 go beyond the ticket's claim. The test also catches a setter that stops spreading `...room`, which is the regression most likely to come from a future host mutator.

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path` (test-only diff).
`no primitive beneath existing assertions changed` (no product code touched).

## 4. Does the 60 s timeout hide a real slowness problem?

No. The probes put a deliberate real-timer pause of 0-5 ms around every in-memory `get` and `update`, and spread arrivals over 60 ms. Their wall time is that test-made jitter plus CPU starvation on the host. No product latency is being measured. The ticket's evidence for a timeout rather than an assertion failure is solid: 32 `Exceeded timeout` lines, 0 `Expected`/`Received` lines, and the failures reproduced at will with `--testTimeout=2500`. A real hang or deadlock would still fail at 60 s.

My runs at load average ~136: the 30 CONCURRENT probe took 690 ms, the waves probe 202 ms, and the new barrier test 72 ms. The barrier test keeps the 5 s default, which leaves ~70x headroom, and it does not depend on load.

## 5. Evidence I ran (targeted only, because the host is under load)

- `npx jest __tests__/claim-token-owner-pin.test.ts --verbose`: `Tests: 12 passed, 12 total`
- `npx jest claim-token-owner-pin host-claim host-auth`: `Test Suites: 3 passed`, `Tests: 73 passed, 73 total` (matches the PR body)
- `npx eslint __tests__/claim-token-owner-pin.test.ts`: exit 0
- `git diff --name-only`: `__tests__/claim-token-owner-pin.test.ts`, `work/tickets/TICKET-152-*.md`, `work/events/**`. No UI surface and no product code.

## Gates

- **App Tester:** N/A, as the PR body states. I confirmed the diff touches no UI.
- **Cyber Security waiver:** I agree. The diff changes no auth code. It only adds assertions around an auth invariant, and section 1 is the security argument, checked here.
- **CI green:** boraoke has no `verify-green-local.sh`. Its gate is the jest suite. I ran the three relevant suites, but not the full suite, because of host load.

## Conditions

1. Before merging, the TM runs the full `npx jest` once, rebased on current main, and pastes the `Tests:` line in the PR. This is the CI-green gate. My targeted runs do not replace it.

## Optional (non-blocking)

- optional: The barrier loop `while (held.length < writers.length)` would spin until the 5 s timeout if a writer ever returned without calling `update`, for example on a null room. It fails loudly either way, but an explicit spin bound with a clear message would make that failure easier to read.
- optional: The file now creates ~220 rooms against `ROOM_MAX`'s default of 500. If a test environment ever lowers `ROOM_MAX`, `createRoom` returns null and the failure shows up as a `TypeError` on `created!.room`.
- optional: The PR gates list still has a "Tech Lead merge confirmation" row. D-043 gives merge authority to the TM.
