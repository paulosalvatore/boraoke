---
ticket: TICKET-63
role: dev
product: boraoke
---

# TICKET-63 — Dev report

## Summary

Pinned the cjson string/boolean-only invariant (TICKET-56 FU-5) with a test
in `__tests__/pending-store.test.ts` — the only file touched (152 insertions,
0 deletions, confirmed via `git diff origin/main --stat`).

Full narrative, verification commands/output, and the red-probe evidence
(both the type-level and runtime probes, injected then reverted) are in
`work/tickets/TICKET-63-cjson-shape-invariant.md`.

## Verification

- `npx jest __tests__/pending-store.test.ts`: 35/35 pass.
- `npx tsc --noEmit`: no TS2322/TS2352 on the new pin lines; the ~1977
  baseline describe/it/expect errors are pre-existing across every test file
  in the repo (confirmed via `git stash` diff), not introduced here.
- Red-probe A (runtime): injected `durationSeconds = 217.3` into the actual
  entry object flowing through `rejectAllPending` — test went red with a
  message naming the Lua `cjson` / `%.14g` hazard and `lib/pending-store.ts`.
  Reverted.
- Red-probe B (type-level): added a scratch type extending `PendingEntry`
  with a numeric field — `npx tsc --noEmit` produced a new `TS2322` on that
  line. Reverted.

## Reviewer verdict

APPROVE-WITH-FOLLOWUPS (opus, clean context) — independently re-ran both
red-probes and confirmed clean scope. See `work/reports/review/TICKET-63-review.md`.

Follow-ups noted by Reviewer (non-blocking, left for the TM/backlog):
1. This work needed committing/PR'ing (this report closes that gap).
2. The type-level layer isn't CI-gated today (pre-existing: no `typecheck`
   script, ts-jest strips types via `isolatedModules`) — suggested follow-up
   ticket to add `@types/jest`, zero the baseline, and wire `npm run
   typecheck` into CI. Out of scope for TICKET-63.
