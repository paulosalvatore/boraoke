# TICKET-3 — Plan

- **APPROVED-BY:** auto-approved (no plan-gate escalation; fully-autonomous POC run) — validated downstream by gates + TL merge of PR #3.

## Approach

Model the queue as an **immutable `QueueState`**. The play order is a **pure derived function** of state (`getEffectiveOrder`), not a stored/mutated position list — this makes mode switches trivially non-destructive (recompute, never drop entries).

### Ordering pipeline

1. **Sing order** — mode-dependent fair ordering of `sing` entries only:
   - `full-karaoke`: FIFO by `submittedAt`.
   - `per-table-2` / `per-person-1`: generic **round-robin** over buckets (table, or uuid). Each bucket seeded by its real least-recently-sang position from history; a virtual clock advances as entries are emitted so a served bucket rotates to the back. Tie-break by head entry `submittedAt`.
2. **Listen merge** — interleave `listen` entries (FIFO by `submittedAt`) into the sing order with a `maxConsecutiveListen` starvation cap (default 1) so singers are never starved.

### Caps

- Enforced at `addEntry` (reject with a reason, never throw): `per-table-2` rejects a 3rd queued sing entry for a table; `per-person-1` rejects a 2nd queued sing entry for a uuid. Duplicate (same uuid+videoId already queued) rejected.
- Mode switch **grandfathers** existing over-cap entries (no lost entries); caps apply to new submissions only.
- Tableless entries in `per-table-2` bucket as `no-table:<uuid>`.

### Files (all new, under `packages/rotation-engine/`)

- `package.json`, `tsconfig.json`
- `src/types.ts`, `src/engine.ts`, `src/index.ts`
- `test/engine.test.ts` (`node:test`)
- `README.md`

## Test strategy

`node --test` (Node native TS type-stripping, zero runtime deps). Exhaustive per-mode + per-edge-case coverage. Also `tsc --noEmit` typecheck.

## Risks

- Node-version dependence for TS test execution → mitigated by also shipping a `tsc` build; document the Node requirement.
- Fairness semantics are judgment calls → documented explicitly in README + asserted in tests.
