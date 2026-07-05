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

---

## Second pass — D-022 opus merge-counting review (2026-07-05)

- **Model tier:** opus (judgment pass — hunting for correctness/fairness flaws the sonnet pass and the tests do not cover).
- **Verdict: REQUEST-CHANGES** (one blocking correctness flaw, empirically reproduced).
- Re-ran the suite myself: `node --test` → 40/40 pass; `tsc --noEmit` clean. The sonnet pass's structural findings all hold. This pass is purely the adversarial fairness/API-contract layer.

### BLOCKING — F1: the listen-starvation cap is defeated in real playback (peek ≠ play)

The `maxConsecutiveListen` cap is the library's central fairness guarantee (README: *"at most `maxConsecutiveListen` listen songs may play in a row while a singer is still waiting"*, motivated by *"20 people queueing dance tracks while one nervous singer waits forever"*). It is enforced **only inside a single `getEffectiveOrder` snapshot**. `mergeListens` re-initializes `consecutiveListen = 0` on every call, and there is **no consecutive-listen counter persisted in `QueueState`**. But real playback is driven head-by-head: the app plays the head, the song ends, it calls `advance` again on the (re-derived) queue — because the live queue changes between songs, recomputation is the *intended* usage (README: *"The order songs actually play in is always computed fresh from the current queue"*). Each recomputation forgets that a listen just played, so a listen with a lower `submittedAt` than the waiting singer jumps ahead **every single tick** — exactly the starvation the cap exists to prevent.

Empirically reproduced (default cap = 1; queue = l1, l2, l3 listens then s1 sing; no adds between plays):

```
PEEK  (getEffectiveOrder snapshot):  l1, s1, l2, l3     <- cap honored
ACTUAL playback via advance-loop:    l1, l2, l3, s1     <- singer starved behind ALL 3 listens
```

Two problems in one: (a) the fairness guarantee is broken in the exact README scenario, and (b) `peekUpcoming` / `getEffectiveOrder` (what `/tv` renders) disagrees with what `advance` actually plays — TICKET-1's `/tv` preview would show a different, cap-respecting order than the one that airs. This is untested: every listen test asserts a single `getEffectiveOrder` snapshot; none drives a multi-`advance` loop.

**Failing-test sketch (fails on current HEAD):**

```ts
test("listen: starvation cap holds ACROSS advances, not just in one snapshot", () => {
  let s = fresh("full-karaoke"); // default maxConsecutiveListen = 1
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "l2", mode: "listen" });
  s = add(s, { id: "l3", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  const played: string[] = [];
  for (let i = 0; i < 4; i += 1) { const r = advance(s); s = r.state; played.push(r.played!.id); }
  // cap=1 => the singer must not sit behind more than one listen.
  assert.ok(played.indexOf("s1") <= 1, `singer starved: ${played.join(",")}`); // ACTUAL: l1,l2,l3,s1 -> idx 3
});
```

**Fix direction (small, design-level):** persist the run in state — e.g. a `consecutiveListen` counter on `QueueState`, incremented when `advance` plays a `listen`, reset to 0 when it plays a `sing`; seed `mergeListens` from it so the head derivation respects the cap across ticks. (Equivalent: have `advance` force the next singer when the persisted run has hit the cap.) Either restores peek==play.

### MED — F2: `maxConsecutiveListen: Infinity` does not survive JSON round-trip (serializability)

The task asks whether `QueueState` is serializable into an in-memory server store. It is *almost* fully JSON-round-trippable, with one advertised-option footgun: `JSON.stringify(Infinity) === "null"`. A venue that sets the README-documented `Infinity` (dance-forward vibe) and whose server snapshots/rehydrates state via JSON gets `options.maxConsecutiveListen === null` back. `consecutiveListen >= null` coerces to `>= 0` → **always true** → cap fires immediately → the *opposite* of the intended "never cap" behavior (listens only when no singer waits). Empirically confirmed: round-trip yields `null`. The prior pass's "Fully JSON-round-trippable ✓" is inaccurate for this option. Not blocking on its own, but should be fixed alongside F1 (e.g. use a sentinel like `0`-means-off or a large int, or document "don't use Infinity if you serialize"). Fixing F1 by persisting a counter also puts the option value on the persisted-state hot path, so decide the representation once.

### NIT — F3: cross-mode duplicate scope

`addEntry`'s duplicate check keys on `uuid + videoId` across **all** modes, so a participant with a `listen` entry for video X cannot also queue a `sing` for X (and vice-versa). Probably fine, but it's an unstated coupling between the two modes; worth a one-line README note or a `mode` term in the dup check if unintended.

### Confirmed sound (adversarial probes that held up)

- **Sing round-robin is consistent batch-vs-iterative.** Traced per-person-1 and per-table-2 with recency: the virtual-tick simulation in `roundRobin` and the real `singClock` progression stay aligned (both +1 per play), so head-by-head `advance` reproduces the batch sing order. The peek≠play defect is isolated to the listen layer (F1).
- **Late joiner mid-round** (never-sang bucket seeded at -1) correctly outranks recently-sang buckets; tie-break by `submittedAt` holds.
- **Recency across mode switches**: `consume` updates *both* `lastSangByUuid` and `lastSangByTable` unconditionally, so switching modes preserves fairness history. Correct.
- **Table switch mid-round** (`moveEntryToTable`): re-buckets under the destination's table recency (per-table semantics, not per-person) and grandfathers over-cap — correct and tested.
- **Skip keeps priority** (no recency bump); **cap grandfathering** on `setVenueMode` — correct and tested.

