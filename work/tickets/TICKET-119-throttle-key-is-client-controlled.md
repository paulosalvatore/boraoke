# TICKET-119 — The claim/login throttle key is client-controlled, so the host-code brute-force control is resettable

**Filed:** 2026-09-28, from the TICKET-104 security re-gate (finding O-B, MEDIUM). **Pre-existing on `main`** — reachable through the login route alone, so PR #81 neither introduces nor worsens it.
**Priority:** MED
**Type:** Security
**Size:** S

## What

A code comment and the round-3 report state that finding O1 was fixed because the throttle key is now "server-derived". **It is not.** `clientIpFrom` reads `x-real-ip` / `x-forwarded-for` **off the request**, both of which a client can set.

Measured in the re-gate: 14 failed claims with a rotating `x-forwarded-for` never triggered a 429, and **1200 rotating-key claims reset the host-code brute-force control from 429 back to 401**.

The reason this is not a blocker for PR #81 is that the identical reset is reachable through the **pre-existing login route alone**, at the same cost (15.2s vs 14.3s measured). It is a `main` defect the PR neither introduces nor worsens.

## Why it matters

The per-IP throttle is the only brute-force bound on the host code, which is the human-facing credential a venue actually types. If the key is attacker-chosen, the bound is decorative.

**Note the unverified caveat**, which changes the severity and should be established before designing a fix: **Vercel's edge may overwrite these headers in production.** If it does, the bound holds in production and this is a local/dev-only weakness. If it does not, the brute-force control is effectively absent on a live venue. **Establish which, with evidence, before doing anything else** — the fix differs, and so does the urgency.

## What's needed

1. **Determine whether the production edge overwrites `x-real-ip` / `x-forwarded-for`.** This is the deciding fact and it is cheap to establish.
2. If the headers are trustworthy in production, **document that the bound holds there** and fix the comment and the report rather than the code.
3. If they are not, derive the throttle key from something the client cannot choose, and treat the host-code brute-force bound as the property being protected.
4. **Correct the "server-derived" claim wherever it appears** — in the code comment and in the round-3 report — regardless of the outcome. A false statement about a security control in a comment is worse than no statement, because it stops the next reader checking.

## Constraints

- Read **`prove-your-test-can-fail`**: a test asserting "the throttle fires" must be shown to fail when the key is attacker-rotatable, otherwise it proves only that the throttle exists.
- Adjacent to TICKET-118 and TICKET-120 on the same auth surface; sequence them rather than running them in parallel.
