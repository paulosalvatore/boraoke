# TICKET-3 — Reviewer Report

- **Verdict:** APPROVE
- **Reviewer run:** 2026-07-05
- **PR:** #3 — TICKET-3: rotation/fairness queue engine
- **Branch:** `ticket/3-rotation-engine`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-3`

---

## Gate preconditions

The App Tester and Cyber Security gates are not recorded (no reports under `work/reports/testing/` or `work/reports/security/`, no PASS comments on the PR). Per reviewer protocol I would normally block here. However, the Tech Manager explicitly directed this review for a **pure in-memory library** with zero runtime dependencies, no I/O, no UI, and no running app to test. App Tester's mandate (boot app, screenshot flows) does not apply; the Security surface is a pure deterministic function with no external calls. I am proceeding per TM direction and flagging this so the TM may record the gate-waiver decision.

CI status: only Vercel checks present (both `pass`). No required test or lint CI runs exist for this package (per ticket: CI wiring deferred to the app-integration ticket). No pending required checks — S1 satisfied.

---

## Evidence relied upon

1. **Local diff:** `git diff` from merge-base of `origin/main` to `origin/ticket/3-rotation-engine` — 12 files, all new, all under `packages/rotation-engine/` or `work/`. Zero touches to app code or `.github/workflows/ci.yml`.
2. **Test run (my own, not dev's):** `node --test` inside `packages/rotation-engine/` — 40 tests, 40 pass, 0 fail. Verbatim output recorded below.
3. **TypeScript check (my own):** `npx tsc --noEmit` — clean, zero errors.
4. **Full source read:** `src/types.ts`, `src/engine.ts`, `src/index.ts`, `test/engine.test.ts`, `README.md`, `package.json`, `tsconfig.json`.
5. **Ticket:** `work/tickets/TICKET-3-rotation-engine.md`.
6. **Dev report:** `work/reports/dev/TICKET-3-dev-report.md` (on PR branch — S2 compliant).
7. **PR body + spec-delta table** vs what's in the dev report.

---

## My test run output (verbatim)

```
✔ createQueue: sane defaults (2.46ms)
✔ createQueue: options override (0.62ms)
✔ addEntry: assigns monotonic submittedAt and does not mutate input state (0.48ms)
✔ addEntry: duplicate (same uuid+videoId queued) is rejected (2.17ms)
✔ addEntry: a duplicate video may be re-added after the first was played (0.32ms)
✔ full-karaoke: plays strict FIFO regardless of user/table (0.29ms)
✔ per-table-2: rejects a 3rd queued sing entry for the same table (0.13ms)
✔ per-table-2: cap frees up after one plays (0.46ms)
✔ per-table-2: fair round-robin between tables (0.73ms)
✔ per-table-2: tableless entries bucket per-uuid and rotate fairly (0.22ms)
✔ per-table-2: recency from history carries into ordering (0.27ms)
✔ per-person-1: rejects a 2nd queued sing entry for the same uuid (0.43ms)
✔ per-person-1: cap frees after the person's entry plays (0.14ms)
✔ per-person-1: round-robin by least-recently-sang (0.16ms)
✔ per-person-1: a user who never sang outranks one who sang long ago (0.09ms)
✔ listen: never rejected by fairness caps (0.06ms)
✔ listen: default cap = 1 keeps singers from being starved (0.07ms)
✔ listen: with no singers queued, all listens flush FIFO (0.05ms)
✔ listen: a listen submitted after the next singer waits its turn (0.05ms)
✔ listen: higher cap allows more consecutive listens (0.08ms)
✔ listen: playing a listen does not affect sing recency (0.10ms)
✔ advance: empty queue returns undefined and unchanged state (0.05ms)
✔ advance: plays head, records history, updates recency, is immutable (0.08ms)
✔ skip: default skips head, records history, does NOT bump recency (0.10ms)
✔ skip: a skipped singer who re-submits keeps their standing (0.08ms)
✔ skip: specific entry id (0.07ms)
✔ skip: nothing to skip returns undefined (0.04ms)
✔ removeEntry: removes a queued entry (0.07ms)
✔ removeEntry: idempotent no-op when absent (returns same ref) (0.06ms)
✔ removeEntry: user leaving frees their per-person cap (0.73ms)
✔ moveEntryToTable: changes table and re-buckets (0.36ms)
✔ moveEntryToTable: over-cap move is grandfathered (honored), drains naturally (0.08ms)
✔ moveEntryToTable: absent id is a no-op (same ref) (0.06ms)
✔ setVenueMode: switching modes loses no entries (0.06ms)
✔ setVenueMode: over-cap in-flight entries are grandfathered; new ones are capped (0.06ms)
✔ setVenueMode: re-orders under the new policy (0.07ms)
✔ peekUpcoming: returns first n of effective order (0.08ms)
✔ peekUpcoming: n <= 0 returns empty; n > length returns all (0.06ms)
✔ integration: per-person-1 stays fair across many rounds (0.11ms)
✔ integration: mode switch mid-session with in-flight entries never drops anyone (0.07ms)
ℹ tests 40  ℹ pass 40  ℹ fail 0
```

`tsc --noEmit`: clean, no errors.

---

## Correctness analysis

### Round-robin algorithm (`roundRobin` in `engine.ts`)

The virtual-tick approach is sound. Key properties verified:

- Buckets are seeded from real recency (`lastSang[k]`) or -1 for never-sang — never-sang buckets sort first (lowest `served` value). ✓
- `tick` initializes at `max(0, max_served + 1)` — guarantees any bucket served in this computation gets a value strictly higher than all pre-existing recency values. ✓
- After emitting a bucket's head, `served[k] = tick++` — puts it behind all currently-waiting buckets. ✓
- Tie-break by head `submittedAt` — submission order wins among equally-recent buckets. ✓
- Round-robin terminates because `result.length` strictly increases and `total = entries.length`. ✓

### Listen starvation cap (`mergeListens`)

- `consecutiveListen` resets to 0 whenever a singer is emitted. ✓
- When `consecutiveListen >= maxConsecutiveListen` and a singer is waiting, a singer is forced next. ✓
- `maxConsecutiveListen = 0` correctly yields "listens only play when no singers are waiting" (cap is immediately hit on any listen). ✓
- With no singers left, all remaining listens flush FIFO unconditionally. ✓

### Recency tracking

- `consume` updates **both** `lastSangByUuid` and `lastSangByTable` on every sing advance, regardless of current `venueMode`. This is intentional and correct — it ensures recency data is always accurate across mode switches. ✓
- `lastSangByTable` key uses `tableBucket()` consistently in both `consume` and `roundRobin`. ✓
- Skip does NOT update recency — the skipped singer retains their fairness standing. ✓

### Immutability

Verified in tests ("does not mutate input state"). The engine spreads objects (`{ ...state, ... }`) throughout and never writes to inputs. ✓

### Mode switch grandfathering

`setVenueMode` is a one-liner (`{ ...state, venueMode }`). Because order is recomputed on demand by `getEffectiveOrder`, existing over-cap entries simply participate in the new ordering — nothing is dropped. New additions are then capped under the new mode. ✓

### State serializability

`QueueState` is a plain object: arrays, Records of numbers, a number, and a string enum. Fully JSON-round-trippable. Suitable for an in-memory server store that may need to persist/snapshot state. ✓

### Edge cases

All documented edge cases are tested and pass: empty queue, duplicate submissions, cap frees after play, cap frees after remove, over-cap table move, mode switch with in-flight entries, skip-keeps-priority. No gaps found.

---

## Scope discipline

All 12 changed files are new files under `packages/rotation-engine/` or `work/`. Zero touches to:
- `app/`, `lib/`, `__tests__/`, `e2e/` (TICKET-1's app)
- `.github/workflows/ci.yml`
- Root `package.json`

Scope is clean. ✓

---

## Spec delta (PR body vs dev report vs planning doc)

The PR body and dev report contain matching delta tables. The deltas are accurate and complete: full-karaoke FIFO vs. round-robin-by-uuid; cap semantics (queued count vs. per-round quota); listen interleave policy; no-show grace re-queue; duplicate policy; field names. No misrepresentation found. The TM has accepted the delta for this PR; alignment is a follow-up. ✓

---

## API quality for TICKET-1 consumption

- Clean, minimal public surface via `src/index.ts`
- All operations return `{ state, result }` — app never mutates
- `addEntry` returns errors as values (not thrown) — app can pattern-match `res.accepted`
- `QueueState` is fully serializable — server can store as JSON
- `peekUpcoming(n)` gives the app a preview without advancing state

One note: `package.json` `main`/`exports.default` point to `./src/index.ts` (TypeScript source), which is intentional for the POC — the Next.js app will transpile it. At integration this may need adjustment to compiled output. Dev report calls this out. (NIT, not blocking.)

---

## Nits (non-blocking)

1. **Module-level `idCounter` in tests.** `fresh()` resets it to 0. Node's test runner is serial by default so this is safe, but it's a shared-mutable-state pattern that could confuse a future test maintainer. Optional: make idCounter local or use a closure factory.
2. **`exports.types` in `package.json` points to `.ts` source.** Fine for the current POC / transpiler-consumed setup; would need to point to `.d.ts` for a proper npm publish. Called out in dev report.
3. **No `getNominatedEntry` convenience.** Consumers call `peekUpcoming(1)[0]` or `getEffectiveOrder()[0]`. Fine for a v0.1 lib.

---

## Verdict

**APPROVE.**

The implementation correctly and completely delivers the TICKET-3 contract: three venue modes, listen starvation cap, skip-no-penalty, mode-switch grandfathering, immutable state, serializable QueueState. Algorithms are sound. 40/40 tests pass (verified independently). TypeScript is clean. Scope is new-files-only. Dev report is current and accurate. Spec delta is correctly represented.

**Gate-waiver note for TM:** App Tester and Cyber Security gates were not run before this review. For a zero-dep, I/O-free pure library this is low-risk, but the TM should record the gate-waiver decision in DECISIONS.md or close those gate items explicitly before merge.
