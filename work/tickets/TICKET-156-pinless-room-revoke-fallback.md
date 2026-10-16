---
ticket: TICKET-156
product: boraoke
status: backlog
---

# TICKET-156 — Rooms with no live owner pin cannot sign out other devices: add a host-code step-up

**Filed:** 2026-10-15, by a Dev agent on PR #96 (TICKET-118/112), from the Cyber Security re-gate recommendation (`work/reports/security/TICKET-118-security.md`, "Re-gate, 2026-10-15", section 4; PR comment 6204410600).
**Priority:** MEDIUM (R-1 is MEDIUM; the lever is missing exactly when a room is compromised).
**Type:** Security / feature (host auth surface)
**Size:** S
**Patron-facing:** yes, host-facing: it changes who can use "Sign out other devices" in the host panel.
**Decision pending:** Tech Lead, together with the S3 owner-only house default from TICKET-118 (still awaiting his confirmation). Do not start until both are decided.
**Depends on:** TICKET-127 should land first on this surface (see "Order").

## What

After TICKET-118, "Sign out other devices" works only from the device that holds the room's owner pin (S3). A room with no live pin has no way to end a copied session at all. That covers legacy rooms created before TICKET-120, and the two cases below, where the pin is lost exactly when the lever is needed.

- **R-1 — MEDIUM.** One stale whole-record write landing after the revoke's rebind costs the room its owner pin for good. It can come from an ordinary staff moderation toggle, or from the thief's own still-valid session spamming settings writes. Probe R1f: `setRoomModeration` reads before the bump and writes after the rebind; the list comes back with its pre-revoke tag, so it is dead, and the owner's next code login takes the `bound=false` branch of `issueRoomClaimToken`, which drops the pin. Output: `owner flag false owner re-claim 401 owner 2nd revoke 403 after code re-login pin (none)`. R1e shows the same with a stale logout write. The revoke itself still worked; what is lost is the lever and the owner's no-typing path.
- **R-2 — LOW.** If the owner's claim token is copied, the only way to kill the copy is to log out on the owner device. That also removes the pin, and with it the lever. Probe R4: after logout and a code login, `owner flag false`, revoke `403`, `thief session still valid true`, and the thief's session keeps rolling with no expiry.

## Options (Cyber ruling)

### (a) Host-code step-up for rooms with no live pin — RECOMMENDED

On `POST /api/host/revoke-sessions`, when the room has no live owner pin, accept the revoke if the request also carries the correct host code.

Why it is safe: the code is already a permanent master credential that any holder can use to log in at any time, so letting a holder also end other sessions grants nothing new. It keeps control symmetric between code holders (main's posture before #96), the per-room 3-per-10-minute revoke throttle still bounds it, a stolen session or a copied staff claim still cannot use the lever, it adds no write to the login path, and it recovers R-1, R-2 and legacy rooms.

Conditions (all required):

1. **"No live pin" includes a pin that is missing from the live claim list.** Judge it from the helper's pre-bump snapshot: `ownerClaimTokenHash` is absent, OR it is not in a live list. Without the second half, the R-1 rooms stay stuck.
2. **Wrong codes count against the per-IP login failure throttle, and that throttle is checked first.** Otherwise the route becomes an unthrottled guessing oracle for an 8-character code, which would be HIGH. Verify the code in constant time against `hostCodeHash`, in the same request.
3. **The step-up never auto-pins.** If it did, the first code holder to act (possibly an ex-staff member) would take the pin, the real owner would sit in a pinned room where they are not the owner, and the S3 asymmetry would be back in the attacker's favour. Re-pinning, if wanted, is a separate explicit owner action, decided separately. The kept hash in step-up mode is the caller's presented live token if there is one, otherwise the existing non-owner mint path.

### (b) Re-pin on a code login when no pin exists — REJECTED

- It puts a write on the login path, the surface every earlier lockout on this ticket line came from.
- It silently hands ownership to whoever types the code first: in a legacy room that is arbitrary staff, and after R-1 or R-2 it may be the attacker, who then holds the only lever. That is the asymmetric exclusive-control case S3 was meant to remove, and it is disqualifying on its own.

### (c) Leave it unavailable and document it — today's stopgap

This is what #96 ships. Every legacy, R-1 or R-2 room has no way to end a copied session, which is the threat TICKET-118 exists for. It is not worse than main (no lever at all), so it did not block #96, but it is not an end state.

## Order

TICKET-127 (atomic or field-level room writes) should land first on this surface. R-1 is a whole-record lost-update; the S3 owner-only design turned "a stale write costs a no-typing path" into "a stale write costs the room's recovery lever". Cyber's friction note: prioritise TICKET-127 ahead of further features here.

## Copy follow-up

#96 adds an owner-device warning to the logout confirm (`signOutOwnerWarning`, U1): signing out on the owner device loses the "sign out other devices" option even after a code login. If (a) ships, that sentence becomes wrong (a code holder can use the step-up) and must be rewritten in en, es and pt-BR in the same PR.

## Acceptance

- A pin-less room (absent pin, or pin not in a live list) can sign out other devices from a device that enters the correct host code; a pinned room's behaviour is unchanged.
- A wrong code is charged to the per-IP login failure throttle, and a throttled IP is refused before the code is checked.
- The step-up never sets `ownerClaimTokenHash`.
- No new read or write on the login, claim or session paths.
- Tests cover R-1 (pin dropped by a stale write) and R-2 (owner logout then code login) recovering via the step-up, each proven to fail without the change.
- Gates: Reviewer (D-022 opus) and Cyber Security (auth surface).
