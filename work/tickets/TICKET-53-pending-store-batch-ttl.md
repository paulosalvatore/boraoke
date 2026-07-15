# TICKET-53 — Pending-store: MGET batch + TTL-on-reject + lazy index prune

**Type:** backend-only · **Priority:** MED · **Origin:** board follow-up from F/PR#25 (pending-store review)

## Problem

The Upstash pending-store driver has two cost/correctness issues at scale:

- **Poll cost (N+1 GETs).** `UpstashPendingStore.listRoom` fetched every indexed item with a per-id `get` loop. The patron page polls every ~3s, so at 20 pending entries this is ~4,400 Upstash commands/min per room.
- **Orphan accumulation.** Rejected entries were flipped to `"rejected"` and kept forever (intentionally, so the patron poll surfaces the state), but they never expired — the index and keyspace grew unbounded with dead rejected records.

## Scope (three cohesive changes to `UpstashPendingStore` only)

The memory driver (`MemoryPendingStore`) is per-process ephemeral and stays behavior-identical — **no TTL logic added to it**.

1. **Batch reads with MGET.** Added `mget<T>(...keys): Promise<(T|null)[]>` to `PendingRedisLike`. `listRoom` now fetches all indexed item records in a single `MGET`. Empty-case guarded: zero ids returns `[]` without calling `mget` (Upstash MGET with zero keys is invalid). Chronological sort and null-omission behavior preserved. `countRoom` / `countUuid` / `listForUuid` / `rejectAllPending` route through `listRoom`, so they inherit the batching for free.

2. **TTL on rejected entries.** Added `pexpire(key, ms): Promise<unknown>` to `PendingRedisLike`. Both `reject` and `rejectAllPending` now set a bounded TTL (`REJECTED_PENDING_TTL_MS = 10 * 60 * 1000` = 10 minutes) on the flipped item key, so rejected orphans self-expire. 10 min is comfortably longer than the ~3s patron poll, so the "rejected" state reliably surfaces before the record vanishes. Only the item key gets the TTL; the id lingers in the index until lazily pruned (change 3). `take`/approval behavior unchanged.

3. **Lazy index prune.** In `listRoom`, when an indexed id's MGET slot comes back null (item expired/gone), `lrem` that id from the index so it doesn't grow unbounded with dead ids. Only null-slot ids are pruned — never a live record's id. Best-effort read-path cleanup.

Everything else byte-identical: fail-open behavior, key schema, `add`/`take`/`get` semantics, the frozen `PendingStore` public interface, and the memory driver.

## Tests

Extended `FakeRedis` with faithful `mget` (key-order, null for missing) and `pexpire` (TTL map, `_expireNow`/`_ttlOf`/`_listLen` test-only helpers), plus per-method call counters — no change to the production `PendingRedisLike` shape. New focused tests prove:

- `listRoom` issues exactly ONE `mget` and zero per-id `get`s.
- Empty room returns `[]` without calling `mget`.
- `reject` and `rejectAllPending` call `pexpire` with the item key and `REJECTED_PENDING_TTL_MS`.
- After a rejected item's TTL is simulated-expired, `listRoom` omits it AND its dead id is lazily `lrem`'d (index shrinks; the live id is untouched).
- All existing conformance tests (both drivers) stay green.

## Verify

- `npm test` → **542/542 passing** (37 suites); pending-store suite 27/27.
- `npm run build` → exit 0 (Next.js build + typecheck clean).

## Delivery

**DELIVER-NOT-MERGE.** boraoke.com auto-deploys on every `main` merge — leave the PR OPEN for Reviewer (opus) gating.
