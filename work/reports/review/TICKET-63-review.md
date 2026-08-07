# TICKET-63 — Reviewer report (independent, clean context)

Branch: `ticket/63-cjson-shape-invariant` — worktree `/Users/paulosalvatore/Documents/GitHub/boraoke/.worktrees/ticket-63`
Reviewed against: `origin/main` @ `46d25cd`
Date: 2026-08-05

## Verdict

APPROVE-WITH-FOLLOWUPS

The invariant is genuinely pinned, both probes go red as claimed, and the assertion is demonstrably not a tautology. Two non-blocking items below (one process, one pre-existing enforcement gap that this ticket was not allowed to fix).

## 1. Scope — only the allowed file changed

```
$ git diff origin/main --stat
 __tests__/pending-store.test.ts | 152 ++++++++++++++++++++++++++++++++++++++++
 1 file changed, 152 insertions(+)

$ git status --porcelain
 M __tests__/pending-store.test.ts
?? work/tickets/TICKET-63-cjson-shape-invariant.md
```

Confirmed: `lib/pending-store.ts`, `lib/pending-types.ts`, `lib/store/types.ts`, `jest.config.ts` untouched. The change is purely additive (152 insertions, 0 deletions) appended after the existing TICKET-53 describe block — no existing test was modified or weakened.

## 2. Tests green

```
$ npx jest __tests__/pending-store.test.ts
  cjson string/boolean-only invariant (TICKET-56 FU-5 / TICKET-63)
    ✓ assertCjsonSafeShape is not a tautology: it throws on an injected numeric leaf (8 ms)
    ✓ assertCjsonSafeShape passes a string/boolean/null-only shape
    ✓ the ACTUAL round-tripped PendingEntry (real rejectAllPending, Lua-emulating path) stays string/boolean/null-only

Test Suites: 1 passed, 1 total
Tests:       35 passed, 35 total
```

32 pre-existing + 3 new = 35, as expected.

## 3. Typecheck — no type errors attributable to this diff

```
$ npx tsc --noEmit 2>&1 | grep -oE "error TS[0-9]+" | sort | uniq -c
1250 error TS2304
   5 error TS2345
   1 error TS2353
  17 error TS2540
 699 error TS2582
  15 error TS7006
```

Zero `TS2322` and zero `TS2352` in the current tree — nothing on the `AssertCjsonSafe` / `_pendingEntryIsCjsonSafe` / `_queueEntryIsCjsonSafe` lines.

Baseline comparison (pre-existing noise is not caused by this diff):

```
$ npx tsc --noEmit 2>&1 | grep -c "error TS"   # with diff
1987
$ git stash && npx tsc --noEmit 2>&1 | grep -c "error TS" && git stash pop   # without diff
1977
```

Delta = **+10**, exactly the `describe`/`it`/`expect` `TS2582`/`TS2304` noise from the 3 new `it` blocks + 1 new `describe`. No real type error introduced. Root cause of the ~1977 baseline: `@types/jest` is not installed (`ls node_modules/@types/` shows no `jest`) while `tsconfig.json` includes `**/*.ts` — pre-existing, out of this ticket's allowed scope.

## 4. Red probe A (runtime layer) — CONFIRMED RED

Injected `(full.entry as unknown as { durationSeconds: number }).durationSeconds = 217.3;` immediately after `const full = makePending(...)` and before `await s.add(full);`.

