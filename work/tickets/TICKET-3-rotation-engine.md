# TICKET-3 — Rotation / Fairness Queue Engine

- **Date:** 2026-07-05
- **Product:** cantai
- **Owner:** Dev (subagent)
- **Branch:** `ticket/3-rotation-engine`
- **Worktree:** `.worktrees/ticket-3`
- **Status:** IN PROGRESS

## Scope

Standalone, dependency-light TypeScript package under `packages/rotation-engine/` implementing cantai's venue-mode queue/rotation logic as pure, immutable functions. **NEW FILES ONLY** — must not touch the Next.js app (TICKET-1), the root `package.json`, or `.github/workflows/ci.yml`. TICKET-1's app consumes this package in a later integration ticket.

### 1. Entry model

`{ id, videoId, title?, uuid, nickname, table?, mode: 'sing' | 'listen' }` plus a `submittedAt` monotonic sequence assigned by the engine.

### 2. Venue modes

- `full-karaoke` — FIFO across everyone.
- `per-table-2` — max 2 queued sing-entries per table at a time; fair round-robin between tables.
- `per-person-1` — one queued sing-entry per uuid; fair round-robin between people by least-recently-sang.

### 3. Listen/dance entries

`listen` entries never consume a sing turn. They interleave in submission order but are starvation-capped: at most `maxConsecutiveListen` (default 1) listen entries play between two sing turns while singers are waiting. With no singers queued, all listens play FIFO.

### 4. Operations

`createQueue`, `addEntry`, `removeEntry`, `advance`, `skip`/no-show, `setVenueMode` (mode switch mid-session, no lost entries), `moveEntryToTable`, `peekUpcoming(n)`, `getEffectiveOrder`.

### 5. Edge cases (tested)

No-shows/skips (skipped singer keeps priority), user leaves, table changes, duplicate submissions, empty queue, mode switch with in-flight entries, over-cap grandfathering.

### 6. Deliverables

- `packages/rotation-engine/` package (own package.json, tsconfig, `node:test` suite — zero runtime deps).
- Exhaustive unit tests.
- `README.md` explaining the fairness rules in plain language (future user-facing docs).

## Notes

- CI wiring for this package lands at the integration ticket (TICKET-1 owns `.github/workflows/ci.yml`).
