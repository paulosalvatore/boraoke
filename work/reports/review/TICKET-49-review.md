# TICKET-49 Review — Moderation ON→OFF auto-rejects stranded pending

**Reviewer:** opus (D-022 merge-counting pass) · **Branch:** `ticket/49-moderation-off-orphans` vs `origin/main`
**Verdict:** APPROVE-WITH-FOLLOWUPS

## What I checked (evidence)

- Full diff read locally from worktree `.worktrees/ticket-49` (`git diff origin/main...HEAD`, excl. event log).
- Route: `app/api/host/moderation/route.ts:39-64`.
- Store: `lib/pending-store.ts` — both drivers (`MemoryPendingStore.rejectAllPending` :154-163, `UpstashPendingStore.rejectAllPending` :252-265).
- Tests run by me in-worktree:
  - Targeted: `pending-store.test.ts` + `api-moderation.test.ts` → 32 passed.
  - **Full jest suite → 530 passed / 37 suites** (no regressions).
- `pending-store` conformance runs `describe.each(drivers)` → covers BOTH memory and Upstash(-mock) drivers.

## Correctness findings

1. **Transition gating is exact (route.ts:48-51).** `before === true && raw === false`. `before` comes from `getRoomModeration` and `raw` is validated to `boolean` at :32, so both are strict booleans. OFF→ON, ON→ON, OFF→OFF all evaluate false → 0. Only ON→OFF fires. ✓
2. **404 / room-not-found rejects nothing.** The `if (applied === null) return 404` guard (:41-43) sits BEFORE the reject block (:48). Correct ordering — no reject on a non-existent room. ✓
3. **Never auto-approves.** `rejectAllPending` only mutates `status → "rejected"` in place; there is no path to `store.addEntry`/the queue. Confirmed both drivers. ✓
4. **`rejectAllPending` semantics correct in both drivers:** skips non-pending (idempotent), room-scoped, returns accurate flip count, never deletes. Matches the single `reject` op's contract. ✓
5. **Telemetry:** `rejectedPending` carries the true count on-path and a deliberate `0` off-path (uniform event shape). Tested via `toMatchObject`. ✓
6. **Security:** host-auth (`requireHost`) unchanged and still enforced before any mutation. No new input, no injection/DoS surface. ✓

## Tests prove the ACs

Transition matrix (ON→OFF rejects + telemetry count, zero-pending no-op, OFF→ON no-op, ON→ON no-op) all asserted, plus driver conformance (bulk flip + idempotent 2nd-call-0, already-rejected untouched, room-scoped, empty-room 0). Every AC is backed by a test, not just narration.

## Non-blocking follow-up (file, do not block merge)

- **F-1 (LOW) — Upstash `rejectAllPending` lost-update window.** It reads (`listRoom`) then does a per-item `set`, with no Lua/CAS. A concurrent `take` (approve) landing between the read and the `set` would be clobbered by the reject `set`, recreating an index-less orphan item (harmless — only indexed ids are listed, pruned later); a concurrent `add` after the read stays pending. This is the **same race class the existing single `reject` already carries**, and is acceptable in the toggle-OFF context (host is deliberately tearing down moderation; both racing actions are host-controlled and moderation is going away). The ticket itself sanctions the `listRoom` + per-entry approach. If the repo later moves `reject`/`take` to a Lua EVAL merge (as it does elsewhere), fold `rejectAllPending` into the same primitive.

## Merger note (before this hits live boraoke.com)

Pure backend store/route logic change, no UI surface (no App Tester visual gate applicable). Auto-reject is **destructive to pending state by design** — flipping ON→OFF now discards all outstanding pending submissions (as rejected, patrons see rejected then clear). This is the intended, spec'd behavior. Production runs the memory driver until Upstash is provisioned (documented gap, same as #6/#11); F-1 only applies once Upstash is live.

VERDICT: APPROVE-WITH-FOLLOWUPS
