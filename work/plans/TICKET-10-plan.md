# TICKET-10 — Rotation modes UI — Plan

- Product: cantai · Branch: `ticket/10-rotation-modes` · Worktree: `.worktrees/ticket-10` · App port: 3010
- APPROVED-BY: auto-approved (no plan-gate escalation — TM dispatched the full authoritative ticket + integration constraints) — validated downstream by gates + TL merge of PR #14.

## Approach

Integrate the merged `@cantai/rotation-engine` into the app without touching the frozen `QueueStore`. Ordering is composed on top of the store via a new adapter `lib/rotation.ts`, and the store's physical order is kept in effective order by **re-laying** on the two mutations that change ordering (submit, mode-switch). Reads then render effective order unchanged; `advance`/`skip` play the effective head.

### Integration model (why re-lay, not compute-on-read)
- Store holds only pending entries (no fairness history). `getQueue()[0]` = now-playing (pinned; TV plays it).
- On submit / mode-switch: recompute effective order over `getQueue().slice(1)` (index 0 pinned as now-playing, its group seeded as "served this round" per the spec's `nowPlaying` quota-consumption rule), then `reorder` the store to match. This preserves AC1's progression (A1,B1,A2,A3) and keeps now-playing from being swapped mid-song.
- `advance` removes the head; the precomputed tail remains a valid fair continuation — no re-lay needed until the next submit.
- **Known v1 limitation (documented):** fairness memory is one turn deep (only the current now-playing group is seeded). A new submission mid-night recomputes statelessly over the pending set. No AC requires deeper memory; the frozen store has nowhere to persist full history and the ticket accepts "full-queue read-per-advance at bar scale". Follow-up: persist per-session credit.

## A1–A6 reconciliation (engine, policy per merged spec)
- A1 full-karaoke FIFO → **round-robin by uuid** (`computeSingOrder` routes all modes through `roundRobin`; full-karaoke & per-person-1 key by uuid, per-table-2 by table). AC1.
- A2 caps 2/table,1/person → **4/table, 2/person** (`capViolation` thresholds).
- A3 listen: keep engine knob (`maxConsecutiveListen`, default 1); **app configures `0`** = spec policy (listen only when no sing pending). Capability retained for the future venue toggle.
- A4 no-show grace: add `graceRequeue?` to entry; `order()` picks grace entries first within a group and sorts a grace-holding group first among equal credit; `skip()` returns `graceGranted`, tracks `noShowStreakByUuid`, charges credit (bumps recency) on the 2nd consecutive no-show, resets streak when the uuid sings.
- A5 duplicates: engine already rejects only exact same uuid+videoId+mode; different-uuid same-song allowed. App adds a **song-level dupe warning** at submit UI.
- A6 naming: **canonical boundary = the adapter `lib/rotation.ts`.** Each codebase keeps its own names; `RoomMode` reuses the engine's `VenueMode` strings verbatim (zero mapping for venue mode). App `Mode "listen-dance"` ↔ engine `EntryMode "listen"`, `patronUuid` ↔ `uuid`, mapped only in the adapter.

## Files
- Engine: `packages/rotation-engine/src/{types,engine}.ts`, `test/engine.test.ts`, `README.md`.
- App: `lib/rotation-modes.ts` (new, client-safe: RoomMode, MODE_META, copy), `lib/rotation.ts` (new, server adapter), `lib/rooms.ts` (additive: RoomMode, `setRoomSettings`, `getRoomMode`), `app/api/queue/route.ts` (cap/table enforcement + graceRequeue + re-lay + mode in GET), `app/api/host/mode/route.ts` (new), `app/api/host/skip/route.ts` (grace flag), `components/host/ModeSwitcher.tsx` (new), `app/(patron)/[room]/admin/AdminRoom.tsx` (wire switcher + reorder toast), patron/TV (reorder toast + TV 30s call).
- Tests: `__tests__/rotation-adapter.test.ts`, `__tests__/api-mode.test.ts`, `e2e/rotation-modes.spec.ts`.
- Must NOT touch: `lib/store*`, `lib/youtube-search.ts`, `app/api/search/**`, `components/FeedbackWidget*`, `lib/telemetry*`.

## Test strategy
Engine unit (node --test) extended for A1–A5 + grace; app adapter unit (jest) for mode-switch reorder / per-table cap / listen interleave; API test for mode route; e2e host-switches-mode-→-queue-reorders. CI green mandatory before gates.
</content>
</invoke>
