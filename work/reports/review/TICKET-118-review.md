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

---

# Delta re-review (D-022 opus), head `62279c3` — 2026-10-15

**Verdict: APPROVE.** Scope: `git diff 27298b4..62279c3`, read as the fix commit `f83b3e6` plus the merge `6f2d78b` (`--cc`, conflict hunks only), checked against `origin/main` `d0b3301`. Everything else in the range is main content from #90/#94 and was not re-reviewed.

## S1, S2, S3 (correctness and simplicity)

- **S1, fixed.** `claimSession` does one `getRoom`, which is one `MGET` of the record and its counter (`withEffectiveEpoch`). It checks the token against that snapshot (`roomClaimTokenStatus`) and derives the session from the same snapshot (`sessionForRoom`). A read before the bump gets an epoch-E value, which is dead once the bump lands. A read after the bump and before the rebind sees a list tagged E against epoch E+1, so the claim is invalid. A read after the rebind sees only the owner hash plus hashes written after the bump. For non-default rooms, `sessionForRoom` gives the same result as `resolveRoomSecret`, and `claimSession` handles `default` itself. This is the simplest correct shape: verify and derive from one value.
- **S2, fixed.** The owner check and the keep decision come from `before`, and every rebind re-asserts `owner`. Carrying `postBump` is safe because it requires `claimListIsLive(room)` at an epoch after `beforeEpoch`. A stale write restores its old tag, so it carries nothing. Only a list written after the bump (a code login, or our own earlier rebind) qualifies. My mutant R1 drops the live check, and 4 tests kill it, the S1 straddle test among them.
- **S3, fixed as the TM default.** The route pre-check (`claimStatus().owner`) runs before `chargeRevoke`, so refusals are never charged. The helper re-checks on the pre-bump snapshot, and that check is the authoritative one. The pin is set to `owner` on every rebind. The fallback mint passes `{ owner: true }`. The throttle is charge-then-check on the atomic INCR count and fails open on a Redis error (`null`), like the rest of the module. Fine for an owner-only lever.
- S4 (always mirror `PTTL`, `PERSIST` on -1) and S5 (covered by the owner/live check on `before`) are fine.

## Hot path: no added reads or writes, confirmed

- `requireHost` and `resolveRoomSecret` are unchanged in the delta.
- `GET /api/host/session` and `POST /api/host/login` swap `verifyClaim` (one `getRoom`) for `claimStatus` (one `getRoom`). Same cost, no write.
- `POST /api/host/claim` goes from two reads (`verifyClaim` plus `issueSession`) to one.
- The extra cost is all on the revoke route, which is not hot: one `claimStatus` read, one INCR, and `PTTL` on every bump (before, only with retention on), plus `PERSIST`/`PEXPIRE`.

## Can the tests fail?

- Dev evidence: `cyber-fix/13-reverse-check-vs-27298b4.txt` gives 13 failed / 43 passed on the old code, and `14-mutation-pass.txt` shows 8/8 mutants killed.
- My baseline, in a throwaway detached worktree at `62279c3`: 5 auth suites (`host-session-revocation`, `room-session-epoch-backend`, `host-claim`, `claim-token-owner-pin`, `host-auth`), **130/130 passed**.
- My own mutants, none of them in the Dev's list, each run on its own and then restored:

| # | Mutant | Result |
|---|---|---|
| R1 | `postBump` carries hashes from a DEAD list (drop `claimListIsLive`) | KILLED (4), incl. the S1 straddle and "keeps ONLY the owner's token" |
| R2 | throttle off-by-one (`<=` → `<`) | KILLED (3), incl. "4th use is a 429" |
| R3 | route-level owner pre-check removed (staff refusals get charged) | KILLED (1), "a STOLEN session alone … cannot loop it" |
| R4 | `claimSession` ignores `live` | KILLED (8) |
| R5 | rebind drops the owner pin | KILLED (5), incl. "owner pin is never removed" |

`triggered mutation pass: not triggered — no new parsing/normalisation function on a money/quantity/identity path` in this delta. `roomClaimTokenStatus` is a refactor of the existing matcher, and R4/R1 mutate it anyway.

## UX and copy

- Only the owner's device shows the button. `owner` comes from the session probe, the claim and the login, and the route re-checks it. A stale hint gets a 403, which hides the button and shows `signOutAllOwnerOnly`. `signedOut:true` now shows the gate (closes my old N3). A 401 now re-probes the session (closes N4).
- The en/es/pt-BR copy is accurate and natural. "Only the device that created this room" matches the TICKET-120 pin semantics.
- Non-blocking, for the TL's S3 decision:
  - **U1.** On the owner's device, the logout confirm (`signOutQuestion`) does not say that logging out removes the owner pin, and with it this device's ability to sign others out, with no way to get it back today. Once S3 ships, this is the main way an owner loses the lever. Either add a clause to the owner-device confirm, or pick the PR body's "re-pin on a code login when no pin exists" fallback.
  - **U2.** Staff devices get no hint at all. A manager who suspects a copied session has no visible next step, such as "ask the room's creator". This is optional.
- Nit: the `rollClaimCookie` docblock still says its call sites check with `verifyClaim`. They now use `claimSession`/`claimStatus`.

## Merge resolution (claim-route docblock)

Clean. `--cc` shows main's rewritten line 5 (`clientIpFrom`, TICKET-119) taken verbatim, with this branch's new line 6 (S1) after it. The `owner` response line is kept. `clientIpFrom` is still re-exported from `host-auth` (`./client-ip`), so the claim route's import resolves. The `host-auth` hunk is main's re-export plus the branch's new throttle block, with no lost lines.

## e2e 134/136

The two `socket hang up` failures are transport errors (`apiRequestContext.post/get`), not assertions, and they hit routes outside the delta (`POST /api/rooms` in `moderation.spec:97`, `GET /api/queue` in `tv.spec:942`). The run started at load ~153, and later tests passed, so the server did not crash. All 12 `creator-reentry` tests pass, including the new owner-only check. I accept this as evidence for the review. **Recommendation to the TM: before merge, require one clean full e2e run on the final merge head at normal machine load.** The head will move anyway (Cyber re-gate, App Tester, an possible further main merge). Two runs in a row each ended "green except 2", each time on different specs, and a third excused run would hide a real regression. It costs about 15 minutes. If load cannot be brought down, the minimum is a targeted re-run of `moderation.spec.ts` and `tv.spec.ts` against the seeded suite order.

## PR body accuracy

Accurate. It covers the S1–S6 summary, the reverse-check and mutation figures, the 134/136 numbers, the "TM default, pending TL" label on S3, and "a stolen owner claim token is still owner-equivalent". The pin-less-room limitation is stated correctly, with all three causes: pre-TICKET-120 rooms, an owner logout (verified: `revokeRoomClaimToken` deletes `ownerClaimTokenHash` when it matches), and the TICKET-127 residual. Possible fallbacks are offered. My old N2 (stolen-session line) is resolved. One gap: the limitation is in Known limits but not in the Testing Handoff. Optional: add a step 4c, "owner taps Sair, then logs back in with the code: the button is gone", so the TL sees the trade-off live.

## Conditions (unchanged from the first pass, updated)

1. Cyber re-gate PASS on the final head.
2. App Tester PASS (UI changed: owner-only button, toasts, 3 locales, 390px).
3. One clean full e2e on the final head (above).
4. TL OK, including the S3 default, with U1 put to him.

Evidence: commands above; throwaway worktree `rv96` under the session scratchpad, removed after the run. The shared worktree was not mutated, apart from this report.
