# TICKET-93 — a Redis outage during the moderation ON→OFF drain strands patrons forever

**Filed:** 2026-09-01 (Product TM tab, from the two open TICKET-56 follow-ups filed by the PR #40 reviewer)
**Priority:** MED
**Size:** S
**Type:** Backend correctness / failure-path hardening
**Closes:** TICKET-56 FU-1b, TICKET-56 FU-7

## Why this exists

`POST /api/host/moderation` commits the flag first (`setRoomModeration`) and only then drains the
stranded pending entries (`pendingStore.rejectAllPending`). The drain's `EVAL` is wrapped in a
`try`/`catch` that degrades to a non-atomic fallback loop — but **the fallback itself is not
wrapped**. It issues its own Redis commands, so a genuine outage (as opposed to an EVAL-specific
blip) throws out of `rejectAllPending`, propagates, and 500s the route **after the toggle has
already committed**.

That is FU-1b as the reviewer filed it. What makes it worse than "the host sees a spurious error"
is what happens next, which the follow-up did not spell out:

1. The host sees a failure for a change that actually applied — moderation really is off now.
2. They retry, which is the obvious response. But the retry is an **OFF → OFF** write, and the
   drain was keyed on the **ON → OFF edge**, so it rejects nothing.
3. There is no second ON → OFF edge to catch, ever. The pending entries stay pending, and every
   affected patron sits on "aguardando aprovação" **forever**, with the host's approve/reject UI
   already gone.

That is precisely the TICKET-49 bug this call exists to prevent, reintroduced through the error
path. So "wrap it and swallow" is not sufficient on its own: swallowing alone converts a loud
failure into a silent permanent strand.

## What was decided

Both halves, because either alone is wrong:

- **`rejectAllPending` never throws.** The fallback is wrapped; a total failure logs loudly and
  reports `0` flipped. `0` is an honest count, not a swallowed success — the entries really are
  untouched.
- **The drain keys on the target state, not the edge.** Any write of `moderation: false` drains,
  so the host's natural retry — and any later OFF write — self-heals the strays. With moderation
  already off there should be no pending entries at all, so the normal case is an idempotent
  no-op costing one room-scoped call.

The store's public interface is unchanged (`Promise<number>`), and the memory driver is untouched.

## FU-7, fixed at the class level

`warn.mockRestore()` sits as the last statement of a test body with no `restoreMocks` in
`jest.config.ts`, so an assertion throwing above it leaks the spy for the rest of the module —
silencing `console.warn` on a run that is *already red*, which is exactly when those warnings are
worth reading. Rather than move one call into a `finally`, `restoreMocks: true` is set globally:
it closes the leak for all six existing spy sites and every future one, instead of depending on
each author remembering the pattern.

## Acceptance

- A full-outage test (every command throws, not just `EVAL`) asserts `rejectAllPending` **resolves**
  to `0`, warns twice, and leaves the entries genuinely pending.
- A route-level test reproduces the post-outage state (flag off, entry still pending) and asserts
  the next OFF write drains it, releases the patron, and reports the count in telemetry.
- A route-level test asserts the ordinary OFF → OFF write with nothing stranded stays a clean no-op.
- Negative control at base: both new behavioural tests go red.
- Full unit suite, rotation-engine suite, build, and full Playwright e2e green.

## Not in scope

The `setRoomModeration`-then-drain ordering itself. Making the two writes one atomic unit would be
a larger change to the room store, and the self-healing drain removes the durable harm without it.
