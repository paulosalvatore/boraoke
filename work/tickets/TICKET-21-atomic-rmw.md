# TICKET-21 — Atomic store RMW (lost-update fix)

- **Product:** cantai
- **Priority:** HIGH
- **Origin:** PR #14 opus review follow-up (`work/reports/review/TICKET-10-review.md`, "Opus merge-counting pass" §J1 + Follow-ups)
- **Owner lane (this wave):** `lib/store/**` (+ this ticket's tests/docs). A parallel Dev owns pages/routes/e2e (TICKET-20). Store-signature changes that force a mechanical call-site edit are kept minimal and flagged.

## Problem

`QueueStore`'s read-modify-write ops on the **Upstash** driver (`rewrite`, `removeEntry`, `reorder`) are non-atomic: each does a client-side `getQueue` (LRANGE) → compute → `del` + `rpush`. A concurrent `addEntry` (atomic RPUSH) that lands **between** a relay's `getQueue` and its `del`+`rpush` rewrite is **permanently lost** — the patron saw "✓ Song added" and their song silently vanishes. This is patron-visible and does NOT self-heal (unlike misordering).

Precise mechanic (from the opus review §J1):

```
R1 addEntry(A)                 store=[…,A]
R1 relay.getQueue → S1=[…,A]   (B not yet present)
R2 addEntry(B)                 store=[…,A,B]   (B durably in, 201 sent to B)
R2 relay.getQueue → S2=[…,A,B]
R2 relay.rewrite(order(S2))    store=[ordered A,B]
R1 relay.rewrite(order(S1))    store=[ordered …,A]   ← B GONE (permanent)
```

The same window exists on `removeEntry`/`reorder` (pre-existing, security-accepted): each was `getQueue`→`del`+`rpush`, so a concurrent append between the read and the write is dropped, and a host op racing `advance` (atomic LPOP) could resurrect or lose entries.

## What @upstash/redis@1.38 actually supports (verified in node_modules)

- **EVAL / EVALSHA / EVAL_RO / SCRIPT LOAD:** yes (`EvalCommand`, `EvalshaCommand`, `ScriptLoadCommand`, plus the `Script` helper). `redis.eval(script, keys[], args[])`.
- **WATCH:** **NOT supported.** No `WatchCommand`, no `watch` on the client. WATCH-based optimistic locking is fundamentally incompatible with Upstash's stateless HTTP REST transport (each request is an independent connection — there is no session to hold a WATCH across).
- **MULTI/EXEC:** only as `redis.multi()` → a `Pipeline` with `multiExec: true` (transactional pipelining of a *fixed, pre-known* command list). It cannot do read-then-conditional-write CAS, so it does not solve the lost update.

**Conclusion:** the only server-side atomic primitive available is a **Lua script via EVAL**. Design within that reality (rules out option (b) WATCH/MULTI).

## Chosen design — merge-on-write via a single Lua script (option (c))

One documented Lua merge script (`MERGE_SCRIPT` in `lib/store/upstash.ts`) applied atomically server-side. The client sends the **desired ordering** (computed client-side — the engine fairness order the server can't recompute) plus the **snapshot id-set** it read. The script, atomically:

1. reads the CURRENT list fresh (inside the atomic EVAL);
2. keeps the desired entries whose id is **still present** in the current list, in desired order (this respects concurrent removals/advances — a vanished id is dropped, not resurrected);
3. appends any current entry whose id was **NOT in the snapshot** — i.e. concurrent appends that landed after the caller's read — preserving them by construction (the lost-update fix);
4. `DEL` + `RPUSH` the merged result.

Because step 1–4 run inside one EVAL, Redis's single-threaded execution serializes it against every concurrent `addEntry` (RPUSH) — the append is either fully before (seen in step 1) or fully after (untouched). **No entry can be lost.** O(1) round-trips.

- `rewrite(roomId, entries, opts?)` gains an **additive optional** 3rd param `{ snapshot?: string[] }`. With `snapshot` → merge path. Without → the prior wholesale replace (backward-compatible; `rewrite([])` still empties). `relayQueue` opts in by passing `{ snapshot: items.map(e => e.id) }`.
- `removeEntry`/`reorder` route through the same merge script: client reads, computes desired (filtered / reordered), calls the merge with the full read id-set as `snapshot`. The removed/moved entry is classified correctly (in snapshot → not a concurrent append), concurrent appends preserved. 2 commands (LRANGE + EVAL) = O(1), fewer than the prior 3.
- **Memory driver:** single-process so already atomic, but implements the **same suffix-preservation** merge in `rewrite(..., {snapshot})` so tests document the identical contract across both drivers.

Verbatim JSON fidelity: desired entries are passed to EVAL as their exact `JSON.stringify` strings and RPUSH'd **verbatim** (Lua decodes only to read `.id`; it never re-encodes), so payloads round-trip byte-for-byte through the store.

## Requirements / acceptance

- `QueueStore` stays source-compatible for callers (params extended additively only). ✓ additive `opts` on `rewrite`.
- Conformance tests for **both** drivers, including a **CONCURRENCY REGRESSION** test that deterministically simulates append-during-relay (interleave the injectable fake's ops) proving no entry is ever lost.
- Host-op races (`removeEntry`/`reorder` racing append/advance) covered by the same mechanism + tests.
- Performance stays O(1) round-trips.
- `lib/rotation.ts` relay call updated (signature changed additively — relay opts into merge).
- README / JSDoc updated.

## Out of scope

Pages, API route bodies (beyond none-needed), other libs, e2e. The `patronUuid`-on-public-GET griefing item (carried Security LOW) is a separate ticket.
