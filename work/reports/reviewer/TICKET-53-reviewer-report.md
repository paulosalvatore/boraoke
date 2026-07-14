# Reviewer Report — TICKET-53

PR #35 — `pending-store MGET batch + TTL-on-reject + lazy index prune`
Branch `ticket/53-pending-store-batch-ttl` (tip `2a5d030`, code commit `feadecd`), based off `origin/main` (`ab05be4`).
Reviewer: opus (D-022 merge-counting pass, folded security check).

## Verdict

**APPROVE** — independently reproduced tests + build. DELIVER-NOT-MERGE (stays OPEN for the human; boraoke.com auto-deploys on `main` merge).

## Gates reproduced (not trusted from the Dev)

- `npm test` → **542 passed, 542 total; 37 suites passed** (incl. `pending-store.test.ts`). Time 2.2s.
- `npm run build` → **exit 0** (Next production build, full page/route table emitted).

Reviewed files (`lib/pending-store.ts`, `__tests__/pending-store.test.ts`) verified to match `origin/ticket/53-pending-store-batch-ttl` — no local worktree drift.

## Scope check

Diff touches only `lib/pending-store.ts` (+40/-5), `__tests__/pending-store.test.ts` (+119), the ticket doc, and an auto-generated event-log jsonl. No drive-by refactors, no unrequested features, key schema unchanged, public `PendingStore` interface unchanged. Matches the exact three-change scope.

## Correctness — each change

**1. MGET batch reads.**
- `PendingRedisLike.mget<T>(...keys): Promise<(T|null)[]>` added.
- `listRoom` builds keys via `ids.map((id) => pendingKeys.item(roomId, id))`, calls one `mget`, then maps back by index (`recs[i]` ↔ `ids[i]`) — same order, no off-by-one, no mis-alignment.
- Empty-ids guard `if (ids.length === 0) return []` genuinely precedes any `mget` (never a zero-arg MGET). Confirmed by the dedicated test asserting `calls.mget === 0` on an empty room.
- Chronological order preserved (`idsFor` sorts ids before the map). Null-record omission preserved (`if (rec) out.push(rec)`).
- `countRoom`/`countUuid`/`listForUuid`/`rejectAllPending` all route through `listRoom` — batching inherited.

**2. TTL on rejected entries.**
- `pexpire(key, ms)` added; `REJECTED_PENDING_TTL_MS = 10*60*1000` (10min).
- Applied on the **item** key (`pendingKeys.item(...)`) — NOT the index key — in BOTH `reject` and `rejectAllPending`, only after the `status !== "pending"` guard passes and the flip-to-rejected `set` runs.
- `take`/approval: no `pexpire` — verified in the diff and by reading `take` (unchanged).
- No path sets a TTL on a still-`pending` entry: `pexpire` is only reached inside the two reject methods, after the entry is flipped to "rejected".
- Caller-assumption safety: 10min ≫ ~3s patron poll, so "rejected" reliably surfaces before expiry. `countRoom`/`countUuid` count only `status==="pending"` on live records, so a vanished rejected record does not perturb caps. Host view (`listRoom`) simply stops showing it — acceptable, that's the intent (self-expiring orphan). No caller relies on rejected entries persisting past ~poll horizon.

**3. Lazy index prune.**
- In `listRoom`, only a null slot triggers `lrem(pendingKeys.index(roomId), 0, ids[i])` — never a live record's id.
- `lrem count=0` = remove all occurrences of the value; correct dead-id cleanup.
- No race: prune targets exactly the id whose MGET slot came back null; a live record's id is never removed (proved by the expiry test asserting the surviving index == `[live.pendingId]`).

**Memory driver untouched.** `MemoryPendingStore` (lines 117–195) is byte-identical to pre-PR — no `mget`/`pexpire`/`lrem`/TTL/prune logic leaked in. Confirmed against the diff (no hunk touches the memory class) and by re-reading the full file.

## Test quality

The 5 new Upstash-specific tests are non-tautological and prove the properties:
1. `listRoom` → `calls.mget === 1 && calls.get === 0` (one batched read, zero per-id gets).
2. Empty room → `calls.mget === 0` (guard proven).
3. `reject` → `calls.pexpire === 1` AND `_ttlOf(itemKey) === REJECTED_PENDING_TTL_MS` (correct key + constant).
4. `rejectAllPending` (2 items) → `calls.pexpire === 2` AND both item keys carry the constant (both reject paths covered).
5. Simulated expiry (`_expireNow(itemKey)`) → item omitted from `listRoom`, `calls.lrem === 1`, index shrinks 2→1, surviving index == `[live.pendingId]` (omission + prune + live-id-safety in one).

`FakeRedis` fakes are faithful: `mget` maps keys→records in order with JSON-null semantics; `pexpire` mirrors real Redis ("only sets TTL on an existing key" — `if (this.kv.has(key))`). Test-only helpers (`_expireNow`, `_ttlOf`, `_listLen`, `calls`) are additive and do NOT alter the production `PendingRedisLike` interface (they're extra members on the fake, not interface methods).

## Interface-compatibility check (extra verification)

The store injects Redis via `PendingRedisLike`, so `npm run build` alone only type-checks the interface, not the real client. I asserted assignability directly (`const x: PendingRedisLike = new Redis(...)`) under the project tsconfig: **no error on `mget`/`pexpire`/`PendingRedisLike`/the assertion** — the real `@upstash/redis` client structurally satisfies the extended interface, including the two new methods. (The only tsc errors surfaced were pre-existing, unrelated failures in `youtube-search.test.ts`, which Next's build excludes — hence the green build.) Real MGET returns records in key order with null for missing, matching the code's index-mapping assumption.

## Folded security check

Internal data-store plumbing on an already-authed moderation path. No new attack surface:
- No user-controlled data reaches a Redis command name; `mget`/`pexpire`/`lrem` take internally-derived keys (`pendingKeys.*`) only — no command-injection vector.
- No DoS amplification: MGET replaces N GETs with ONE round-trip (strictly cheaper); the lazy `lrem` is bounded by the number of null slots per read.
- No data leak: TTL only shortens a rejected orphan's lifetime; rejected entries were already non-authoritative and never enter the frozen queue.
- Fail-open preserved: a thrown Redis error propagates exactly as before (the new calls are plain `await`s in the same code paths; no new swallow/catch that would mask failures, and none removed).

## Conflict-safety

Only `lib/pending-store.ts` + its test are touched. No other open PRs (confirmed no competing in-flight work on this file).

## Follow-ups

None blocking. Optional (NIT, non-blocking): `rejectAllPending` and `reject` issue `set` then `pexpire` as two separate round-trips per item; a future optimization could use a pipeline/`multi` to halve round-trips on bulk reject. Out of scope for this ticket — do not block.
