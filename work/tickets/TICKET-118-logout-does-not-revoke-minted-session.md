# TICKET-118 — Logout revokes the claim credential but NOT a host session already minted from it, and there is no rotation lever

**Filed:** 2026-09-28, from the TICKET-104 security re-gate (finding O-A, HIGH). **Pre-existing on `main`** — PR #81 neither introduces nor worsens it.
**Priority:** HIGH — it is the difference between "a venue can recover from a compromise" and "it cannot".
**Type:** Security
**Size:** M

## What

Measured in the re-gate, in real browsers: after the owner logs out, an attacker's **claim** correctly 401s — but a host **session already minted** from the stolen credential keeps working. It continues to moderate (200) and **rolls itself a fresh 30-day cookie**, indefinitely.

Re-entering the host code does not help. `sessionValue` is a **deterministic HMAC over `hostCodeHash`**, so two separate logins return the **byte-identical session value**, and there is **no rotation lever anywhere** in the design.

## Why it matters

The venue's intuitive recovery actions — log out, log back in, re-enter the code — **do nothing** to an attacker who already holds a session. There is no sequence of actions available to a venue owner that ends an unauthorised session.

**Do not let this be described as solved by TICKET-104.** That ticket gives the creator a way back in without the code; it does not give a compromised venue a way to push anyone else out. Those are different properties and the second one does not currently exist. The re-gate was explicit that nobody should describe this feature as providing a recovery path.

It is **not a blocker for PR #81** because `main`'s logout revoked nothing for another device either — the PR is strictly an improvement. But the improvement stops short of recovery, and that gap should be visible rather than implied.

## What's needed

A way to invalidate outstanding host sessions. The core problem is that the session value is a pure function of the room secret, so it cannot be rotated without changing the secret. Options to weigh (do not assume one):

- **A rotatable server-side component** mixed into the session derivation (a per-room session epoch/salt stored with the room), so bumping it invalidates every outstanding session at once. Probably the smallest change with the right shape.
- **Server-side session records** rather than a derived value, which allows per-session revocation but is a larger change and adds state to a currently stateless path.
- **Re-deriving from a rotated host code**, which conflates two concerns (the code is also the human-facing credential) and forces the venue to redistribute it.

Whatever is chosen, the venue-facing action must be obvious and safe to perform mid-service — a "sign out all devices" affordance on the admin screen, not a documented procedure.

## Constraints

- Read **`prove-your-test-can-fail`**: the regression test must mint a session, revoke, and prove the *old* session stops working. A test that only checks the new session works would pass against today's broken behaviour.
- Note the ticket's signature risk, hit twice on PR #81: **every mechanism that writes on the authentication path has so far recreated a lockout**. A revocation epoch is a write on that path — design it so a concurrent write cannot lock out the legitimate owner.
- Coordinate with TICKET-119 and TICKET-120, which touch adjacent parts of the same auth surface.
