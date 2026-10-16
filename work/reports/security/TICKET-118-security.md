# TICKET-118 / TICKET-112 — Cyber Security gate (D-011), PR #96

**Verdict: FAIL** (1 HIGH, 2 MEDIUM, 3 LOW, 3 INFO).

Audited head `27298b4` on `ticket/118-session-revocation` (verified equal to `origin/ticket/118-session-revocation`), 2026-10-15. Diff: `git diff origin/main...HEAD`. The branch merges cleanly with current `origin/main` (#94 merged; `git merge-tree` clean). #90 (client IP) is not merged yet; this PR does not touch `clientIpFrom`, so the only overlap is the claim route's failure throttle, which is unchanged here.

## Scope

- `lib/host-auth.ts` (epoch in `sessionValue`, `resolveRoomSecret`), `lib/rooms.ts` (counter key, `withEffectiveEpoch`, `claimTokenEpoch` tag, `revokeRoomHostSessions`, `revokeRoomClaimToken`, both backends), `app/api/host/revoke-sessions/route.ts` (new), `app/api/host/session/route.ts` (logout scope), `AdminRoom.tsx` (fetch handling), the three message catalogues.
- Blast radius followed into every route that turns a credential into a session: `app/api/host/claim/route.ts`, `app/api/host/login/route.ts`, `GET /api/host/session`, `app/api/rooms/route.ts` (owner mint), `lib/retention.ts`.
- Read: ticket, plan §8, dev report, `work/evidence/TICKET-118/`.

## Evidence

- The dev's auth suites, on this head: `host-session-revocation`, `room-session-epoch-backend`, `host-claim`, `claim-token-owner-pin`, `host-auth`. **5 suites, 118/118 passed.** The dev's TICKET-127 stale-writer probes reproduce green: a stale whole-record write can no longer roll the epoch back or resurrect a pruned claim token.
- My own probes: `work/evidence/TICKET-118/security/cyber-probes.test.ts.txt` (source; it was run from `__tests__/` and then removed, it is not part of the suite). Verbatim output: `work/evidence/TICKET-118/security/cyber-probes-output.txt`. 2 probes fail on the security property (S1, S2) and 3 document behaviour (S3 ×2, S4).
- Redis semantics, in a throwaway `redis:7-alpine` container (stopped afterwards): `INCR` keeps an existing TTL (99892 ms); `SET … KEEPTTL` keeps it; a plain `SET` drops the record's TTL to -1 while the counter keeps its TTL (99800 ms); `MGET` with the counter gone returns the record and `nil`.
- No e2e, no build, no server, as briefed. boraoke has no `verify-green-local.sh`; the targeted jest above is the green evidence for the touched suites.

## Findings

### S1 — HIGH — the claim route can mint a NEW-epoch session from a claim token the revoke has just killed (TOCTOU)

**Where.** `app/api/host/claim/route.ts`: `verifyClaim(req, roomId)` (one `getRoom`) and then `issueSession(roomId)` (a second, independent `getRoom`). The epoch bump in `revokeRoomHostSessions` (`lib/rooms.ts`, `roomBackend.bumpSessionEpoch`) can land between the two reads.

**Exploit.** An attacker holding a copied claim cookie (the exact adversary this ticket exists for) polls `POST /api/host/claim`. A successful claim is never throttled (the route verifies before touching the budget, by design). Any request whose first read lands before the bump and whose second read lands after it is told "valid claim" by the pre-revoke record and is then handed a session derived from the **post-revoke** epoch. The owner sees "Done. Every other device is signed out." and the attacker holds a working session at the new epoch. The window is one store round trip per request (about one Upstash REST call), so a scripted attacker polling continuously straddles a revoke with high probability, without needing to know when it happens.

**Reproduced** (deterministic gate between the two reads, `cyber-probes-output.txt`):

```
revoke status 200 epoch now 1
attacker claim status 200 minted session? true
attacker post-revoke session verifies: true moderation: 200
attacker counter-revoke: 200 owner's revoke-issued session still valid: false owner claim still valid: false
```

The last line is the escalation: with the surviving session, the attacker calls "sign out other devices" in turn. The owner's fresh session and the owner's claim token both die, so the owner needs the host code, and the attacker now holds a claim token minted for it by the revoke route (`attachClaimCookie`, since it presented none that was live).

**Why HIGH.** It defeats the property the PR claims (route contract line 5: "No false success, and no rollback"; the docblock on `revokeRoomHostSessions`: "From the moment it returns, every session value derived from an earlier epoch fails to verify"). The epoch is monotonic, but a session derived from a verification made against the old epoch is not tied to that epoch. The dev's randomized probe does not cover it, because its writers are only record writers, never a credential-to-session exchange.

**Remediation direction.** Verify and derive from ONE snapshot. For example, have the claim verification return the epoch (or the room) it verified against and derive the session from that same epoch, so a request that straddles the bump gets an old-epoch value that is already dead. Or re-verify the claim after deriving the session and refuse when it no longer holds. Audit every credential-to-session exchange the same way (`login` re-verifies the host code, which the revoke does not change, so it is not affected; `GET /api/host/session` re-sends the verified value rather than re-deriving, so it is not affected). Add a probe with a gate between the two reads, like S1, that fails on today's code.

### S2 — MEDIUM — an ordinary concurrent login (no stale write) kills the acting device's own claim token; then a lost response alone locks it out

**Where.** `lib/rooms.ts`, `revokeRoomHostSessions`, the rebind loop: `keep` is computed from the list read **inside the loop** (`live = room.claimTokenHashes`), not from the list the revoke read before its bump.

**Path.** Bump to E+1. A staff member types the host code at that moment. `issueRoomClaimToken` reads the room at E+1, sees the list tagged E, so treats it as dead and writes a fresh list `[staff]` tagged E+1. This is a normal, non-stale write. The rebind then reads `[staff]`, does not find the acting device's hash, keeps nothing (and drops the staff device's brand-new token, residual 6), and returns `keptClaimToken: false`. The acting device is now entirely response-dependent: its old session is dead and its old claim token is gone. If that response is lost, it is locked out.

