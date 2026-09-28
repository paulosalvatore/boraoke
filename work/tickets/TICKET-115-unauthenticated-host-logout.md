# TICKET-115 — `POST /api/host/session` (host logout) is unauthenticated, so any page can log a venue host out

**Filed:** 2026-09-27, found by the TICKET-104 security gate. **Pre-existing on `main` and therefore LIVE**, unlike the two blockers that gate raised against PR #81.
**Priority:** MED — live, remotely triggerable, but recoverable; not an emergency.
**Type:** Security (CSRF)
**Size:** S

## What

`POST /api/host/session?room=<id>` clears the room's host session cookie and **checks nothing**: no session, no origin, no CSRF token. It reads the room id from the request and clears the cookie.

So any third-party page a venue host visits, in the browser they run the admin screen in, can log them out. Verified genuinely cross-site in a real browser by the TICKET-104 security gate (auto-submitting form, no click required). **`SameSite=lax` does not protect it** — the attack does not need a cookie *sent*, it needs a response that *clears* one. Room ids are public venue-name slugs, so the target does not have to be guessed blindly.

## Severity, stated honestly

**On `main` today this is a nuisance, not a lockout.** The host re-enters their code and they are back in. That is why this is MED and not HIGH, and why it is a normal ticket rather than an incident.

It matters anyway for two reasons:
1. **It is remotely triggerable by a page the host merely visits**, during a live venue night, on the screen running the room. A host who gets bounced mid-evening and has to find the code is a real operational failure even though it is recoverable.
2. **It is one change away from being severe.** PR #81 (TICKET-104) has this same endpoint plant a long-lived no-claim marker, which converts this nuisance into a **permanent, remote, unauthenticated lockout** — the exact dead end TICKET-104 exists to remove. That blocker is being fixed in the PR, but the underlying unauthenticated endpoint is the shared root cause and is live now.

## What's needed

Require proof that the caller is the session holder before clearing it. The obvious shape: the request must present the valid host session cookie it is asking to clear (the endpoint's own semantics make that natural — you cannot log out of a session you do not have), plus a same-origin/CSRF check. Reject otherwise, and return the same response either way so the endpoint does not become a room-existence oracle.

## Constraints

- **Coordinate with PR #81**, which touches this endpoint. Whoever lands second reconciles; do not fix it twice in conflicting ways.
- Logging out must stay reliable for the legitimate host — a fix that makes logout flaky is worse than the bug, since the shared-venue-tablet case depends on logout working.
- Read **`prove-your-test-can-fail`**: the regression test is a genuine cross-site POST (not a same-origin fetch, which would pass against the vulnerable code and prove nothing). The security gate's report has the working repro to model it on.

## Acceptance

A cross-site POST cannot clear a host session; the legitimate same-origin logout still works; both are covered by a test shown capable of failing against the current code.
