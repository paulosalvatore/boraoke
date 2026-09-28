# TICKET-116 — `main`'s e2e suite is RED: the venue TV does not serve the room's language, and nothing was catching it

**Filed:** 2026-09-28, found while re-gating PR #84 against a freshly-merged `main`.
**Priority:** HIGH — not for the failing test itself, but because it proves regressions reach `main` unnoticed.
**Type:** Bug + gate gap
**Size:** M

## What

`e2e/served-lang.spec.ts:105` — *"the venue TV serves the ROOM's language, never the visitor's"* (TICKET-79) — **fails on `main`, deterministically.** Measured 3 runs out of 3 in a clean detached worktree at `main`, on two different ports, with every other test in that file passing. It is not a flake.

The assertion is that `/{room}/tv` served with `Accept-Language: es-ES,es;q=0.9` returns `lang="en"` — the **room's** language, never the visitor's.

## Why this is HIGH despite being one test

**The failing test is the smaller half of the finding. The larger half is that nobody knew.**

Boraoke has no gate that runs this suite:
- There is **no code-review bot** on this repo (the only actor on PRs is `vercel`, a deployment bot).
- `verify-green-local.sh` — the house's authoritative merge gate under D-051 — runs `md-doctor` and `shell-tests`, **neither of which exists in boraoke**.
- GitHub Actions is deliberately minimal and advisory-only (D-051) and does not run e2e.

So the e2e suite runs **only when an agent chooses to run it**, which means a regression lands on `main` and sits there silently until someone re-gates for an unrelated reason. That is exactly what happened: this was found only because a merge-sync pulled new code into PR #84 and the TM re-ran the suite rather than quoting the PR's earlier numbers.

**The product behaviour at stake is real, not cosmetic.** TICKET-79 exists because a venue TV showing the *visitor's* language rather than the room's is wrong — the TV is the venue's screen, shared by a room of people, and its language is a property of the venue, not of whoever last loaded it. If this is a genuine regression rather than a broken test, a venue in Brazil could be showing an English or Spanish interface.

## What's needed

1. **Establish which it is:** a real regression in served `<html lang>` for `/{room}/tv`, or a test that has drifted from correct behaviour. Do not assume the test is wrong because it is inconvenient — TICKET-79 shipped this deliberately and TICKET-75's client-side patch was removed in favour of it.
2. **Find when it broke**, by bisecting over the recent merges (103, 106, 109 all landed on 2026-09-27). Cheap, since the failure is deterministic.
3. **Fix the cause**, and if the test was right all along, check whether production is affected — this is a served-HTML property, so it is verifiable against `boraoke.com` directly.
4. **Close the gate gap**, which is the durable half. Options to weigh rather than assume: run the e2e suite in the GitHub Actions job despite its advisory status, add a boraoke-appropriate target to the local-Docker gate so `verify-green-local.sh` means something here, or make an e2e run a required step of the TM's own merge procedure. The current state — a suite that only runs when someone remembers — will produce this again.

## Constraints

- Read **`proof-by-absence`** before concluding anything is unaffected; "I could not reproduce it in production" is not "production is fine".
- Note the environmental hazards already documented for this repo: the in-memory store resets on route compile **and again on dev-server eviction every ~25s of idle**, and a second `PORT=` does **not** isolate a Next dev server because the `.next` cache is shared. Rule those out before blaming them — this failure reproduced on two ports with a clean `.next`.

## Acceptance

The test passes for the right reason (either the product is fixed, or the test is corrected with a written justification), the breaking change is identified, production impact is stated with evidence, and a gate exists that would have caught it.
