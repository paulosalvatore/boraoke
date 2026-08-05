# TICKET-56 — Make `UpstashPendingStore.rejectAllPending` atomic via a Lua EVAL

**Type:** backend-only · **Priority:** LOW · **Origin:** filed follow-up TICKET-49 F-1 (opus reviewer on PR #31)

## Problem

`UpstashPendingStore.rejectAllPending` was a client-side read-modify-write: one `listRoom` pass, then a `set` + `pexpire` per still-pending item. That carries the same lost-update race class as the single `reject` the reviewer had already flagged — anything that lands between the listing pass and the per-item write is lost.

Two concrete losses. A host approval (`take`) that pops an entry mid-loop has its deletion resurrected as a "rejected" record, so the patron's approved song reappears as refused. An entry a patron submits after the listing pass survives a "reject everything" sweep as still `pending`, stranding exactly the patron this feature exists to un-strand.

It is also O(N) round-trips.

The reviewer sanctioned the loop as acceptable in the toggle-OFF teardown context and asked for it to be folded into a Lua/CAS primitive. This only matters once the Upstash pending driver is live in prod (prod currently runs the in-memory driver), hence LOW.

## Scope

`UpstashPendingStore` only. `MemoryPendingStore` stays behavior-identical and the public `PendingStore` interface is unchanged, so the shared driver-conformance table runs against both drivers unmodified.

1. **One atomic EVAL.** New `REJECT_ALL_PENDING_SCRIPT` performs the whole read→flip→write server-side, so Redis's single-threaded execution serializes it against every concurrent `take`/`add`/`reject`. Follows the two in-repo precedents exactly: `MERGE_SCRIPT` (`lib/store/upstash.ts`) and `REGISTER_FAILURE_SCRIPT` (`lib/rate-limit-counter.ts`).
2. **`eval` on `PendingRedisLike`,** mirroring `RedisLike.eval` and @upstash/redis's own signature.
3. **Fail-open fallback.** On an EVAL error the driver logs a loud warning and runs the old loop, so a scripting blip can never fail the host's moderation toggle.

## Acceptance criteria

- The flip happens in ONE server-side EVAL: read the room index and item keys, flip only entries still in `pending` status to `rejected`, apply `REJECTED_PENDING_TTL_MS` to each flipped key, return the count flipped. No lost-update window.
- Observable semantics preserved exactly: same return value (number flipped), idempotent (a second call returns 0), room-scoped, never approves, never deletes queue entries, TTL on each flipped item key as before, and the lazy index-prune of dead ids that this path inherited from `listRoom` is not regressed.
- `MemoryPendingStore` byte-identical in behavior; public interface unchanged; the shared contract tests pass for both drivers unmodified.
- `FakeRedis` learns `eval` following the established precedent (a faithful JS emulation of the script's semantics, as `store.test.ts` does for `MERGE_SCRIPT`), not a new pattern.
- Error posture matches the surrounding code: an EVAL failure must not throw a new unhandled error into the moderation route.
- New tests prove the atomicity intent (ONE eval round-trip, not O(N) sets) and keep the TTL, idempotency, room-scoping and clean-0 assertions.

## Caller

`app/api/host/moderation/route.ts` — the moderation ON→OFF transition. The returned count feeds telemetry only (the `rejectedPending` prop on `host_action`); no control flow depends on it.

## Tests

Extended `FakeRedis` with an `eval` that applies the identical algorithm to the same stored JSON strings, synchronously (which models the script's atomicity), plus `calls.eval` / `calls.set` counters and an `evalThrows` switch. New cases: the one-eval round-trip assertion, index left intact, lazy prune during the flip, empty-room clean 0 with zero writes, and the EVAL-unsupported fallback (never throws, same observable result, warns loudly, still idempotent).

## Verify

- `npx jest` → **599/599 passing** (42 suites); baseline on this branch is 594, so +5. Pending-store suite 32/32.
- `npx next build` → exit 0.

## Delivery

**DELIVER-NOT-MERGE.** boraoke.com auto-deploys on every `main` merge — leave the PR open for Reviewer (opus) gating.
