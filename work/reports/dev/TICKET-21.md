# Dev Report — TICKET-21: Atomic store RMW (lost-update fix)

- **Status:** IMPLEMENTED — CI terminal-green. Draft PR #16. Ready for gates.
- **Product:** cantai
- **Branch:** `ticket/21-atomic-rmw`
- **Worktree:** `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-21`
- **App port (allocated):** 3021 (not needed — no server-facing change; suite is pure-unit)
- **Lane:** `lib/store/**` + this ticket's tests/docs (parallel Dev owns pages/routes/e2e, TICKET-20).

## Problem (from PR #14 opus review §J1)

`UpstashStore`'s read-modify-write ops (`rewrite` for the rotation re-lay, plus `removeEntry`/`reorder`) did a client-side `getQueue` (LRANGE) → compute → `del`+`rpush`. A concurrent `addEntry` (atomic RPUSH) landing between the read and the write-back is **permanently lost** — patron saw "✓ added", song vanished, does not self-heal.

## What @upstash/redis@1.38 actually supports (verified in `node_modules`)

- **EVAL / EVALSHA / EVAL_RO / SCRIPT LOAD + `Script` helper:** yes. `redis.eval(script, keys[], args[])` (`EvalCommand`: `["eval", script, keys.length, ...keys, ...args]`).
- **WATCH:** **NOT supported** — no `WatchCommand`, no `.watch()`. Optimistic locking needs a held connection; Upstash's stateless HTTP REST transport has none.
- **MULTI/EXEC:** only `redis.multi()` → a `Pipeline` with `multiExec: true` — pipelines a **fixed, pre-known** command list. Cannot do read-then-conditional-write CAS.
- **ARGV encoding:** `defaultSerializer` passes `string`/`number`/`boolean` through as-is and `JSON.stringify`s objects. Passing pre-serialized JSON strings round-trips cleanly.

→ The only server-side atomic primitive is **Lua via EVAL**. Rules out the review's hypothesized WATCH/MULTI path.

## Chosen design — merge-on-write, one Lua script (review option (c))

`MERGE_SCRIPT` (`lib/store/upstash.ts`) runs the entire read→merge→write inside one `EVAL`, atomic against every concurrent RPUSH/LPOP by Redis's single-threaded execution. Merge rule:

1. keep the **desired** entries whose id is still present in the current list, in desired order (respects a concurrent advance/remove — a vanished id is NOT resurrected);
2. append every **current** entry whose id was NOT in the caller's `snapshot` — i.e. concurrent appends after the read — preserving them by construction (the fix).

Desired entries are passed as their exact `JSON.stringify` strings and RPUSH'd **verbatim** (Lua decodes only to read `.id`, never re-encodes) → byte-for-byte payload fidelity.

- **`rewrite(roomId, entries, opts?)`** — additive optional `{ snapshot?: string[] }`. With `snapshot` → merge path; without → prior wholesale replace (backward-compatible; `rewrite([])` still empties). Source-compatible for all existing callers.
- **`removeEntry` / `reorder`** — route through the same merge script (client reads, computes filtered/reordered desired, applies with the full read id-set as `snapshot`). 2 commands (LRANGE + EVAL) — **fewer** than the prior 3 (LRANGE + DEL + RPUSH). O(1) round-trips.
- **Memory driver** — single-process (already atomic) but implements the identical suffix-preservation merge in `rewrite(...,{snapshot})`, so one shared conformance suite documents one contract.

Why option (c) over a WATCH-retry loop: WATCH is unavailable (above). A dedicated per-op Lua (remove/reorder as self-contained atomic scripts) was considered but reusing ONE merge script minimizes the emulation surface the FakeRedis test double must mirror.

## Call-site changes (flagged)

- `lib/rotation.ts` `relayQueue` — opts into merge mode: `store.rewrite(roomId, desired, { snapshot: items.map(e => e.id) })`. Additive; within my lane. This is the change that closes the patron-visible lost-submit window.
- `app/api/host/{remove,reorder,skip}/route.ts` — **untouched** (`removeEntry`/`reorder` signatures unchanged; atomicity is internal to the driver).

## Files changed

- `lib/store/types.ts` — `rewrite` gains additive optional `opts.snapshot`; doc for the two modes.
- `lib/store/upstash.ts` — `MERGE_SCRIPT` (exported), `eval` on `RedisLike`, `mergeApply`, atomic `rewrite`/`removeEntry`/`reorder`.
- `lib/store/memory.ts` — `rewrite` merge mode (suffix preservation).
- `lib/rotation.ts` — relay passes `snapshot`.
- `__tests__/store.test.ts` — `FakeRedis.eval` (faithful merge emulation) + new tests.
- `__tests__/rotation-adapter.test.ts` — end-to-end relay concurrency-regression test.
- `README.md` — atomic-writes / no-lost-submits section.

## Test results (local)

```
jest (STORE_DRIVER=memory):  23 suites / 340 tests PASS   (was 325 → +15)
engine (node --test, packages/rotation-engine):  pass 59 / fail 0
npm run build:  clean (Next 15 production build)
```

New tests (+15):
- Store conformance, run against BOTH drivers (memory + UpstashStore-over-FakeRedis) via `describe.each`:
  - `rewrite merge-on-write` (3×2=6): reorder-when-nothing-raced; drops a desired id that vanished concurrently; wholesale mode still empties.
  - **CONCURRENCY REGRESSION** (2×2=4): "preserves a submit that lands between the relay's read and its rewrite" (the exact §J1 failure, deterministically interleaved: read snapshot → inject concurrent addEntry → apply relay); "two racing relays: the earlier reader's stale rewrite keeps the newer submit".
  - host-op races (2×2=4): removeEntry keeps a concurrently-added entry while removing its target; reorder likewise.
- End-to-end (1): `rotation-adapter.test.ts` — a submit racing `relayQueue` (via a stale-snapshot mock) is never lost.

**Concurrency proof:** all four regression assertions fail under the old wholesale rewrite (the injected/late entry is dropped) and pass with the merge — no entry is ever lost.

## Coverage boundary (noted, not blocking)

CI has no Upstash credentials, so the Upstash driver is exercised via an in-process `FakeRedis` whose `eval` faithfully mirrors `MERGE_SCRIPT`'s algorithm on deserialized objects (same limitation the pre-existing driver tests already accept). The Lua itself is minimal and heavily commented to match the JS 1:1; observable behavior is asserted identically on both drivers. A real-Upstash integration test would need provisioned creds (out of scope; no CI secret).

## CI

PR #16 — terminal-green (verbatim `gh pr checks 16` posted to the PR thread):

```
Vercel	pass	0	...	Deployment has completed
Vercel Preview Comments	pass	0	...
build-and-test	pass	2m15s	.../runs/28873478595
```

Required check `build-and-test` green (npm ci → engine node --test 59/59 → npm run build → jest 340 → e2e). Commit: pushed to `origin/ticket/21-atomic-rmw`.
