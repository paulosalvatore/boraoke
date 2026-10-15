# TICKET-118 (+ TICKET-112) — Dev report

**Status (2026-10-15):** implemented, self-verified, delivered as a draft PR. All four owed items done, with evidence below. No gate has run yet. Cyber re-gate required; App Tester required (UI changed); TL OK required before merge (patron/staff-facing).

Worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/t118-session-revocation`, branch `ticket/118-session-revocation`. Evidence: `work/evidence/TICKET-118/` (numbered files cited below).

## Picking up from (2026-10-15)

Picked up from the 2026-10-02 resume note (kept, condensed, at the end of this file) and the MANAGER-LOG sections "TICKET-118 — mid-flight" and "TICKET-118 amendment". Approach A (a rotatable per-room session epoch) stands; B and C were not reopened. Read tickets 112 (with the TL decision of 2026-10-15), 118, 120, 127 (on the #90 branch) and 152 (on the #94 branch).

## What changed since the 10-02 checkpoint, and why

### 1. Merged origin/main (no rebase, no force-push): `ab9189d`

One conflict, `lib/rooms.ts`: #91 (TICKET-120) added `Room.ownerClaimTokenHash` next to this branch's `Room.sessionEpoch`. Both kept. #91's `capClaimHashes` owner-pin eviction is untouched. Auth suites on the merged tree: 5 suites, 139/139.

### 2. The epoch could be rolled back by a stale write (TICKET-127). Fixed. `35a103c`

The brief named this risk, and a probe confirmed it on the committed design. Every room mutation is a whole-record read-modify-write with a plain `SET`. A login that read the room before the revoke and wrote it after put the old `sessionEpoch` and the old claim list back. The revoke had already re-read, seen the bump, and returned 200. Verbatim, on the previous head (`work/evidence/TICKET-118/01-stale-writer-probe-vs-committed-design.txt`):

```
    ✕ a concurrent LOGIN that read before the revoke and wrote after it (14 ms)
    ✕ a concurrent SETTINGS change (staff flips the mode) that read before the revoke (1 ms)
    Expected: >= 1
    Received:    0
  > 618 |     expect(await getRoomSessionEpoch(v.room.id)).toBeGreaterThanOrEqual(1);
