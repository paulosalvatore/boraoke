# TICKET-118 (+ TICKET-112) — Reviewer, D-022 opus pass

**PR:** #96 (draft). **Head reviewed:** `27298b4` (= `origin/ticket/118-session-revocation`, fetched). **Date:** 2026-10-15.
**Verdict:** **APPROVE** on design, code and tests, **conditional** on the gates below. This approval does not substitute for the App Tester PASS, the Cyber Security re-gate or the TL OK; none of those had run at review time. Any code change those gates cause needs a delta re-review.

## Read, in order

Tickets 112 (with the 2026-10-15 TL decision) and 118; MANAGER-LOG "TICKET-118 — mid-flight" and "TICKET-118 amendment" (A settled; B ruled out because it puts a write on `requireHost`; C ruled out because rotating the shown-once code is the TICKET-104 dead end); plan §1-§8; dev report; `work/evidence/TICKET-118/01-12` and `mutation-pass/N1-N12`; full diff `origin/main...origin/ticket/118-session-revocation` (41 files); PR body.

## Findings

### 1. Does it fix the cause? Yes.

The cause was that `sessionValue` was a pure HMAC of the immutable `hostCodeHash`, so no server state could end a minted session. The epoch is now part of the HMAC message (`lib/host-auth.ts` `sessionValue`), and `verifySessionValue` only accepts the current epoch's value, with no grace window. Epoch 0 keeps the frozen legacy message, so deploying logs nobody out. The ticket's required regression shape (mint a session, revoke, prove the OLD one dies on a real route and cannot roll itself a cookie) is the core of `__tests__/host-session-revocation.test.ts`.

### 2. Is the design the simplest correct one? Yes, given the constraints.

- The epoch in its own key with `INCR` is the smallest way to get a monotonic value without CAS on room records (TICKET-127). Keeping it in the record would need a Lua script, and the room backend has no test seam for one yet. `get` = `MGET(record, counter)` reporting `max`, plus writers carrying the effective value back as a floor, is coherent.
- The epoch tag on the claim list is needed, not decoration. Without it, a stale whole-record write restores the attacker's claim hash and `POST /api/host/claim` turns it back into a session at the new epoch. The tag makes that race fail closed. RC4/RC5 show both mechanisms are load-bearing.
- Verified that no code outside `RoomBackend` writes `roomKey(...)` directly, and every record writer in `lib/rooms.ts` spreads a `getRoom` result, so the floor is carried.
- Upstash `MGET` returns the `INCR` counter as a number or string; `normaliseSessionEpoch` handles both.

### 3. Auth hot path: write-free, no extra round trip. Confirmed by reading.

`requireHost` -> `verifySessionValue` -> `resolveRoomSecret` -> one `getRoom` (one `MGET`, was one `GET`). `verifyRoomClaimToken` is the same single read and writes nothing. The claim route is unchanged, and the rolling `GET /api/host/session` still only re-sends the held claim value. The only new writes are on `revoke-sessions` and in logout's single-hash removal; neither is on the returning-device path. The `default` room never calls `getRoom` in `resolveRoomSecret`.

### 4. Reverse-checks and mutations, reproduced (targeted jest only)

| Check | Dev claimed | Reproduced |
|---|---|---|
| Baseline: the 5 auth suites | green | **118/118 pass** |
| RC2: no-op epoch bump, claim pruning kept | 15/37 fail | **15/37 fail**, same 15 titles, core assertion included |
| RC1: derivation ignores the epoch | 12/37 fail | **12/37 fail** |
| H1: logout revokes before its refusal check, vs the fixed `host-claim` tests | 4 fail | **4/34 fail** |
| Own mutant M-a: revoke keeps every live hash (no pruning) | not run | **3/37 fail** (killed) |
| Own mutant M-b: logout revokes nothing | not run | **6/83 fail** across host-claim, revocation and owner-pin (killed) |

The `normaliseSessionEpoch` mutation table (9 KILLED, 3 SURVIVED-equivalent) holds up. N2 (`""` -> `Number("")` = 0) and N9/N10 (`-0` vs `0`, where `sessionValue` tests `epoch === 0`) are genuinely equivalent. Triggered mutation pass: triggered (new normalisation on an identity path) and done by the Dev; I spot-checked it and did not re-run it.

### 5. The hollowing-out fix: correct and proven

TICKET-112 made the four logout-refusal tests vacuous: with this-device-only logout, a logout that sends no claim cookie revokes nothing even when it succeeds. Evidence 07 (old tests pass 34/34 against the revoke-before-refusal bug) and 08 (fixed tests fail 4) show the problem and the fix, and I reproduced 08. The fix sends the device's claim cookie the way a browser would, which is the right fixture rather than a test-only path. The walk of the 21 other `issueSession` call sites is credible: none of them revokes, so their negatives are still refused by the mechanism they name.

### 6. UX and copy (en/es/pt-BR): plain, accurate, no jargon

