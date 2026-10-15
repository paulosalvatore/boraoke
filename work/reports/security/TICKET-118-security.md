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
