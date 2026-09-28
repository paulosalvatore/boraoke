# TICKET-120 — The claim-token cap counts ISSUES on the login path, so staff logins silently evict the owner's device

**Filed:** 2026-09-28, from the TICKET-104 security re-gate (finding O-C).
**Priority:** MED-HIGH — it reaches the exact dead end TICKET-104 exists to remove, through an ordinary venue scenario.
**Type:** Bug
**Size:** S

## What

`MAX_CLAIM_TOKENS`' docblock says the cap counts **"devices, not issues"**. That is true on the roll path and **false on the login path**.

Measured in the re-gate: **5 logins from a single client consumed all 5 slots and evicted the creation token**; 30 logins left only the last 5 live.

## Why it matters — this is the ticket's own failure mode, reached by accident

Picture the venue: the owner creates the room on their phone. Over the evening, five staff members log in on the tablet or their own phones by typing the host code. **The owner's phone is silently evicted, back onto a host code they were shown once and do not have.**

That is precisely the dead end TICKET-104 was filed to remove, reached through entirely ordinary behaviour, with no attacker and no error — and silently, so the owner discovers it only when they next need admin.

It is **not a regression** — on `main` the creator always needed the code — which is why it is a follow-up rather than a blocker on PR #81. But it caps how much of the ticket's promise actually holds in a busy venue.

**This is the third instance of the same class on this work**: every mechanism that writes on the authentication path has found a way to recreate the lockout. Round 3's capped list evicted other devices; round 4's first rotation let a device lock itself out via its own successful re-entry; this one evicts the owner via other people's ordinary logins.

## What's needed

- Make the cap behave as documented — count **devices**, not issues — or change the eviction policy so that the **creator's original credential is never the one evicted**.
- Consider whether a login should mint a claim token at all. The login path already authenticates by the host code; minting a durable credential there is what makes staff logins consume the owner's slots.
- Fix the docblock either way. A comment that is true on one path and false on another is how this survived review.

## Constraints

- Read **`prove-your-test-can-fail`**: the regression test must show the owner's token surviving N logins from other clients, and must be shown to fail against today's behaviour.
- **Do not fix this by raising `MAX_CLAIM_TOKENS`.** That moves the threshold without changing the property, and a busy venue will pass any constant.
- Adjacent to TICKET-118 and TICKET-119 on the same auth surface; sequence them.