```
concurrent staff login 200
revoke 200 minted fresh claim in response? true
lost-response device: old session valid false old claim valid false claim route 401
```

**Is the dev's residual "really two-fault"?** The stated residual (a stale write after the rebind plus a lost response) is two events, yes. S2 is a different interleaving with the same count: one ordinary concurrent login, which is not a fault at all, plus one lost response. So the plan's P2 guarantee ("if the response is lost entirely … the acting device's next admin mount auto-claims with that surviving token … there is no response-delivery lockout window") does not hold under a routine concurrent event. A device that held no live claim token before the revoke (evicted by the cap of 5, or left dead by an earlier race) is response-dependent with **no** concurrent event at all. That one is documented, but the copy does not mention it.

**Severity reasoning.** MEDIUM, not HIGH. It needs a lost response, the window is narrow, and a device that has the host code recovers by typing it. On this surface a lockout is the recurring failure mode, though.

**Remediation direction.** Decide `keep` from the pre-bump read (`before`): the presented hash was live then, and the caller is authenticated. Re-assert it in every rebind iteration, whatever the current list holds. Also carry forward any hash already tagged with the new epoch (a post-bump login proved the host code), instead of dropping it. This closes S2 and residual 6 together.

### S3 — MEDIUM — any host session, including a stolen one, can sign the OWNER out (pin included), with no throttle

**Where.** `app/api/host/revoke-sessions/route.ts`. The only authority check is `requireHost`, and there is no rate limit. `revokeRoomHostSessions` drops `ownerClaimTokenHash` unless the caller is the owner.

```
staff revoke 200 owner session valid false owner pinned claim valid false ownerPin now (none)
owner revoke attempts refused 401: 20 / 20; attacker still valid: true
```

- A staff device signs the owner out and removes the TICKET-120 owner pin. If the owner does not have the code (the reason TICKET-120 and TICKET-112 exist), the owner cannot get back in. The copy does say "every other device", so this is a product decision as much as a security one, but the TL should make it knowingly.
- A holder of a stolen session (or a former staff member who knows the code, which cannot be rotated) can loop revokes. Each tick returns a fresh session for the caller and kills everyone else. The probe shows a code-holding owner's own revoke refused 20 out of 20 times. Before this PR a stolen session meant shared control. With a loop it now means exclusive control, and there is no lever above "sign out other devices" (the code cannot be rotated).
- Not HIGH on its own: a stolen session already allowed full sabotage (skip, remove, pause), and the loop needs automation. Combined with S1, it is how a revoked attacker turns survival into owner lockout.

