# TICKET-96 — dev report

**Branch:** `ticket/96-advance-total-bucket`
**Implements:** option (c) from `work/plans/TICKET-47-FU-1-playability-signal.md` (TICKET-47 FU-1)

## What changed

`lib/advance-rate-limit.ts` gains a third per-room bucket, `total:<room>` at 40/60s, charged by
**every** advance regardless of the claimed `reason`. An advance must clear BOTH its specific
bucket (singer-skip 12/60s, or unplayable 40/60s) AND the total bucket.

The two pre-existing buckets share no state, so a caller alternating `?reason=unplayable` with a
reasonless advance could draw 12 + 40 = **52** advances/room/60s against an intended anti-grief
budget of 12. `reason` is client-supplied and the server cannot verify it, so this was a real
alternation bonus. The third bucket closes it **without ever needing to tell an honest skip from a
forged one** — the ceiling simply stops depending on the claimed reason.

`app/api/queue/advance/route.ts` is unchanged: the total bucket is charged inside
`advanceRateLimitOk`, so the single existing call site needed no new argument.

## Negative control — run by the Tech Manager, not self-reported

The proving slice the spike specified: a test alternating `{unplayable:true}`/`{unplayable:false}`
across one 60s window, asserting the observed successful total.

- **At base** (new tests applied, `lib/advance-rate-limit.ts` reverted): **2 failed, 10 passed**.
  The alternation test reported `Expected: 40, Received: 52` — the premise is CONFIRMED at exactly
  the predicted number, not assumed.
- **With the change:** 12/12 pass.

## One pre-existing test was deliberately changed — read this before approving

`"the two buckets are independent — exhausting one leaves the other free"` asserted that after
exhausting roomB's 40-cap unplayable bucket, a singer-skip advance still succeeded. Under the
total bucket it now correctly returns `false`, because 40 unplayable hits also fill the 40-cap
total bucket.

This is a **real behaviour change on a legitimate path**, not a test bent to fit the code, and it
is the honest cost of option (c): a room that genuinely burns 40 watchdog drains in one minute has
no singer-skip allowance left for the remainder of that window. Previously it kept 12. Judged
acceptable — 40 advances in a minute has already destroyed 40 queued songs, which is pathological
in itself — but it is a deliberate trade, so the test was renamed and its reasoning written into
the file rather than quietly edited.

## Gate (all figures observed directly by the Tech Manager)

- Jest: **52 suites, 895 passed**, 5 skipped (894 before + 1 new test).
- `advance-rate-limit.test.ts` alone: 12/12.
- rotation-engine `node --test`: **59 pass, 0 fail**.
- `npm run build`: Compiled successfully.
- Playwright: **105 passed, 1 failed** — the failure is `e2e/feedback.spec.ts:10` "submits in 2
  taps", the **known pre-existing flake filed as TICKET-94** (nothing warms `/api/feedback`, so its
  first compile lands inside a 5s assertion). It is not caused by this branch: the same suite was
  106/106 green on base `0343328` earlier today, and this branch touches only the advance rate
  limiter. This run had a deliberately cold `.next` (deleted to clear unrelated environment
  breakage), which is precisely the condition TICKET-94 predicts will trigger it. **Third
  independent sighting of that flake today** — it is not rare, and TICKET-94 should be scheduled.

## Not in scope

Options (a), (a'), (b), (d) from the spike. Moving these buckets cross-instance (the per-process
`Map` means the real ceiling is 40 x concurrent instances) remains a separate open follow-up — the
spike documents it and this change does not address it.
