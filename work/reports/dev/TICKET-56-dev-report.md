# TICKET-56 — Dev Report — Atomic `rejectAllPending` via Lua EVAL

**Status:** Implemented, self-verified (599/599 tests green in 42 suites, build exit 0), reviewer follow-ups FU-1 (comment half) / FU-2 / FU-3 / FU-4 / FU-6 applied on branch `ticket/56-lua-reject-all-pending`. Closes the filed follow-up TICKET-49 F-1 from the PR #31 opus reviewer. Deliver-not-merge — boraoke.com auto-deploys on every `main` merge.

## What changed

Two tracked source files, plus this report and the ticket.

- `lib/pending-store.ts` — added `eval<T>(script, keys, args)` to `PendingRedisLike` (mirrors `RedisLike.eval` in `lib/store/upstash.ts` and @upstash/redis's own signature); added the exported `REJECT_ALL_PENDING_SCRIPT`; rewrote `UpstashPendingStore.rejectAllPending` to a single `eval` call wrapped in try/catch; moved the old loop verbatim into a new private `rejectAllPendingUnsafeFallback`.
- `__tests__/pending-store.test.ts` — `FakeRedis` learns `eval` (faithful JS emulation), gains `calls.eval` / `calls.set` counters and an `evalThrows` switch; five new Upstash-specific cases.

`MemoryPendingStore`, the public `PendingStore` interface, the key schema, and every other driver method are untouched. The shared driver-conformance table runs against both drivers unmodified.

## Design of the script

`KEYS[1]` is the room's pending index. `ARGV[1]` is the item-key prefix, derived single-source via `pendingKeys.item(roomId, "")` so the script can never drift from the key schema. `ARGV[2]` is `REJECTED_PENDING_TTL_MS`.

The script `LRANGE`s the index, then per id `GET`s the item. A missing/expired record (`false`/`nil`) gets its dead id `LREM`'d from the index — this preserves the lazy prune the old path inherited by routing through `listRoom`. Otherwise it `pcall(cjson.decode, …)`s the record and, only if `obj.status == 'pending'`, flips to `rejected`, `SET`s the re-encoded record, `PEXPIRE`s it, and increments the counter. It returns the number flipped.

The index is never mutated for live records — rejected entries stay indexed so the patron poll still surfaces them, exactly like a single `reject`. Nothing is deleted; nothing is approved. Already-`rejected` entries are skipped, which is what keeps the call idempotent.

The `pcall`-guarded decode and the "read the whole thing server-side" shape follow `MERGE_SCRIPT`; the terse `redis.call` body and the constant-as-exported-template-literal convention follow both `MERGE_SCRIPT` and `REGISTER_FAILURE_SCRIPT`.

## Fail-open posture

An EVAL error logs `console.warn("[pending-store] bulk-reject EVAL failed — falling back to the NON-ATOMIC loop (lost-update window reopened)", err)` and then runs the fallback. The warning exists because a *permanent* EVAL failure (scripting disabled, an unsupported-command reply) would otherwise silently run the racy loop forever, which is precisely the bug the script closes. The caught error is passed through, never swallowed. `console.warn` was chosen over `track(...)` deliberately: `track` takes a fixed `TelemetryEventName` enum, so signalling this would mean minting a new event type, and importing `lib/telemetry` into the store would couple the store layer to the telemetry store. The one existing in-repo precedent for a warn-level operational signal (`app/api/queue/advance/route.ts`) uses the same `[tag] message` shape.

The fallback itself is unwrapped, so a genuine Redis outage still propagates to the route and 500s it — unchanged from the pre-script behavior. The docblock is scoped to say exactly that; wrapping the fallback is deferred as a separate board follow-up (it is a real judgment call, not a nit).

Both paths are idempotent — they only flip records still stored as `pending` — so a partially-applied script followed by the fallback cannot double-count or undo anything.

## How `eval` was faked

Followed the `store.test.ts` `MERGE_SCRIPT` precedent rather than inventing a pattern: `FakeRedis.eval` applies the identical algorithm to the same stored JSON strings, synchronously, which models the script's server-side atomicity (nothing can interleave mid-flip).

The emulation routes its `LREM`/`PEXPIRE` through the existing fake methods so those counters keep counting real Redis commands — which is why the pre-existing `pexpire === 2` assertion passes unchanged — but writes the flipped record straight to the backing map, because that `SET` is server-side, not a driver round-trip. The `calls` docblock states the two counter semantics explicitly so nobody has to infer them.

## New tests

Five cases, all in the Upstash-specific describe.

- **One eval round-trip:** `eval === 1`, `set === 0`, `mget === 0`, `get === 0`. This is the test that fails against the old implementation (which did `mget === 1`, `eval === 0`) — the reviewer independently reproduced that failure.
- **Index intact:** both ids still in the index after a bulk reject, `listRoom` still returns 2.
- **Lazy prune during the flip:** an already-expired record's id is `LREM`'d and not counted; only the live entry flips.
- **Empty room:** clean 0 with zero `set` and zero `pexpire`.
- **EVAL-unsupported fallback:** never throws, same observable result (only the still-pending entry flips, the pre-rejected one is untouched), warns loudly with the "NON-ATOMIC" signal, one client `set` + TTL, still idempotent on a second call.

## Risks and their dispositions

- **Item keys derived from an ARGV prefix rather than declared in `KEYS`.** A deliberate divergence from `MERGE_SCRIPT` (which declares every key it touches): the pendingIds live in the index and are not known client-side, so they cannot be enumerated into `KEYS` before the read. Correct on single-node Upstash; it would violate Redis Cluster's cross-slot rules if this keyspace ever moved to a clustered deployment. Recorded in the script docblock. Injection-proof: `roomId` never enters the script *text* (it is passed as data through KEYS/ARGV), and `ROOM_ID_RE` in `lib/rooms.ts` forbids `:` in a roomId, so a crafted roomId cannot escape its own key prefix either.
- **Lost EVAL response.** If the script succeeds server-side but the HTTP response is lost, the fallback re-runs and returns 0 while the flip did happen. Traced the return value: `app/api/host/moderation/route.ts` uses it solely as the `rejectedPending` prop on a `track("host_action", …)` call, with no control flow depending on it. Telemetry-only inaccuracy, in a rare path.
- **cjson decode/re-encode.** Lossless here: every persisted field of `PendingEntry` and its nested `QueueEntry` is a string or boolean, with zero numeric fields, so there is no integer/float coercion to worry about. Recorded in the script docblock. A shape-invariant test guarding that property against future schema drift is deferred as a board follow-up.
- **Cost.** The script is O(N) *blocking* work on Redis's single thread (N = index length: pending plus not-yet-expired rejected entries), where the old loop was O(N) non-blocking client round-trips. That is the trade for atomicity. Comfortably safe at the default `PENDING_ROOM_MAX` of 100; flagged in the docblock for anyone raising that ceiling.

## Verification (real output)

**Tests** (`npx jest`):

```
Test Suites: 42 passed, 42 total
Tests:       599 passed, 599 total
Snapshots:   0 total
Time:        1.789 s
```

Baseline on this branch was measured at **594** by stashing the diff and re-running, so the change is +5 tests and zero regressions. The stated 608 baseline in the ticket brief does not match this branch (`origin/main` @ 9470051) — it appears to include PR #39's additions. Pending-store suite alone: 32/32. A `console.warn` from `telemetry-instrumentation.test.ts` exercising a would-block advance path is expected test output, not a failure; the new fallback test spies on and restores `console.warn`, so it adds no noise.

**Build** (`npx next build`):

```
 ✓ Compiled successfully in 1266ms
BUILD_EXIT=0
```

A bare `npx tsc --noEmit` reports only the pre-existing jest-globals noise repo-wide (`Cannot find name 'describe'` etc., same class on untouched files like `youtube.test.ts`); **zero errors in `lib/pending-store.ts`**. `next build` is the project's real typecheck and is clean. `npx next lint` is not configured in this repo — it prompts for interactive ESLint setup, so it was not run.

## Not done here

- FU-1's behavioral half (wrapping `rejectAllPendingUnsafeFallback` so a full Redis outage cannot 500 the moderation route) — TM is filing it as a board follow-up.
- FU-5, a cjson shape-invariant test asserting `PendingEntry`/`QueueEntry` stay numeric-field-free — TM is filing it as a board follow-up.
- `reject` and `take` are untouched; folding those into the same Lua/CAS primitive is out of scope for this ticket.