**Remediation direction (TL decision).** Step-up: require the host code, or the owner-pinned claim token, to call revoke-sessions. A stolen session or copied staff credential then cannot use the lever, and the owner can always win. Add a per-room throttle (for example one revoke per N seconds). Keep the owner pin unless the owner is the caller, or let only the owner remove it.

### S4 — LOW — a retention config flip can make the counter expire before its record

`UpstashRoomBackend.bumpSessionEpoch` copies the record's TTL onto the counter when retention is on. If `ROOM_RETENTION_DAYS` is later switched off, the next record `update` is a plain `SET`, which drops the record's TTL (measured: -1), while the counter keeps its TTL (99800 ms). When the counter expires, the epoch falls back to the record's floor. That is only a downgrade if a stale write had also lowered the floor (dev residual 2), so two conditions are needed and the attacker controls neither. Direction: when retention is off, `PERSIST` the counter on bump, or have `update` keep the two TTLs aligned.

### S5 — LOW — the rebind keeps the presented hash even from a list whose tag is dead

`keep` checks membership in `room.claimTokenHashes` without checking `claimListIsLive(room)`. The caller must already hold a valid current session, so re-validating its own (possibly pruned) token gives it nothing it could not get from the revoke route's mint anyway. There is no escalation. Noted because the docblock says "only if it is genuinely live in the record", and that is not quite what the code checks.

### S6 — LOW — copy overstates the result

- `signOutAllDone` ("Every other device is signed out") is false under S1. It becomes accurate once S1 is fixed.
- The `signedOut: true` branch (host controls locked) is still shown "This one is still signed in." The UI only checks `res.ok`. It is unreachable for a real room (every room record has `hostCodeHash`), so this is cosmetic.
- `signOutAllError` says the others "may still be signed in". It does not say that this device may need the host code (a lost response combined with S2, or a device with no live claim token). Accurate otherwise in en, es and pt-BR. `signOutQuestion` (logout: this device only, the others stay in, the host code is needed to come back) matches the code.

### INFO

- **I1 — Epoch-0 compatibility holds.** The epoch-0 HMAC message is byte-identical (`SESSION_MESSAGE_V1`). The missing counter key reads as `nil` → 0, and an absent tag equals an absent epoch, so the deploy logs nobody out. There is no downgrade path an attacker can drive: neither the counter nor the record is client-writable, `normaliseSessionEpoch` is reached only with stored values, and a missing counter falls back to the record floor (which the rebind writes as the effective epoch).
- **I2 — Memory driver in production** keeps the epoch per lambda. The room records are per lambda there too (`isEphemeralRoomStore`), so this adds nothing new.
- **I3 — Plain logout (TICKET-112) is sound.** It stays behind the same two refusals. It can only remove the hash of a token whose preimage the caller presents. Probe S4 sends the stored hash, junk, a suffixed token and empty values, and the other device's token stays valid. CSRF on the new route is identical to logout: `Sec-Fetch-Site` or `Origin` check plus `SameSite=Lax` `HttpOnly` cookies. `same-site` (sibling subdomain) is accepted, the same pre-existing posture as logout. The 401 is undifferentiated, so there is no room oracle.

## Required to pass

1. Fix S1, and add a probe that fails on the current code (gate between the claim verification and the session derivation).
2. Recommended in the same PR (cheap, same function): S2's `keep`-from-`before` change.
3. S3 goes to the TL as a decision: step-up or owner-only revoke, plus a throttle. It does not block on its own.

## Friction

- Third time on this surface that a guarantee held for every **record writer** but not for a **read-then-derive** path. Proposed class-level check for auth reviews: list every place that verifies a credential with one store read and derives authority with another, and require a gated-interleaving probe for each. A candidate addition to the `prove-your-test-can-fail` skill's concurrency section.

---

## Re-gate, 2026-10-15, head `62279c3` — **Verdict: PASS-WITH-NOTES**