```
$ npx jest __tests__/pending-store.test.ts -t "ACTUAL round-tripped"

  ● cjson string/boolean-only invariant (TICKET-56 FU-5 / TICKET-63) › the ACTUAL round-tripped PendingEntry (real rejectAllPending, Lua-emulating path) stays string/boolean/null-only

    cjson round-trip hazard at PendingEntry.entry.durationSeconds: value is a number (217.3), not a string/boolean/null.
    lib/pending-store.ts's REJECT_ALL_PENDING_SCRIPT decodes every persisted PendingEntry with Lua's cjson.decode and re-encodes it with cjson.encode. That round-trip is lossless ONLY because every persisted field today is a string or boolean — cjson.encode reformats any Lua number through "%.14g" on the way back out, which would silently corrupt a large integer id or truncate a float's precision. A new numeric field needs an explicit string-encoded representation (or the Lua script needs updating) before it is safe to persist through this path. See TICKET-56 FU-5 / TICKET-63.

      at assertCjsonSafeShape (__tests__/pending-store.test.ts:596:9)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 34 skipped, 35 total
```

Message mentions cjson, `%.14g`, and `lib/pending-store.ts`, and names the exact offending path. Note the failure surfaced on the value fetched back out via `s.get()` **after** `rejectAllPending` — i.e. it really did traverse the `FakeRedis.eval` JSON round-trip, not the pre-write object. Probe reverted (file md5 restored to `2c3daf1e1d7e6814462d2bf0c292ae45`).

## 5. Red probe B (type layer) — CONFIRMED RED

Injected before `_pendingEntryIsCjsonSafe`:

```ts
type __ProbePendingEntry = PendingEntry & { entry: PendingEntry["entry"] & { durationSeconds: number } };
const __probe: AssertCjsonSafe<__ProbePendingEntry> = true; void __probe;
```

```
$ npx tsc --noEmit 2>&1 | grep pending-store.test.ts | grep -vE "TS2582|TS2304|TS7006"
__tests__/pending-store.test.ts(572,7): error TS2322: Type 'true' is not assignable to type 'false'.
```

A new `TS2322` appears on exactly the probe line. Reverted; `git diff origin/main --stat` back to the clean 152-insertion diff.

I ran two further probes the brief did not ask for, to test for false negatives:

```ts
type __P2 = QueueEntry & { durationSeconds?: number };        // OPTIONAL numeric
type __P3 = QueueEntry & { meta: { bitrate: number } };       // numeric nested one level deeper
```

Both produced `TS2322` (lines 572 and 574). So the check catches optional numerics and numerics behind a new nested object, not just required top-level ones. Reverted.

## 6. Tautology assessment — the check is real, and the two layers are genuinely complementary

Authoritative field lists read directly from source:

- `lib/store/types.ts` → `QueueEntry`: `id`, `videoId`, `title?`, `nickname`, `patronUuid`, `table?`, `mode`, `submittedAt`, `graceRequeue?` (9 fields).
- `lib/pending-types.ts` → `PendingEntry`: `pendingId`, `roomId`, `entry`, `status`, `createdAt` (5 fields).

The fixture is genuinely maximal. `makeEntry` (line 147) populates `id`, `videoId`, `title`, `nickname`, `patronUuid`, `mode`, `submittedAt`; the test's override adds the remaining two optionals, `table: "12"` and `graceRequeue: true`. All 9 `QueueEntry` fields present. `makePending` (line 161) populates all 5 `PendingEntry` fields. So the runtime walk really does visit every field the types currently define — it is not passing because the object is sparse.

The dual-layer reasoning holds and is not redundant:

- **Runtime layer** is CI-executed (`npm test`) but only sees fields *present on this instance*. A future dev who adds `durationSeconds: number` to `QueueEntry` and forgets to set it in `makeEntry` would slip past it.
- **Type layer** is structural over `keyof T`, so it covers every declared key whether populated or not, required or optional — it closes exactly that hole. Probe `__P2` above proves the optional case is caught.
- Conversely the type layer cannot see a value that arrives untyped at runtime (e.g. an `as unknown as` cast, or a field written by a code path outside the declared type), which is what the runtime layer covers. Probe A is that case.

The tautology-guard test (`throws on an injected numeric leaf` / `passes a clean shape`) additionally pins `assertCjsonSafeShape` itself against being silently neutered into a no-op.

## 7. `-?` modifier — intentional and necessary, verified

