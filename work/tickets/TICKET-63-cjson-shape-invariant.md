---
ticket: TICKET-63
title: Pin the cjson string/boolean-only invariant for the Lua pending path (TICKET-56 FU-5)
product: boraoke
status: in-review
---

## Context

PR #40 (TICKET-56) made `rejectAllPending` atomic via a Lua `EVAL`
(`REJECT_ALL_PENDING_SCRIPT` in `lib/pending-store.ts`). That script decodes
each persisted `PendingEntry` with `cjson.decode`, flips `status`, and
re-encodes it with `cjson.encode`. The round-trip is lossless only because
every field of `PendingEntry`/`QueueEntry` is currently a string or boolean —
Lua's cjson reformats any number through `%.14g` on encode, which would
silently corrupt a large integer id or truncate a float. This safety rested on
nothing but a code comment (TICKET-56 FU-5).

## Acceptance criteria

- A test fails loudly if a numeric field is ever added to the persisted
  pending/queue entry shape.
- Passes on the current branch as-is.
- Failure message explains the cjson/`%.14g` hazard and points at
  `lib/pending-store.ts`.
- Prefers an assertion over the actual persisted shape over a hand-maintained
  field-name list.
- Any type-level check must be genuinely enforced at test time — proven via
  `npx tsc --noEmit`, not just `npm test`.

## What shipped

Added to `__tests__/pending-store.test.ts` only (no other file touched):

1. **Type-level check** — `AssertCjsonSafe<T>`, a recursive conditional type
   that structurally requires every leaf of `PendingEntry`/`QueueEntry` to be
   `string | boolean | null | undefined`, covering every key via `keyof T`
   (not a hand-maintained list). Pinned via
   `const _pendingEntryIsCjsonSafe: AssertCjsonSafe<PendingEntry> = true;` and
   the `QueueEntry` equivalent. This is a type-only construct: ts-jest runs
   with `isolatedModules: true` (jest.config.ts), which strips types before
   execution, so **`npm test` alone can never observe this fail** — it is
   enforced only by `npx tsc --noEmit`, which the dev/reviewer verification
   runs as an explicit separate step.
2. **Runtime check** — `assertCjsonSafeShape(value, path)`, a recursive
   function that walks an actual object and throws a hazard-explaining Error
   (mentions Lua `cjson` / `%.14g`, points at `lib/pending-store.ts`) if any
   leaf is a number (or other non-string/boolean/null). Applied to the
   **actual persisted PendingEntry** that comes back out of a real
   `UpstashPendingStore.rejectAllPending` call (driven against the same
   Lua-script-emulating `FakeRedis.eval` already used by the rest of the
   file), using a maximally-populated representative entry (every optional
   field set).
3. A tautology-guard test asserting `assertCjsonSafeShape` actually throws on
   an injected numeric leaf and passes on a clean string/boolean/null shape.

## Verification (real, observed)

- `npm test` (scoped `npx jest __tests__/pending-store.test.ts`): **35/35
  pass**, including all 3 new tests.
- `npx tsc --noEmit`: no `TS2322`/`TS2352` type-mismatch errors touch our new
  assertion lines. (The repo has a pre-existing, unrelated gap: bare
  `npx tsc --noEmit` reports ~1977 baseline "Cannot find name
  describe/it/expect" errors across every test file in `__tests__/`, present
  before this change too — jest ambient types aren't wired into the root
  tsconfig for this direct-tsc invocation. Confirmed via `git stash` that this
  count is unchanged by our work, i.e. it's not something we introduced or
  need to fix under this ticket's scope.)

### Red-probe evidence (both layers), then reverted

**Type-level probe** — temporarily added a scratch type extending
`PendingEntry` with a numeric field and re-ran the assertion:

```ts
type __ProbePendingEntry = PendingEntry & { entry: PendingEntry["entry"] & { durationSeconds: number } };
const __probe: AssertCjsonSafe<__ProbePendingEntry> = true;
```

`npx tsc --noEmit` output:
```
__tests__/pending-store.test.ts(572,7): error TS2322: Type 'true' is not assignable to type 'false'.
```
Red, as expected. Probe reverted immediately after (diff is clean, confirmed
via `git diff --stat`: only the shipped 152 lines remain).

**Runtime probe** — temporarily injected a numeric field into the actual
entry object handed to `store.add()` in the round-trip test:

```ts
(full.entry as unknown as { durationSeconds: number }).durationSeconds = 217.3;
```

`npx jest -t "ACTUAL round-tripped"` output:
```
✕ the ACTUAL round-tripped PendingEntry (real rejectAllPending, Lua-emulating path) stays string/boolean/null-only

  cjson round-trip hazard at PendingEntry.entry.durationSeconds: value is a number (217.3), not a string/boolean/null.
  lib/pending-store.ts's REJECT_ALL_PENDING_SCRIPT decodes every persisted PendingEntry with Lua's cjson.decode and re-encodes it with cjson.encode. That round-trip is lossless ONLY because every persisted field today is a string or boolean — cjson.encode reformats any Lua number through "%.14g" on the way back out, which would silently corrupt a large integer id or truncate a float's precision. A new numeric field needs an explicit string-encoded representation (or the Lua script needs updating) before it is safe to persist through this path. See TICKET-56 FU-5 / TICKET-63.
```
Red, message explains the hazard and names the file, as expected. Probe
reverted immediately after; re-ran full suite green (35/35) to confirm clean
state.

## Bug found and fixed while building this

The first version of `AssertCjsonSafe<T>` used
`{ [K in keyof T]: AssertCjsonSafe<T[K]> }[keyof T] extends true ? true : false`.
This is a homomorphic mapped type over a generic `T`, which preserves each
key's `?` modifier — indexing it with `[keyof T]` then folds in a spurious
extra `| undefined` for every OPTIONAL field, making the whole check evaluate
to `false` even when every field was already safe (confirmed: baseline
`_pendingEntryIsCjsonSafe`/`_queueEntryIsCjsonSafe` assignments failed to
compile before the fix, despite `PendingEntry`/`QueueEntry` being genuinely
string/boolean-only today). Fixed with `-?` on the mapped type (strips
optionality from the MAPPED TYPE only, not from the value types):
`{ [K in keyof T]-?: AssertCjsonSafe<T[K]> }[keyof T]`. Re-verified clean
afterward (no TS2322 on the pinning lines).

## Out of scope

- Does not attempt to drive a real Lua interpreter/cjson (none available in
  this environment); the runtime check drives the existing
  Lua-script-emulating `FakeRedis.eval` already trusted by this test file's
  other assertions (e.g. the TICKET-53 batch/TTL/lazy-prune tests), which
  models the script's server-side atomicity and decode/re-encode structure.
- Does not fix the repo-wide pre-existing `npx tsc --noEmit` jest-ambient-type
  gap (~1977 baseline errors) — unrelated to this ticket and outside the
  allowed file list.