```

So the owner would be told "signed out" while every stolen session and claim token worked again. The fix makes the revoke robust to that write by construction. It does not rely on winning a race.

- **The epoch's source of truth is its own key, `room:<id>:session-epoch`, bumped with `INCR`.** No whole-record write touches it. `RoomBackend.get` reads the record and the counter in **one** round trip (`MGET`) and reports `max(record copy, counter)` as `sessionEpoch`. A stale writer can lower the record's copy, but it cannot lower the counter, so the epoch a reader sees never goes backwards. Writers carry the effective value back into the record, which keeps a floor in case the counter key is ever lost (the bump then jumps past the floor via `INCRBY`). With retention on, the counter gets the record's remaining TTL.
- **The claim-hash list is tagged with the epoch it was written for (`claimTokenEpoch`).** `verifyRoomClaimToken` grants nothing unless the tag equals the current epoch. A stale write that restores the old list also restores the old tag, so it **fails closed**: claim tokens stop working, and none comes back to life. The next login sees the mismatch and starts a fresh list. A room that has never been through a revoke has epoch 0 and no tag, so it behaves exactly as before (pinned by a record-shape test).
- **The revoke = one atomic bump, then rebind the claim list** to the current epoch, keeping only the presented (acting) hash, with a bounded re-read loop. **There is no "contended"/503 outcome any more**: a 200 means the atomic bump happened, and only the bump ends sessions. The route's 503 branch and the UI's 503 wording are gone.
- **Still zero writes on the auth path.** `requireHost`, `verifyClaim`, the rolling `GET /api/host/session` and the claim route only read. Reading the epoch still costs no extra round trip (the `GET` became an `MGET`).

### 3. TICKET-112: a plain logout signs out ONLY this device. `35a103c`

- What logout did on `main`: `revokeRoomClaimTokens` deleted every device's claim hash and the owner pin. So a staff logout silently cost the owner's phone its no-typing re-entry (the 112 addendum).
- Now `POST /api/host/session` calls `revokeRoomClaimToken(roomId, presentedToken)`. It removes only the hash this device presents (and clears the owner pointer only if it pointed at that hash), then clears this device's cookies. The authentication guards (`isCrossSiteRequest` OR `!requireHost`, same undifferentiated 401) are unchanged. Logout does not bump the epoch.
- UI (`AdminRoom.tsx`): the logout label is localised now (`Admin.signOut`: Sair / Sign out / Salir; it was a hard-coded "Sair"). Its confirm moved into a panel below the header, with one sentence: this device only, the others stay in, and getting back in here takes the host code. "Sign out other devices" (`Admin.signOutAll`) keeps its own panel, with the warning that the other devices will need the host code. Only one panel is open at a time. All copy exists in en/es/pt-BR, in plain words; it reuses each catalogue's own terms ("código do host", "código de host", "dispositivo").

## Owed items, in order, with evidence

### (1) Reverse-checks

| # | Mutation | Result | Evidence |
|---|---|---|---|
| RC1 | derivation reverted: `sessionValue` ignores the epoch | **12 of 37 FAIL** | `02-reverse-check-1-derivation-reverted.txt` |
| **RC2** | **no-op epoch bump, claim pruning kept** | **15 of 37 FAIL**, including the core assertion | `03-reverse-check-2-noop-epoch-bump.txt` |
| RC3 | pre-TICKET-112 logout (clears every device) | 3 FAIL (the three 112 tests) | `04-reverse-check-3-logout-clears-all.txt` |
| RC4 | whole-record `update` also writes the counter (i.e. the epoch is back in the record) | 4 FAIL (both deterministic 127 probes, the randomized probe, the stale-list test) | `05-mutation-rc4-epoch-writable-by-record-update.txt` |
| RC5 | claim-list epoch tag ignored | the same 4 FAIL | `06-mutation-rc5-claim-tag-ignored.txt` |

RC2 is the one the TM flagged. It proves the suite is not carried by the claim pruning that already worked before this ticket. Verbatim first failure:

```
  ● an ALREADY-MINTED session stops working after the owner signs out all devices › the OLD session value is dead — on a real host route, not just a helper
    Expected: false
    Received: true
    > 153 |     expect(await verifySessionValue(v.room.id, stolen)).toBe(false);
