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

---

## 2026-10-15 — Cyber gate FAIL addressed (S1–S6)

**Picking up from:** Cyber FAIL on `27298b4` (`work/reports/security/TICKET-118-security.md`, PR comment 6203468659) and the Reviewer's conditional APPROVE (`work/reports/review/TICKET-118-review.md`). Pulled to `849db6c` (= `f996d18` + event auto-commit).

**Status:** fix committed and pushed, origin/main merged (a merge, not a rebase), targeted + full jest green, build OK, one full e2e run (2 socket-hang-up failures outside this diff, see below). Ready for the Cyber re-gate and a delta re-review.

### What changed

| Finding | Fix |
|---|---|
| **S1 HIGH** | `claimSession` (lib/host-auth.ts) verifies the claim and derives the session from **one** `getRoom` snapshot via `sessionForRoom(room)`. The claim route uses it, so a claim straddling a revoke gets an old-epoch value that is already dead. Also one read instead of two. |
| **S2 MEDIUM** | `revokeRoomHostSessions` decides from the **pre-bump** read. It re-asserts the owner's hash on every rebind, whatever the in-loop list holds, and carries hashes already tagged with an epoch after the one it read (a concurrent code login). |
| **S3 MEDIUM** (TM house default, **pending TL confirmation**) | Owner's device only: the request must present the live owner-pinned claim token. This is checked in the route (403 `{ownerOnly:true}`, never charged) and again, authoritatively, inside the helper on the same pre-bump snapshot it acts on. The owner pin is never removed (it is always rewritten to the owner hash). Per-room throttle of 3 per 10 min, charged atomically: the new additive `registerFailureCount` returns the INCR result from the existing Lua script, so a concurrent burst cannot all pass a check. The host code is not required. UI: the button is shown only when the server reports `owner: true`. The 403 and 429 responses get their own messages. |
| **S4 LOW** | `bumpSessionEpoch` mirrors the record's real TTL: `pexpire` when it has one, `persist` when it has none (-1), whatever the config. The residual is noted in the ticket. |
| **S5 LOW** | Fixed by S3's check: the presented token must be live in a list tagged with the current epoch. |
| **S6 LOW** | Done/error copy corrected in en/es/pt-BR. The error now says this device may need the host code. A `signedOut` response shows the gate. A 401 re-probes the session (Reviewer N4). |

When every rebind is clobbered, the route mints a fresh **owner** claim (`attachClaimCookie(..., {owner:true})`), so the pin survives that path too.

### Auth hot path: still write-free, no extra round trip

- `requireHost` and `verifySessionValue` are unchanged: one `getRoom` (one MGET), no write.
- `POST /api/host/claim`: was 2 reads (`verifyClaim` + `issueSession`), now **1** (`claimSession`). Pinned by the test "the claim route makes ONE store read for a valid claim".
- `GET /api/host/session` and `POST /api/host/login`: `verifyClaim` was swapped for `claimStatus`. That is the same single read, and it also returns `owner`. No added read, no write.
- Every new read and write (owner pre-check, throttle INCR, rebind) is on `revoke-sessions` only, which no returning device calls.

### Prove-your-test-can-fail

**(a) Reverse-check.** The new test files run against the pre-fix implementation `27298b4`, in a throwaway detached worktree (the shared worktree was never mutated; it was removed afterwards). Result: **13 failed, 43 passed, 56 total**. Evidence: `work/evidence/TICKET-118/cyber-fix/13-reverse-check-vs-27298b4.txt`. S1's core assertion, verbatim:

```
  ● Cyber S1 — a claim verified before a revoke cannot mint a session that survives it › a claim request straddling the bump gets a session that is ALREADY dead

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

    > 927 |     expect(await verifySessionValue(v.room.id, minted)).toBe(false);
```

The other new tests that fail on `27298b4`:
- S1 one-read
- S2 lost-response re-claim
- S3 staff refused
- S3 stolen session refused
- S3 throttle
- S3 owner flag
- helper staff refused
- helper S5 dead-tag refused
- helper invented token refused
- concurrent-burst throttle
- clobbered-rebind owner mint
- S4 TTL flip (backend test)

One new test passes on the old code by construction: "the owner pin is never removed". The old code kept the presented hash, and in that test the presented hash is the owner's. It is a regression guard, not a fix proof.

**(a) Mutation kills** (`work/evidence/TICKET-118/cyber-fix/14-mutation-pass.txt`). The baseline was 56/56, and all 8 mutants were KILLED:

| Mutant | Change | Killed by |
|---|---|---|
| M1 | claim route derives from a second read | both S1 tests |
| M2 | keep only if the hash is found in the in-loop list | S2 |
| M3 | owner check weakened to "live" | helper staff test, S3 staff test |
| M4 | throttle never refuses | burst test, throttle test |
| M5 | `persist` removed | S4 flip test |
| M6 | post-bump hashes not carried | S2 |
| M7 | fallback mint not owner | clobbered-rebind test |
| M8 | owner flag = live | 3 S3 tests |

**(c) Hollowing-out.** A primitive beneath existing assertions changed: `revokeRoomHostSessions` is now owner-only. I re-examined every existing revoke test:
- `venue()` now mints the **owner** token, as room creation does. Without that, those tests would have been refused, not passed vacuously, so none became true by construction.
- The 12-way concurrent test now asserts exactly 3×200 + 9×429 and epoch 3, rather than 12.
- The "no claim token, minted one" test no longer describes reachable behaviour (such a caller is now refused). It was replaced by the clobbered-rebind owner-mint test.
- The helper "keeps ONLY the presented token" test now uses the owner token and also asserts the pin.
- host-claim "Bar Multi" now uses an owner actor and asserts every non-owner token dies.

**(d) Triggered mutation pass:** not triggered. There is no new parsing or normalisation function on a money, quantity or identity path. `roomClaimTokenStatus` is a refactor of the existing `verifyRoomClaimToken` comparison, and is covered by M8.

### Merge of origin/main

`git merge origin/main` (#90 client-ip/search, #94, d0b3301). The only conflict was the claim-route docblock: main's contract line 5 (client-ip wording) was kept, with my line 6 added after it. Merge commit `6f2d78b` has parents `1fac664` and `d0b3301`. `tsc` app/lib: 0 errors.

### Verification (verbatim)

- Targeted auth suites on the merged tree: these 9 suites all PASS, **`Tests: 182 passed, 182 total`**:
  - rate-limit-counter
  - host-auth
  - room-session-epoch-backend
  - client-ip
  - advance-rate-limit
  - queue-rate-limit
  - host-claim
  - host-session-revocation
  - claim-token-owner-pin
- Full jest, once: **`Test Suites: 73 passed, 73 total` / `Tests: 21 skipped, 1293 passed, 1314 total`** (`16-jest-full.txt`).
- `npm run build`: OK. `bundle-es-target: OK — all 51 chunk(s) parse at ES2019`, `css-target: OK — the TV surface uses nothing newer than Chrome 68`.
- **e2e, ONE full run** (workers 1, `PORT=3118`), log in `15-e2e-full-run.txt`. No other boraoke e2e was live; the only `next start` on the machine was a rachei worktree on 3917.
  - Start `2026-10-15T22:50:09Z`, load `153.08 154.01 147.60`.
  - End `23:05:47Z`, load `124.80 136.55 140.84`.
  - Result: **canary 2/2 green, `134 passed`, `2 failed`.** All 12 `creator-reentry` tests pass, including the TICKET-118/112 ones and the new owner-only button assertion. The known `/default/tv` warm-up `load` timeout did **not** recur.
  - Both failures were `socket hang up` from the server, on routes this diff does not touch:
    - `moderation.spec.ts:97`, in its warm-up `POST /api/rooms`
    - `tv.spec.ts:942`, in `drainQueue` `GET /api/queue`
  - Both happened at load around 150. They look like the server being starved under machine load, not a product failure. Per the brief I did not re-run.

### Residuals and TL items (also in the ticket and PR body)

- **S3 is a TM house default pending TL confirmation.** The new limit it creates is that a room with no live owner pin cannot use the lever: legacy pre-TICKET-120 rooms, an owner who logged out on the owner device (logout clears the pin), or an owner list killed by the TICKET-127 residual. Options for the TL: a host-code step-up for pin-less rooms only, or re-pinning on a code login when no pin exists.
- The S4 residual (retention flipped off with no later revoke) is parked in the ticket.
- The TICKET-127 two-fault residual (a stale write after the rebind plus a lost response) is unchanged.

### Friction

- zsh again: an unquoted `$files` passed as one argument to `commit-and-push.sh` (it failed safely, nothing was staged). Use `("${(@f)…}")` arrays.
- Cyber's S1 probe gated the *second* read. After the fix there is only one, so a verbatim port would hang. The regression test instead gates **after the first read returns**, which works on both the old code and the new.