Audited `62279c3` (= `origin/ticket/118-session-revocation`; fix `f83b3e6`, merge of main `6f2d78b` bringing #90 and #94). Read the dev report's "Cyber gate FAIL addressed" section and `work/evidence/TICKET-118/cyber-fix/`. Diff read locally: `git diff 27298b4 f83b3e6 -- lib app/api` plus `git diff origin/main -- lib app` for the whole PR.

All S1 to S6 findings are closed. Nothing new rises to HIGH. One new MEDIUM (R-1) and one LOW (R-2) are both consequences of the S3 owner-only design meeting the known TICKET-127 residual. They are the reason the no-pin fallback matters, and they do not block.

### Evidence

- Probe source: `work/evidence/TICKET-118/security/regate-probes.test.ts.txt`. It ran as `__tests__/zz-cyber-regate.test.ts` and was then deleted. Verbatim output: `work/evidence/TICKET-118/security/regate-probes-output.txt`. **13/13** probes ran. `git diff --quiet -- lib app` passed before every run, and the shared worktree was left unmodified (only `?? node_modules`, never staged).
- Targeted auth suites on `62279c3`: rate-limit-counter, host-auth, room-session-epoch-backend, client-ip, advance-rate-limit, queue-rate-limit, host-claim, host-session-revocation, claim-token-owner-pin. **9 suites, 182/182 passed.**
- Redis semantics for S4, in a throwaway `redis:7-alpine` container (since stopped): a plain `SET` leaves the record's PTTL at -1. `INCR` keeps the counter's copied TTL (97669 ms). `PERSIST` then returns 1 and the counter's PTTL becomes -1. `PEXPIRE` with the record's PTTL copies it (48789 ms). PTTL on a missing record is -2, and then neither branch runs.
- No e2e and no build were run, as briefed. boraoke has no `verify-green-local.sh`, so the targeted jest above is the green evidence for the touched suites, as it was in the first gate.

### 1. S1 — CLOSED

`claimSession` (`lib/host-auth.ts`) verifies the claim and derives the session from one `getRoom`. On Upstash that is one `MGET` of the record and the counter, which is atomic. Results:

- **R1a, the original S1.** The claim's only read is gated after it returns and before the derivation, and the revoke lands in that gap. Output: `attacker claim 200 minted? true verifies: false moderation: 401 re-claim: 401`. The value was minted at the old epoch and was already dead.
- **R1b.** The claim read lands between the bump and the rebind: 401. The list is tagged E and the epoch is E+1.
- **R1c.** The claim read lands between the rebind write and its confirming re-read: 401.
- **R1d.** 12 concurrent polls straddle a revoke: `surviving sessions: 0`.
- **R1e.** The attacker's own logout reads before the bump and writes after the rebind (a stale writer). The stolen claim does not come back to life, because the restored list carries its old tag.
- **Resurrection by construction.** The rebind carries a hash only if it sits in a list that is live at an epoch after the one the revoke read. `issueRoomClaimToken` appends only to a list that is live at the epoch it read, and tags the result with that epoch. So the first list at E+1 is either the rebind's `[owner]` or a code login's fresh `[new]`. A pre-revoke hash cannot enter it.
- **Other credential-to-session exchanges.** `login` re-derives from the host code, which a revoke does not change. `GET /api/host/session` re-sends the value `requireHost` just verified and derives nothing. The revoke route derives from `result.room`, the snapshot the helper confirmed.

### 2. S2 — CLOSED

**R2.** A staff code login lands between the bump and the rebind, and the revoke response is lost. Output: `owner old claim live true re-claim 200 session verifies true concurrent staff claim kept true`. `keep` is now decided from the pre-bump read, the owner hash is re-asserted on every rebind, and the post-bump staff hash is carried. This also fixes my old residual 6.

### 3. S3 — CLOSED (owner-only, never removes the pin, 3 per 10 min)

- **R3a.** Each of these gets 403 and leaves the epoch unchanged:
  - a staff session with a staff claim
  - a stolen session with no claim
  - a session that presents the stored owner-pin HASH as the cookie
  - a junk claim
  - forged owner hints: `?owner=true`, an `x-owner` header, a `boraoke_owner` cookie, a JSON body `{owner:true, ownerClaimTokenHash}`

  The route reads no request body or flag. `owner` is computed server-side from `hashClaimToken(presented) === ownerClaimTokenHash`, inside a live list. After those 5 refusals the owner still had the full budget: `200,200,200,429`. Refusals are not charged.
- **R3b, replaying the owner claim cookie.** A thief holding a copy of the owner's claim token IS the owner to the server. That is inherent: the token is a bearer credential, and nothing short of the host code tells the two holders apart. Two limits apply: the owner's device keeps its token, so it auto re-claims (200), and a thief can spend at most 3 revokes per 10 minutes. Once the owner logs out on the owner device, the replay gets 403.
- **R3c, the pin changes mid-request.** The owner logs out between the route's pre-check and the helper's pre-bump read. The helper, which is the authoritative check, returns 403 and the epoch stays 0. That refused request was still charged, because the charge happens between the two checks. Only the owner's own request can reach that point, so this is INFO.
- **R3d, throttle burst.** 20 concurrent owner revokes: `{"200":3,"429":17}`, epoch 3. The budget is charged before the check, using the INCR result returned by the existing Lua script (`registerFailureCount`).
- **Throttle bypass.** The key is `hostrevoke:<roomId>`. `roomIdFromRequest` accepts only `ROOM_ID_RE` ids and maps them 1:1 to the record key, so there is no alias that splits the bucket. On a Redis error the throttle fails open (`null` → allowed), the same posture as the rest of `rate-limit-counter`. A caller still has to pass the owner check first, so this is INFO.

### 4. Fallback for rooms with no live owner pin — recommend **(a)**, a host-code step-up for pin-less rooms only

The lever is unavailable more often than it looks, and in two cases it is unavailable exactly when it is needed:

- **R-1 — MEDIUM (new consequence of a known residual).** One stale whole-record write landing after the rebind costs the room its owner pin, and the owner cannot get it back. Such a write can come from an ordinary staff moderation toggle, or from the thief's own session spamming settings writes while it is still valid. In probe R1f, `setRoomModeration` reads before the bump and writes after the rebind. Output: `owner flag false owner re-claim 401 owner 2nd revoke 403 after code re-login pin (none)`. The list is restored with its pre-revoke tag, so it is dead. The owner's next code login then takes the `bound=false` branch of `issueRoomClaimToken`, and that drops the pin for good. The revoke itself still worked: the thief's session is dead. What is lost is the lever and the owner's no-typing path. The owner stays in only on the session cookie the revoke handed back. A lockout needs this race plus the owner losing that cookie and not having the code. R1e shows the same thing with a stale logout write. At `27298b4` the same race did not cost the lever, because any session could revoke. Fix classes: TICKET-127 (atomic or field-level room writes), plus the fallback below.
- **R-2 — LOW.** If the owner's claim token is copied, the owner's only way to kill the copy is to log out on the owner device. That also removes the pin, and with it the lever. In R4, after logging out and logging back in with the code, the owner gets `owner flag false`, the revoke gets `403`, and `thief session still valid true`. The thief's session keeps rolling with no expiry, because nothing is left that can end it.

Ruling:

- **(a) Host-code step-up for pin-less rooms only. RECOMMENDED.**
  - It grants nothing the code does not already grant. The code is a permanent master credential that cannot be rotated: any holder can log in at any time. Letting a holder also end other sessions keeps control symmetric between code holders, which is the posture main had before this PR, and the per-room 3/10-min throttle bounds it.
  - A stolen session or a copied staff claim still cannot use the lever.
  - It adds no write to the login path. The new check runs only on `revoke-sessions`.
  - It recovers R-1, R-2 and legacy pre-TICKET-120 rooms.

  Conditions:
  1. "Pin-less" is judged from the helper's pre-bump snapshot, and means `ownerClaimTokenHash` is absent OR is not in a live list. Without the second half, the R-1 rooms would still be stuck.
  2. The code is verified in constant time against `hostCodeHash`, inside the same request.
  3. A wrong code is charged to the existing per-IP login failure throttle, and that throttle is checked first. Otherwise this route becomes an unthrottled guessing oracle for an 8-character code, which would be HIGH.
  4. The step-up revoke does **not** auto-pin the acting device. If it did, the first code holder to act, who could be an ex-staff member, would take the pin. The real owner would then sit in a pinned room where they are not the owner, the lever would be closed to them, and the S3 asymmetry would be back in the attacker's favour. If the TL wants re-pinning, it should be an explicit owner action, decided separately.
  5. The kept hash in step-up mode is the caller's presented live token, if there is one. Otherwise use the existing mint path (non-owner).
- **(b) Re-pin on a code login when no pin exists. NOT recommended.**
  - It puts a write on the login path, the surface where every earlier lockout on this ticket line came from.
  - It hands ownership silently to whoever types the code first. In a legacy room that is arbitrary staff. After R-1 or R-2 it may be the attacker, who then holds the only lever, the asymmetric exclusive-control case S3 was meant to remove.
  - Small correction to the brief: in the mint branch, setting `owner:true` would ride on the write `issueRoomClaimToken` already makes. A device that already holds a live non-owner token would need an extra write. Either way, the ownership-transfer problem is disqualifying on its own.
- **(c) Leave it unavailable and document it. Acceptable only as a stopgap.** It leaves every legacy room, and every R-1 or R-2 room, with no way to end a copied session, which is the threat this ticket exists for. It is not worse than main, where no lever exists at all, so it does not block this PR.

**Disposition:** non-blocking for #96. File (a) as a follow-up ticket with the five conditions above, and send it to the TL together with the S3 owner-only house default, which is still pending his confirmation.

### 5. S4 / S6 / merge with #90

- **S4 — CLOSED.** `bumpSessionEpoch` mirrors the record's real PTTL: `pexpire` when it is above 0, `persist` when it is -1, nothing when it is -2. The Redis semantics check is above, and the backend unit test is mutation-killed (M5). The residual is noted in the ticket: retention is switched off and no revoke follows, so the counter keeps its old TTL until the next bump.
- **S6 — CLOSED.** en, es and pt-BR now say the others need the code to get back in. The error copy now warns that this device may need the code. The owner-only (403) and throttled (429) responses each have their own message. The button appears only on a server-reported `owner: true`, and the server enforces the check regardless. `signOutAllOwnerOnly` ("the device that created this room") matches the pin semantics.
- **#90 client-ip — no new issue.** `clientIpFrom` is used unchanged by the claim and login failure budgets. The new revoke throttle is per room, not per IP, so the #90 header-trust rules do not reach it. The claim route still verifies before it touches the budget, so a shared venue IP cannot deny a valid claim. In the merge conflict on contract line 5, main's wording was kept and line 6 was added.

### 6. Hot-path claim — CONFIRMED

Store ops were counted by spying on `roomBackend` (R6), and `git diff origin/main` of the routes was checked against those counts:

| Path | Store ops on this head | Compared with main |
|---|---|---|
| `requireHost` | `get=1 update=0` | `requireHost` and `verifySessionValue` are unchanged; the epoch comes in the same MGET |
| `GET /api/host/session` | `get=3 update=0` | `verifyClaim` swapped 1:1 for `claimStatus` |
| `POST /api/host/claim` | `get=1` | down from 2 |
| `POST /api/host/login` with a live claim | `get=4 update=0` | `verifyClaim` swapped 1:1 for `claimStatus` |
| `POST /api/host/login` minting a claim | `update=1` | the mint write that already existed on main |

No `bumpSessionEpoch` or new write on any of them. Every new read and write (the owner pre-check, the throttle INCR, the rebind) is on `revoke-sessions` only.

### Notes (non-blocking)

| ID | Sev | Item |
|---|---|---|
| R-1 | MEDIUM | A stale whole-record write after the rebind costs the room its owner pin for good (R1f, R1e). Fix: TICKET-127 plus fallback (a). |
| R-2 | LOW | When an owner's token is copied, the only way to kill the copy also removes the lever (R4). Fix: fallback (a). |
| R-3 | INFO | A copy of the owner's claim token is the owner, which is inherent. Bounded by the throttle, and the owner's own device keeps access. |
| R-4 | INFO | One charged 403 when the pin vanishes between the two owner checks (R3c). Only the owner can reach it. |
| R-5 | INFO | The throttle fails open on a Redis error, consistent with the module, and sits behind the owner check. |

### Friction

The read-then-derive class from the first gate was fixed here by the snapshot pattern (`claimSession`, `sessionForRoom(result.room)`). The remaining risk on this surface is now entirely the **whole-record write** class (TICKET-127). The S3 owner-only design changed it from "a stale write costs a no-typing path" into "a stale write costs the room's recovery lever". Prioritise TICKET-127 ahead of further features on this surface.