```

Under RC2 the test "a stolen CLAIM token cannot mint a replacement session" still passes. That is correct, since it tests the claim half, which RC2 leaves intact.

### (2) Triggered mutation pass on `normaliseSessionEpoch` (`work/evidence/TICKET-118/mutation-pass/N*.txt`)

| Mutant | Change | Verdict |
|---|---|---|
| N1 | drop numeric-string coercion | KILLED |
| N2 | drop the `trim() !== ""` guard | SURVIVED-equivalent: `Number("")` and `Number("  ")` are 0, which normalises to 0 either way. Identical on every input probed. |
| N3 | `Number` → `parseInt` | KILLED |
| N4 | drop the number branch | KILLED |
| N5 | coerce non-strings with `Number` | KILLED |
| N6 | `isInteger` → `isFinite` | KILLED |
| N7 | drop the integer guard | KILLED |
| N8 | drop the `n < 0` guard | KILLED |
| N9 | `n < 0` → `n <= 0` | SURVIVED-equivalent: differs only on `-0` vs `0`, which is unobservable (`sessionValue` tests `epoch === 0`, and `-0 === 0`) |
| N10 | `n < 0` → `n < 1` | SURVIVED-equivalent: same reason as N9 |
| N11 | `return n` → `return 0` | KILLED |
| N12 | negative → `-n` | KILLED |

No SURVIVED-real-gap. The equivalence check was run as a script over 34 inputs (strings, whitespace, `-0`, hex, exponent, NaN, Infinity, booleans, objects, arrays).

### (3) Hollowing-out walk (duty (c) — it fired, twice)

Primitives that changed beneath existing assertions: `sessionValue`/`issueSession` (the epoch), `RoomBackend.get` (merges the counter), `verifyRoomClaimToken` (adds the epoch-tag check), `issueRoomClaimToken` (fresh list on tag mismatch), and logout's semantics.

**`issueSession` call sites, 21 outside the new suites, walked file by file:**
- `host-auth.test.ts` (6): issue/verify round trip; cross-room refusal (different secrets); tampered value; env-token rotation on `default`; locked production. None revokes, so the epoch is 0 throughout. Each negative assertion is still refused by the mechanism it names (secret mismatch or HMAC compare), not by an epoch mismatch. Not vacuous.
- `api-mode`, `api-moderation`, `api-admin-analytics`, `host-api`, `screen-token` (1 each): mint a session as the authed precondition; their negative cases send no session. Epoch 0 throughout. Not vacuous.
- `claim-token-owner-pin.test.ts` (1): the new `logoutAs` helper.
- `host-claim.test.ts` (9): the roll tests (238, 513, 523) are positive and unaffected. **The logout refusal tests (wrong session, cross-site, foreign Origin, another room's session) WERE HOLLOWED by TICKET-112.** They assert "nothing was revoked" after a refused logout, but they sent no claim cookie. Under this-device-only logout, even a successful logout without a claim cookie revokes nothing, so those assertions had become true by construction. Proof: a logout that revokes **before** its refusal check passes the old tests **34/34** (`07-hollowing-H1-vs-old-tests.txt`). Fixed in `ffacc39`: those requests now carry the device's claim cookie, as a browser would. The same bug now fails **4** of them (`08-hollowing-H1-vs-fixed-tests.txt`).

**Other changed primitives:** the existing negative claim assertions ("EMPTY hash list matches nothing", "a pointer with no matching hash grants nothing", wrong/empty/other-room token) hand-write records at epoch 0 with no tag. So the tag check passes and the guard under test is still what refuses. The TICKET-152 barrier probe and the TICKET-120 concurrency probes run unchanged and green (rooms there never revoke).

### (4) e2e spec, full jest, build, ONE full e2e

- **New e2e** (`e2e/creator-reentry.spec.ts`, describe "sign out other devices (TICKET-118) and this-device logout (TICKET-112)"), 2 tests:
  - A session cookie copied into a second browser context can moderate first (positive control, asserted). Then the owner clicks Sign out other devices. The copy gets 401 on moderation and 401 with no `Set-Cookie` on the session probe. The owner's page stays on the dashboard, and still does after a reload.
  - A staff context logs in with the code and logs out (the confirm text is asserted). The owner, with ONLY its claim cookie left, still opens admin without the code.
  - Targeted run on the real code: **14/14** (canary + creator-reentry). Run against RC2 + RC3: **both new tests FAIL** (`Expected: 401 Received: 200`, and the dashboard not found), canary green (`11-e2e-new-spec-vs-RC2-RC3.txt`).
- **Full jest** (`09-full-jest.txt`): **68 suites, 1195 passed, 13 skipped, 0 failed**. 2026-10-15T21:48:41Z → 21:49:04Z, load 95.93 → 100.98, `--maxWorkers=4`.
- **`npm run build`** (`10-npm-run-build.txt`): compiled; `bundle-es-target: OK — all 51 chunk(s) parse at ES2019`; `css-target: OK` for the TV surface. Advisory only: the new `.revokePanel` adds one flex-`gap` finding on the phone/desktop admin page (not build-blocking). 21:49:14Z → 21:50:52Z, load 94.65 → 94.98.
- **ONE full e2e run** (`12-full-e2e.txt`): `PORT=3118 --workers=1`, head `9a11335`, start **2026-10-15T21:55:46Z load 69.12 94.71 107.16**, end **22:02:29Z load 59.26 68.46 90.05**. No other boraoke e2e was live at start (checked; the TICKET-140 run on :3140 had finished). **Canary passed. 133 passed, 2 failed.**
  - Both failures have the same shape, in `render-and-links.spec.ts`'s `beforeEach` warm-up: `page.goto("/default/tv")` timed out at 30 s **waiting for the `load` event**. The page snapshot at failure shows the TV fully rendered (now playing "Charlie", queue Alpha/Delta…), so the server answered. What never completed is `load`, which also waits for the embedded YouTube player. The default room's queue had been seeded by earlier specs, so the TV was embedding the external iframe.
  - Not code this branch touches: no TV file changed, and the `default` room has no record, so it never reaches the epoch code. The test between the two failures ran the same warm-up and passed.
  - A targeted re-run of `render-and-links.spec.ts` + canary on the same head and port: **19/19** (22:03:11Z → 22:04:18Z, load 51.68 → 92.93). **Caveat:** an isolated run starts with an empty default queue, so it does not recreate the condition. This is a distribution of one full run, stated as such. It is not "e2e green". The TM decides whether to spend a second full run. Candidate ticket: the warm-up navigations wait for `load` on a page that embeds a third-party iframe (`waitUntil: "domcontentloaded"` would remove the network dependency).

**Local-Docker `verify-green-local.sh`** is the framework repo's gate (md-doctor + shell-tests) and does not apply to boraoke. boraoke's merge gates are jest + build + e2e, as above.

## Residuals, stated honestly

1. **Lockout residual (narrow).** A stale write that lands **after** the revoke's claim rebind leaves the claim list tagged with an old epoch, so every claim token is dead, the acting device's included. The acting device keeps the session cookie the revoke returned, and that cookie keeps rolling, so it stays signed in. Only if **that response was also lost** does the acting device need the host code. Two faults are needed. Fully closing it needs atomic room writes (TICKET-127).
2. **Counter loss plus a stale write.** If the counter key were lost (eviction, or an expiry mismatch) and a stale write had also lowered the record's floor, the epoch could drop. Upstash eviction is off by default, and the counter's TTL is copied from the record's. Two faults again.
3. **A plain logout can be undone for that one device's token** by a stale login (TICKET-127 scenario 3, now scoped to one hash instead of all). The device's own cookies are cleared, so only someone who had already copied that token benefits. "Sign out other devices" is the strong lever, and it fails closed.
4. **What the lever does not do.** It ends copied sessions and claim tokens. It does not change the host code (option C, rejected). Someone who knows the code can log in again, before or after the revoke.
5. **A new key per revoked room** (`room:<id>:session-epoch`). TICKET-151 (delete room) must delete it too; noted on the key's docblock.
6. **Lost update of a concurrent legitimate login during the rebind:** that device's new claim token may be dropped. It keeps its session cookie and can retype the code. Same class as TICKET-127 scenario 1.

## Implementation log

| SHA | What |
|---|---|
| `0a4f54a` | (10-02) epoch in the derivation, revoke route, UI, copy |
| `2b5e8a8` | (10-02) 32-test regression suite |
| `ab9189d` | merge origin/main (#91 owner pin kept) |
| `35a103c` | atomic epoch counter + epoch-tagged claim list + TICKET-112 logout + UI/copy + stale-writer probes + backend tests |
| `ffacc39` | restored teeth to the logout refusal tests; reverse-check and mutation evidence |
| `6f0951a` | e2e spec; full jest and build evidence |

## Friction

- `zsh` does not word-split an unquoted `$T`, so the mutation runner silently got one argument and jest matched nothing (exit 1, no tests). Use an array (`T=(…)`, `$T`) or `${=T}`. It cost one wasted round.
- Multi-file jest runs print no per-test `✓/✕` lines. Mutation evidence needs the `●` failure titles, not `✕` lines.
- The worktree had no `node_modules`; symlinked to the main checkout's (same `package-lock.json`). The symlink is untracked and not ignored by `.gitignore`'s directory pattern, so take care never to stage it.

---

## Condensed 2026-10-02 resume note (superseded where it conflicts with the above)

- **Chosen: A, a rotatable per-room session epoch.** C (rotate the host code) *is* the shown-once dead end TICKET-104 removes. B (server-side session records) would put a write on `requireHost`, the hottest auth path.
- **Epoch 0 keeps the byte-identical legacy HMAC message**, so the deploy logs nobody out and needs no migration (pinned by test).
- **The revoke keeps the acting device's own claim-token hash** and prunes the others in one write, so the acting device needs nothing from the response to get back in.
- `tsc` reports hundreds of pre-existing errors in `__tests__/**`; filter with `grep -E "^(app|lib|components)/.*error TS"`. `app/` and `lib/` are clean.
- `playwright.config.ts` uses `HOST=localhost` because production-build cookies are `Secure`.