- The logout confirm says three true things in one sentence: this device only, the others stay in, and getting back in here needs the host code. That fully answers TICKET-112's original ask (no lockout without being told).
- "Sign out other devices" warns about the cost that matters (the others need the host code) and says this device stays in. "including any you don't recognise" frames the security use without jargon.
- Terms are consistent with each catalog ("código do host" / "código de host" / "host code"). Logout is localised now.
- Accuracy note (non-blocking, item N1 below): when a STAFF device uses it, "every other device" includes the owner's phone, and the owner pin is dropped. The copy is literally true, but this is the exact case the TICKET-112 addendum worried about. It is the TL's explicit lever, so it goes to the TL-OK step, not to a code change.

### 7. e2e 133/135

The explanation is plausible and the evidence supports it, but it is not conclusive.
- Both failures are `page.goto("/default/tv")` waiting for `load` in `warmUp` (`e2e/render-and-links.spec.ts:44`). The Dev's page snapshot shows the TV fully rendered. `load` also waits for the embedded YouTube iframe, which is third-party network, under load average 69-107.
- The diff touches no TV, `default`-room or e2e-harness code. `default` has no record, so it never reaches the epoch path. The `getRoom` change (`GET`→`MGET`) only applies to recorded rooms in the memory backend that e2e uses.
- Against that: MANAGER-LOG says the suite is deterministic (126/126 on 6 cold runs) and that a failure "means something". One full run is a distribution of one, and the targeted 19/19 rerun did not reproduce the seeded-queue condition.
- **`domcontentloaded`:** yes, but in a **separate ticket, not this PR.** These page warm-ups were written for `next dev`'s lazy compile (TICKET-88/116). Under `next build` + `next start` they compile nothing, so `domcontentloaded`, or dropping the page warm-ups, removes a third-party network dependency from a `beforeEach`. It is a harness change that affects every test in that file, so it needs its own distribution. Putting it in an auth PR would muddy both signals.
- **Merge condition:** one more full e2e run on the final head (about 7 minutes). If `render-and-links` fails the same way again, that confirms the harness ticket and the run is acceptable with the failure noted. A failure anywhere else blocks.

### 8. PR body accuracy: accurate, with three small gaps

The summary, known limits, evidence numbers (12/15/3/4/4, 9+3, 1195, 133/135) and testing handoff all match the diff and evidence. The cookie name in handoff step 3 (`cantai_host_<room>`, path `/api/host`) matches `hostCookieName`. Gaps:
- (a) `tsc app/lib 0 errors` is claimed but has no evidence file.
- (b) Known limits leaves out that a holder of a stolen SESSION can press "sign out other devices" themselves and push the owner onto the host code. That is not a regression: on `main`, logout let them clear every claim token. But this PR moves that capability from logout to the new route, so it should say so.
- (c) The Gates checklist leaves "Reviewer APPROVE" unticked. Tick it with this verdict's conditions.

## Items

**Merge conditions (not code changes):**
1. App Tester PASS, including the 390px header and the three locales. No approved mockup is recorded for this surface.
2. Cyber Security re-gate PASS. Point it at item N2.
3. One more full e2e run on the final head, judged as in §7.
4. TL OK (patron/staff-facing, TICKET-112), presented with item N1.

**Non-blocking:**
- N1 (TL-OK context): a staff "sign out other devices" also signs out the owner's phone and drops the owner pin. That matches the TL's "every device must lose access" lever. Present it as such.
- N2 (PR body, Cyber): add the stolen-session-can-revoke line to Known limits (gap 8b), plus 8a and 8c.
- N3 (optional, UI): if `revoke-sessions` ever returns `{ok:true, signedOut:true}`, the UI still shows "This one is still signed in". In practice that branch is unreachable, because a record without `hostCodeHash` fails `requireHost` first. Either drop the branch or handle it.
- N4 (optional, UI): a 401 from `revoke-sessions` (this device's session was already revoked by another device) shows "Couldn't sign the other devices out", which misdescribes what happened. Low frequency.
- N5 (optional, a11y): the two confirm panels use `role="alert"`, so screen readers interrupt as soon as a panel opens. A plain region or `role="group"` fits better. The toast's `role="status"` is right.
- N6 (follow-up ticket): change the `render-and-links` warm-up to `domcontentloaded`, or drop the page warm-ups under `next start` (§7).

Triggered mutation pass: triggered (`normaliseSessionEpoch`, identity path). The Dev ran it, I spot-checked it, and there are 0 SURVIVED-real-gap mutants.
Design-parity: no approved mockup recorded for the admin header; the App Tester should confirm.
CI: `verify-green-local.sh` is the framework repo's gate and does not apply to boraoke. boraoke's gates are jest + build + e2e, as listed.

## Process note

During my mutation runs an untracked `__tests__/zz-cyber-118-probe.test.ts` appeared in this worktree, so a Cyber agent was working here at the same time. My mutations were temporary edits to `lib/rooms.ts`, `lib/host-auth.ts` and `app/api/host/session/route.ts`, each restored with `git checkout --` (tree verified clean afterwards). For a few seconds at a time, a Cyber jest run could have seen mutated code. If any Cyber result from about the same time looks odd, re-run it. I did not touch the probe file.

## Friction

Two gate agents ran mutation work in one worktree at once. Mutation and reverse-check runs should go in a throwaway copy or a separate worktree, not the shared ticket worktree.
