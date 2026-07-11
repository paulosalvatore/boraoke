# TICKET-49 — Moderation toggle-OFF strands pending entries (auto-reject on OFF)

**Type:** bug fix (correctness) · **Severity:** MED · **Source:** PR #25 (TICKET-44) opus review follow-up
**Product:** boraoke · **Autonomy:** deliver-not-merge (any merge to `main` = boraoke.com prod deploy)

## Problem

TICKET-44 shipped venue-optional song moderation. When moderation is **ON**, patron
submissions divert to the pending keyspace (`room:<id>:pending:*`, `lib/pending-store.ts`)
and only enter the queue on host approval. The host approve/reject UI and the patron's
"aguardando aprovação" (pending) state are both gated on moderation being ON.

**The bug:** flipping moderation **OFF** (`POST /api/host/moderation` with
`{ moderation: false }`, `app/api/host/moderation/route.ts` → `setRoomModeration(roomId, false)`)
does NOT touch the outstanding pending entries. As a result:

1. **Patron is stranded forever.** A patron who submitted while moderation was ON keeps
   polling `/api/queue/pending` (`app/api/queue/pending/route.ts`) and sees
   "aguardando aprovação" **indefinitely** — the entry is never approved, never rejected,
   and their song never enters the queue.
2. **Host loses the ability to clear them.** With moderation OFF, the host's pending
   approve/reject section disappears from the admin UI, so there is no path to resolve
   the orphaned pending entries.

## Fix (preferred approach, per PR #25 opus follow-up)

**Auto-reject all outstanding pending entries when moderation transitions ON → OFF.**

In `app/api/host/moderation/route.ts`, when the toggle is applied and the room is moving
from moderation ON to OFF (`before === true && raw === false`), reject every still-pending
entry in that room. Flipping them to `rejected` (not deleting) means the patron's next
`/api/queue/pending` poll surfaces the "rejected" state briefly and then clears, exactly
like a host reject — no patron is left hanging, and the existing rejected-entry TTL/prune
path handles cleanup. Do NOT auto-approve (that would bypass the host's intent and dump
unreviewed songs into the live queue).

### Implementation notes

- Add a bulk operation to the `PendingStore` interface + both drivers (memory + Upstash)
  in `lib/pending-store.ts`: e.g. `rejectAllPending(roomId): Promise<number>` returning the
  count rejected. Prefer a single bulk op over N individual `reject()` round-trips
  (Upstash command economy — the store already mirrors #6's driver pattern). If a clean
  bulk primitive is awkward on the Upstash driver, `listRoom` (pending-only) + per-entry
  `reject` is acceptable, but keep it to one pass.
- Only reject entries currently in `pending` status (leave already-`rejected` ones alone —
  idempotent).
- Emit telemetry so the auto-reject is observable: extend the existing
  `host_action` / `moderation_change` track call with a `rejectedPending: <count>` prop
  (a new prop VALUE on the existing event — do NOT invent a new event type; mirror the
  TICKET-44 telemetry convention already in this route).
- Guard for the race where `setRoomModeration` returns `null` (room not found) — only
  reject after a successful apply.
- The reverse transition (OFF → ON) needs no change. A no-op toggle (OFF → OFF or
  ON → ON) must not reject anything — gate strictly on the `before === true && raw === false`
  transition.

## Acceptance criteria

- [ ] Toggling moderation OFF while ≥1 pending entry exists rejects ALL of them; a
      subsequent `/api/queue/pending` poll for those patrons returns `rejected`, then clears.
- [ ] Toggling OFF with zero pending entries is a clean no-op (no errors, count 0).
- [ ] OFF → OFF and ON → ON toggles reject nothing.
- [ ] Already-rejected entries are untouched (idempotent); no entry is auto-*approved*.
- [ ] `host_action`/`moderation_change` telemetry carries the rejected count.
- [ ] Unit tests: bulk reject in `lib/pending-store.ts` (both drivers), and the route-level
      transition matrix (ON→OFF rejects, OFF→OFF/ON→ON no-op, room-not-found guard).
- [ ] Full local suite green (build + typecheck + lint + `npm test` + cold e2e).

## Out of scope

- The pending-store TTL + MGET batch poll-cost optimization (separate MED follow-up).
- Response over-echo trims (separate LOW follow-up).
- Any change to the ON-path submission flow or the approval flow.
