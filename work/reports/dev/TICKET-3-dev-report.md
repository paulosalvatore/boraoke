# TICKET-3 — Dev Report

- **Status:** REVIEW FIXES APPLIED — draft PR #3 (https://github.com/paulosalvatore/cantai/pull/3). D-022 opus REQUEST-CHANGES (F1/F2/F3) addressed; self-verify green (**47/47 tests**, typecheck clean). Implementation commit: db36ea5; review fixes in the follow-up commit carrying this report.
- **Branch:** `ticket/3-rotation-engine`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-3`
- **Package path:** `packages/rotation-engine/`
- **App port:** N/A — standalone library, no server.

## Exploration

Greenfield standalone package; nothing pre-existed under `packages/`. Confirmed
TICKET-1 (parallel worktree `.worktrees/ticket-1`) owns the root `package.json`,
`app/`, `lib/`, `__tests__/`, `e2e/`, and `.github/workflows/ci.yml`. This ticket
stays entirely under `packages/rotation-engine/` (NEW FILES ONLY) — no collision.
The entry model + venue modes were fully specified in the ticket, so no further
codebase exploration was required.

## Design decisions (recorded — fully-autonomous POC, no questions asked)

1. **Derived play order, not stored positions.** `getEffectiveOrder(state)` is a
   pure function of state. Mode switches / table moves just recompute, so no
   entry is ever lost or stranded in a stale position.
2. **Immutable API.** Every op returns a new `QueueState`; inputs never mutated
   (asserted in tests). State is a plain serializable object.
3. **Caps enforced at `addEntry`, returned not thrown.** `per-table-2` rejects a
   3rd queued sing/table (`table-cap`); `per-person-1` rejects a 2nd queued
   sing/uuid (`person-cap`); duplicate uuid+videoId rejected (`duplicate`).
   Listen entries are never cap-blocked.
4. **Round-robin fairness** for the two fair modes: buckets (table or uuid)
   seeded with real least-recently-sang recency from history; a virtual clock
   rotates a just-served bucket to the back; ties break by head `submittedAt`.
5. **Listen starvation cap.** Listen entries interleave by submission order but
   at most `maxConsecutiveListen` (default 1) may play consecutively while a
   singer waits; with no singers queued, all listens flush FIFO.
6. **Tableless entries in per-table-2** bucket as `no-table:<uuid>` (own fair
   bucket + own 2-cap).
7. **Skip = no penalty.** A skipped singer's recency is NOT bumped, so re-joining
   keeps their standing. `advance` records `played` + bumps recency; `skip`
   records `skipped` + leaves recency untouched.
8. **Mode switch grandfathers over-cap in-flight entries**; new caps apply only
   to new submissions.

## Files (all new)

- `packages/rotation-engine/package.json` — zero runtime deps; `type: module`; main/types → `src/index.ts`.
- `packages/rotation-engine/tsconfig.json` — strict, NodeNext, `allowImportingTsExtensions`, `noEmit`.
- `packages/rotation-engine/src/types.ts` — domain types.
- `packages/rotation-engine/src/engine.ts` — the engine (all logic).
- `packages/rotation-engine/src/index.ts` — public exports.
- `packages/rotation-engine/test/engine.test.ts` — 40 `node:test` cases.
- `packages/rotation-engine/README.md` — plain-language fairness rules (future user-facing docs).

## Self-verification (real output)

```
$ node --test          # after opus-review fixes
ℹ tests 47
ℹ pass 47
ℹ fail 0
```

```
$ npx tsc --noEmit
TYPECHECK_CLEAN   (no errors)
```

Node 25.8.2, TS 5.8. Tests run via Node native TS type-stripping (`node --test`),
zero runtime dependencies.

## Test coverage summary

createQueue defaults/overrides; addEntry seq + immutability + duplicate rules;
full-karaoke FIFO; per-table-2 cap + round-robin + tableless bucket + recency;
per-person-1 cap + least-recently-sang + never-sang precedence; listen cap /
FIFO-flush / never-rejected / no-recency-effect / higher-cap; advance
empty/normal/immutable; skip head/specific/none + keeps-priority; removeEntry
remove/idempotent/frees-cap; moveEntryToTable rebucket/over-cap-grandfather/absent;
setVenueMode no-loss/grandfather/re-order; peekUpcoming n/edge; 2 integration
scenarios (multi-round fairness, mode switch with in-flight entries).

## Deviations / notes

- **CI not wired here** — TICKET-1 owns `.github/workflows/ci.yml`; package CI
  lands at the integration ticket. Called out in the PR.
- **No `run-app`** — library, not an app; nothing to boot.
- Package ships TypeScript source (with `.ts` import extensions) consumed via the
  app's transpiler at integration; no separate build artifact for the POC.

## Opus review fixes (D-022 second pass — REQUEST-CHANGES, resolved)

Review record: `work/reports/review/TICKET-3-review.md` (second pass) + PR comment https://github.com/paulosalvatore/cantai/pull/3#issuecomment-4887744709. Suite went 40 → 47 tests, all green.

- **F1 (BLOCKING) — listen cap defeated across advances (peek ≠ play).** Root cause: `mergeListens` re-initialized its consecutive-listen counter to 0 on every `getEffectiveOrder` call; nothing persisted the run between `advance` calls. Fix: added `consecutiveListen: number` to `QueueState` (init 0). `consume` increments it when a `listen` plays and resets it to 0 when a `sing` plays; `skip` leaves it untouched (nothing played). `getEffectiveOrder` seeds `mergeListens` from the persisted value, so batch order and head-by-head playback agree. Tests added: the reviewer's exact failing case (multi-advance loop, cap=1, singer index ≤ 1 AND full played order equals the batch promise l1,s1,l2,l3), a full-drain peek(1)==advance consistency loop, and a counter-lifecycle test (increments on listen, resets on sing).
- **F2 (MED) — `Infinity` cap broke JSON round-trip** (stringify → `null` → coerced to cap-0, the opposite behavior). Fix: serialization contract changed — `maxConsecutiveListen: number | null`, with **`null` = no cap** as the canonical representation; `createQueue` accepts `Infinity` and normalizes it to `null`; `mergeListens` treats `null` as uncapped. Tests added: Infinity→null normalization + full-state JSON round-trip asserting deep-equal state and identical batch AND iterative playback; `null` accepted directly; default-cap state (with a non-zero persisted counter) round-trips deep-equal.
- **F3 (NIT) — cross-mode duplicate coupling.** Fix (cheap): duplicate key is now `uuid + videoId + mode` — a `listen` for X no longer blocks a `sing` for X (and vice-versa); same-mode duplicates still rejected. Test added; README documents the rule.

README updated accordingly (null/Infinity no-cap semantics, persisted-counter "what the screen shows is what airs" guarantee, per-mode duplicate rule).

Design note: `consecutiveListen` increments on a listen play even when no singer was waiting at that moment; if a singer then joins mid-run, the cap check treats the run as already at/over cap and favors the singer. Deliberately singer-favoring in a rare edge — simplest semantics that keep peek==play.

## Spec delta vs TICKET-5 (`work/planning/rotation-modes-fair-queue.md`, branch ticket/5-roadmap)

The PO spec landed in parallel and **conflicts with this ticket's contract** in substance, not just terminology. Per coordinator instruction the lib was NOT rewritten; deltas recorded here and in the PR body for an alignment follow-up ticket:

| Topic | This lib (per TICKET-3 contract) | TICKET-5 spec |
| --- | --- | --- |
| full-karaoke | strict FIFO | round-robin by uuid (anti-hog) |
| per-table caps | max 2 **queued** sing/table; tableless = own per-uuid bucket | 2 per **round**, cap 4 queued; tableless excluded until a table is assigned |
| per-person caps | max 1 queued sing/uuid | max 2 queued (current + next round) |
| listen entries | interleave with `maxConsecutiveListen` cap (default 1) | play only when sing queue is empty (interleave toggle = out-of-scope nice-to-have) |
| no-show | skip removes entry, no recency penalty (keeps standing) | one grace re-queue at front of group's next round; 2nd consecutive no-show charged credit |
| duplicates | same uuid+videoId rejected while queued | allowed, UI warns |
| field names | `mode: 'sing'\|'listen'`, `table` | `kind`, `tableNumber`, plus `status` lifecycle |
| listen spam cap | none | max 3 pending listen/uuid |

Compatibility: the architecture matches the spec's "Ordering algorithm" contract exactly — pure deterministic order function, immutable state, mode switch = recompute with no lost entries, listen never consumes a fairness turn, absent-skip not charged. The deltas are policy parameterization: the spec's per-round quota round-robin generalizes this lib's bucket round-robin; caps are constants; a `maxConsecutiveListen: 0` variant reproduces the spec's sings-first-then-flush-listens policy verbatim; field renames are mechanical. Recommend a small follow-up alignment ticket once TICKET-5 merges.

## Friction

None.