### Waiver soundness (App Tester + Cyber Security N/A-by-content)

**Sound.** App Tester (boot app, screenshot flows) genuinely N/A — there is no app, no UI, no route. Cyber Security N/A is also sound *at this layer*: pure, I/O-free, no network/FS/eval/regex-on-input, no unbounded recursion; untrusted strings (`videoId`, `nickname`, `table`) are only stored/compared, never interpreted — sanitization/escaping is correctly TICKET-1's responsibility (YouTube-embed injection, XSS on the `/tv` render). One low note for the integration ticket: `roundRobin` is ~O(n·buckets) per full order and `getEffectiveOrder` is recomputed each render — negligible for bar-scale queues, not a security concern. Waiver stands.

### Spec-delta honesty

The PR-body / dev-report delta table faithfully represents the divergences from `work/planning/rotation-modes-fair-queue.md`. As flagged in the task: the planning doc was updated on `main` *after* this branch (adding `graceRequeue` + `nowPlaying` semantics) and the lib predates that — **flagged, not blocking**; alignment is a filed follow-up. No misrepresentation.

### Verdict rationale

REQUEST-CHANGES rather than "approve + follow-up ticket": F1 is not polish — it silently breaks the library's headline fairness guarantee in the exact scenario the README advertises, and it makes the `/tv` preview (`peekUpcoming`) disagree with actual playback (`advance`), which TICKET-1 builds directly on. It is also currently untested. The fix is small and localized (persist one counter). F2 should ride along since it touches the same option's persisted representation. Recommend fixing F1+F2 (with the F1 test above added and green) and a quick re-review of the delta; F3 is a NIT the TM may defer.

---

## Re-review — D-022 opus merge-counting pass, delta after fix commit `9728a5d` (2026-07-05)

- **Verdict: APPROVE** (merge-counting).
- Scope of re-review: commit `9728a5d` ("address opus review F1/F2/F3"), read locally in the worktree at origin tip `0b13c0c`. Note: the Dev's fix-summary PR comment is absent (API outage per coordinator); reviewed from code + tests + dev report directly.

### Item-by-item confirmation

- **F1 (BLOCKING) — FIXED, verified empirically.** `QueueState` gains a persisted `consecutiveListen: number` (init 0); `consume` increments it when a `listen` plays and resets it to 0 when a `sing` plays; `skip` leaves it untouched (correct — nothing played); `getEffectiveOrder` seeds `mergeListens` from the persisted value. Re-ran my exact first-pass reproduction (cap=1; `l1,l2,l3` listens then `s1`): PEEK `l1,s1,l2,l3` == ACTUAL advance-loop `l1,s1,l2,l3`, singer index 1 (was 3). My failing-test sketch is now in the suite verbatim, plus a full-drain `peekUpcoming(1)==advance` consistency loop and a counter-lifecycle test.
- **F2 (MED) — FIXED, verified empirically.** Serialization contract changed to `maxConsecutiveListen: number | null` with **`null` = no cap** as canonical; `createQueue` normalizes `Infinity` → `null`; `mergeListens` guards `maxConsecutiveListen !== null` before the cap check (kills the `>= null` coercion). Verified: `Infinity` stored as `null`, JSON round-trip yields `null`, revived state deep-equals and orders identically (batch + iterative). Round-trip tests added, including a mid-run state with a non-zero persisted counter.
- **F3 (NIT) — FIXED.** Duplicate key is now `uuid + videoId + mode`; test added (listen-for-X no longer blocks sing-for-X; same-mode dup still rejected); README documents the rule.

### Additional adversarial probes on the new counter (all held)

- **Skip interleaved with a forced singer at cap:** after a listen plays (run=1, cap=1) the order forces singer `sa`; skipping `sa` leaves run=1 and the order still forces the *next* singer `sb` — listens cannot exploit a no-show to extend the run. Correct.
- **Mid-run JSON round-trip (cap=2, run=1):** revived state produces the identical effective order (`x2,sx,x3`). The persisted counter round-trips.
- **Design note reviewed:** the counter increments on a listen play even with no singer waiting, so a singer joining mid-listen-run is favored immediately. The dev report documents this deliberately singer-favoring edge; acceptable semantics, honestly disclosed.

### Suite / typecheck / CI / report currency

- `node --test`: **47/47 pass** (was 40; +7 covering F1/F2/F3), my own run.
- `npx tsc --noEmit`: clean, my own run.
- `gh pr checks 3`: Vercel + Vercel Preview Comments both `pass`, nothing pending — S1 satisfied (no required test CI exists for this package; deferred to app-integration per ticket, as recorded in the first pass).
- Dev report updated in the same commit: current status line (47/47), a faithful "Opus review fixes" section, README updated (null/no-cap semantics, peek==play guarantee, per-mode duplicate rule). TICKET-F23 satisfied.

### Verdict

**APPROVE — merge-counting.** All three findings resolved with the fixes I recommended, each locked in by tests (including my exact failing case), independently re-verified by my own reproduction runs. Gate-waiver call (App Tester / Cyber Security N/A-by-content) unchanged and still sound — the fix commit adds no I/O or attack surface. Outstanding non-blockers carry over unchanged: spec-delta alignment with the updated planning doc (`graceRequeue`/`nowPlaying`) is a filed follow-up; package `exports` pointing at `.ts` source is a known POC choice. TM may merge.