Removing `-?` from `{ [K in keyof T]-?: AssertCjsonSafe<T[K]> }[keyof T]`:

```
$ npx tsc --noEmit 2>&1 | grep pending-store.test.ts | grep -vE "TS2582|TS2304|TS7006"
__tests__/pending-store.test.ts(571,7): error TS2322: Type 'true' is not assignable to type 'false'.
__tests__/pending-store.test.ts(572,7): error TS2322: Type 'true' is not assignable to type 'false'.
```

Both `_pendingEntryIsCjsonSafe` and `_queueEntryIsCjsonSafe` **fail to compile** without it — a false positive on the already-safe real types, caused by the homomorphic mapped type preserving each optional key's `?` and the `[keyof T]` index then folding in a spurious `| undefined` (making the union `true | undefined`, which does not extend `true`). The inline comment in the diff states exactly this reason and is accurate. Reverted; file md5 restored. Soundness is otherwise fine: `CjsonSafeLeaf` includes `undefined` so genuinely-optional string/boolean fields resolve to `true`, and the distributive conditional turns any `number`-bearing union into `boolean`, which correctly fails `extends true`.

## Issues found

**F-1 (process, MEDIUM) — the work is not committed.** `git rev-parse HEAD` == `origin/main` == `46d25cd`; `git branch -vv` shows `ticket/63-cjson-shape-invariant` at `origin/main` with no commit ahead. The entire 152-line change exists only as an uncommitted working-tree modification, and `work/tickets/TICKET-63-cjson-shape-invariant.md` is untracked. There is therefore no PR to gate. This must be committed (via the `commit` skill) and a PR opened before merge. I deliberately did not commit it — that is the Dev/TM's call, not the Reviewer's.

**F-2 (enforcement gap, MEDIUM — pre-existing, out of this ticket's scope) — the type-level half is not enforced by any automated gate.** `.github/workflows/ci.yml` runs `npm test` only; there is no `typecheck` script in `package.json` and no `next build` step in CI. Combined with the `isolatedModules: true` type-stripping the diff correctly documents, this means the `AssertCjsonSafe` pin fires *only* when a human runs `npx tsc --noEmit` by hand — and even then its single `TS2322` would sit inside ~1990 lines of baseline noise. The ticket forbade touching `jest.config.ts`/CI, so this is not a defect in the delivery; the diff's header comment is honest about it ("enforced ONLY by running `npx tsc --noEmit`"). Recommend a follow-up ticket: install `@types/jest` (or add `"types": ["jest","node"]`), drive the baseline to zero, add an `npm run typecheck` script, and add it as a CI step. Without that, only the runtime layer is actually gated, and F-2 is the reason the type layer could rot unnoticed.

**Nit (LOW, no action required) —** `assertCjsonSafeShape` throws on a leaf whose value is literally `undefined` (`typeof undefined` is neither `"object"` nor `"string"`/`"boolean"`, so it falls through to the throw), while `CjsonSafeLeaf` permits `undefined` at the type level. Harmless in practice: the value under test comes back through `JSON.parse(JSON.stringify(...))` in `FakeRedis`, which drops `undefined`-valued keys entirely, so the branch is unreachable on this path. The asymmetry is over-strict rather than under-strict, so it can never mask a hazard.

## Working-tree state at end of review

```
$ git diff origin/main --stat
 __tests__/pending-store.test.ts | 152 ++++++++++++++++++++++++++++++++++++++++
 1 file changed, 152 insertions(+)

$ git status --porcelain
 M __tests__/pending-store.test.ts
?? work/tickets/TICKET-63-cjson-shape-invariant.md
?? work/reports/review/TICKET-63-review.md
```

All four probe edits fully reverted (`__tests__/pending-store.test.ts` md5 `2c3daf1e1d7e6814462d2bf0c292ae45`, verified after each revert). The only file I created is this report.

---

VERDICT: APPROVE-WITH-FOLLOWUPS
