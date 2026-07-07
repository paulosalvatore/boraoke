# Reviewer Report — TICKET-21: Atomic Store RMW (lost-update fix)

**Reviewer:** Reviewer agent (D-011 opus pass)
**Date:** 2026-07-07
**PR:** #16 — `ticket/21-atomic-rmw` → `main`
**Repo:** paulosalvatore/boraoke
**Verdict:** APPROVE

---

## Gate Preconditions

| Gate | Status | Notes |
|---|---|---|
| CI (build-and-test) | PASS | Green on commits 7f5c0ae + 2958af8 (all code commits); two most recent commits are docs-only (security report + event log) — no code change after last CI pass |
| App Tester | TM-waived N/A | Server-side lib only; no UI/route change |
| Security | PASS | 1 LOW optional finding (SEC-21-01: outer cjson.decode not pcall-guarded); no BLOCKER/HIGH |

CI verified via `gh pr checks 16` (Vercel: PASS) and `gh run list` (build-and-test: success on 2958af8 / 7f5c0ae). Two trailing commits (2e09db0, 27a856e) are security-report and event-log only — no code delta, CI skip is acceptable.

---

## Local Verification (independent)

Run from `/Users/paulosalvatore/Documents/GitHub/cantai/.worktrees/ticket-21`:

```
npm test                   →  23 suites / 340 tests PASS  ✓
node --test (packages/rotation-engine)  →  59/59 PASS     ✓
npm run build              →  clean Next.js production build  ✓
```

All four TICKET-21 concurrency regression assertions pass:
- `CONCURRENCY REGRESSION — preserves a submit that lands between the relay's read and its rewrite` ✓
- `CONCURRENCY REGRESSION — two racing relays: the earlier reader's stale rewrite keeps the newer submit` ✓
- `host-op races — removeEntry removes its target and keeps a concurrently-added entry` ✓
- `host-op races — reorder moves its target and keeps a concurrently-added entry` ✓
- `rotation-adapter — CONCURRENCY REGRESSION: a submit that races the relay is never lost (TICKET-21)` ✓

**Regression proof verified:** Under the old `rewrite` (wholesale replace, `opts` ignored), the deterministic interleaving pattern `read snapshot → inject concurrent addEntry → apply relay` provably drops the injected entry. The new merge-mode RPUSH preserves it. The test injection is structurally valid: `jest.spyOn(store, "getQueue").mockResolvedValueOnce(stale)` for the rotation-adapter test; direct sequential calls for the store conformance tests.

---

## Lua Script Analysis (line by line)

```lua
local key = KEYS[1]
local desired  = cjson.decode(ARGV[1])  -- JSON array of serialized QueueEntry strings
local snapIds  = cjson.decode(ARGV[2])  -- JSON array of id strings

local inSnapshot = {}
for _, id in ipairs(snapIds) do inSnapshot[id] = true end

local current = redis.call('LRANGE', key, 0, -1)
local present = {}
for _, s in ipairs(current) do
  local ok, obj = pcall(cjson.decode, s)
  if ok and obj.id ~= nil then present[obj.id] = true end
end

local out = {}
-- Step 1: keep desired entries whose id is still present (concurrent remove respected)
for _, s in ipairs(desired) do
  local ok, obj = pcall(cjson.decode, s)
  if ok and obj.id ~= nil and present[obj.id] then out[#out + 1] = s end
end
-- Step 2: append current entries not in snapshot (concurrent submits preserved)
for _, s in ipairs(current) do
  local ok, obj = pcall(cjson.decode, s)
  if ok and obj.id ~= nil and not inSnapshot[obj.id] then out[#out + 1] = s end
end

redis.call('DEL', key)
if #out > 0 then redis.call('RPUSH', key, unpack(out)) end
return #out
```

**Merge rule correctness:** Correct. The two-step algorithm is exactly what the types.ts contract documents. No logic errors found.

**Atomicity:** LRANGE + DEL + RPUSH run inside one `EVAL` → Redis single-threaded execution serializes the entire script against every concurrent RPUSH/LPOP. The window is closed by construction.

**Ordering of concurrent appends:** Placed at the END (after the relaid desired order). This momentarily places a concurrent submit out of engine rotation order. However, `relayQueue` is triggered on every queue state change (advance, mode switch, new submit); the next relay re-sorts. Only ENTRY LOSS is fixed; ordering self-heals. Explicitly documented in both the PR and code comments. Acceptable.

**Edge cases:**

| Case | Lua behavior | Verdict |
|---|---|---|
| Empty desired, no concurrent appends | DEL + no RPUSH → empty queue | Correct |
| Empty desired, concurrent appends | Step 1 empty, Step 2 preserves concurrent entries | Correct |
| Desired id vanished (concurrent advance/remove) | `present[obj.id]` false → skipped (not resurrected) | Correct |
| Snapshot ids never in current (all played) | Step 1 empty; new concurrent submits (not in snapshot) appended | Correct |
| Duplicate ids in snapshot | Lua table overwrite → idempotent | Correct |
| `pcall(cjson.decode)` fail on a malformed entry | Entry silently skipped | Acceptable — no user-reachable path to corrupt entries |

**`unpack(out)` stack depth:** With QUEUE_MAX=200, unpack passes at most 200 arguments to RPUSH. Redis's Lua LUAI_MAXCSTACK ≈ 200. Security correctly flagged this as a future concern if QUEUE_MAX is raised materially — appropriate note-and-flag, not a present bug.

**Script verbatim pass-through:** Desired entries are `JSON.stringify`d in TypeScript and pushed into `ARGV[1]` as an array of strings; Lua decodes only to read `.id` and RPUSH'd verbatim. No re-serialization → byte-for-byte payload round-trip. Correct.

---

## FakeRedis.eval Parity Analysis

The FakeRedis fake operates on deserialized objects (matching @upstash's `automaticDeserialization`) while the Lua script operates on raw JSON strings. The abstraction levels differ but the **semantic algorithm is identical**:

| Step | Lua | FakeRedis.eval |
|---|---|---|
| Decode desired | `cjson.decode` each string | `JSON.parse` each element of `args[0]` |
| Build `inSnapshot` | `inSnapshot[id] = true` | `new Set(snapshot)` |
| Build `present` | `present[obj.id] = true` from LRANGE | `new Set(current.map(e => e.id))` from `this.list(key)` |
| Step 1 (keep desired) | `present[obj.id]` check | `present.has(e.id)` check |
| Step 2 (append concurrent) | `not inSnapshot[obj.id]` | `!inSnapshot.has(e.id)` |
| Write back | DEL + RPUSH verbatim strings | `this.lists.set(key, [...kept, ...appended])` |

No semantic divergence found. The fake correctly models the script's atomicity by executing synchronously (no JS event-loop interleave during `eval`).

One minor observation: FakeRedis ignores the `_script` parameter entirely — it always runs the merge algorithm regardless of which script string is passed. This means if the real MERGE_SCRIPT were accidentally swapped with a different Lua script, FakeRedis would not catch it. At the scale of this codebase with one Lua script, this is an acceptable simplification.

---

## Interface Compatibility

- `rewrite(roomId, entries, opts?)` — `opts` is optional → all existing callers unchanged. Diff confirmed: no existing call sites were modified except `relayQueue` in `lib/rotation.ts` (which opts into merge mode, correctly within the same lane).
- `removeEntry` and `reorder` external signatures unchanged; atomicity is internal to the driver.
- API routes (`app/api/host/{remove,reorder,skip}/route.ts`) untouched — confirmed via diff.

---

## Memory Driver Parity

`MemoryStore.rewrite(roomId, entries, opts?)`:
- Without `opts.snapshot`: wholesale replace (unchanged contract).
- With `opts.snapshot`: `kept = entries.filter(e => present.has(e.id))` then `appended = r.queue.filter(e => !inSnapshot.has(e.id))` then `r.queue = [...kept, ...appended]`.

Semantically identical to the Lua two-step. The single-process memory store is already atomic but mirrors the contract so the shared conformance suite (`describe.each(drivers)`) documents one contract across both drivers. Correct design.

---

## EVALSHA / Script Caching

Plain `EVAL` is used on each call (no `EVALSHA` / `SCRIPT LOAD`). The full ~700-character MERGE_SCRIPT string is serialized into each HTTP request to Upstash. At PMF volume with queue depth ≤ 200 and infrequent relay calls, this overhead is negligible. EVALSHA would require a two-phase load+use with NOSCRIPT error-handling and is a reasonable future optimization. **NIT — not blocking.**

---

## PR Overlap Check

- **PR #15** (merged docs): README only. Rebased on; no conflict.
- **PR #17** (`ticket/20-p0-ux-fixes`): diff against main shows zero overlap with `lib/store/**`, `lib/rotation.ts`, or any file touched by TICKET-21. Confirmed via `git diff --stat`.

---

## Findings

| Severity | ID | Location | Summary |
|---|---|---|---|
| NIT | REV-21-01 | `lib/store/upstash.ts` — `mergeApply` | Plain EVAL on each call; no EVALSHA caching. Minor HTTP overhead at PMF volume. |
| NIT | REV-21-02 | `__tests__/store.test.ts` — "host-op races" describe block | Test description says "concurrent submit" but the "concurrent" entry is added BEFORE the host op reads — no actual interleaving. The true concurrent case for host ops is covered by the CONCURRENCY REGRESSION block. Misleading name; correct behavior. |
| LOW (inherited) | SEC-21-01 | `lib/store/upstash.ts` Lua lines 64-65 | Outer `cjson.decode(ARGV[1/2])` not wrapped in `pcall`; unguarded fail → 500 on route. No user-reachable path. Optional hardening only. |

No BLOCKER or HIGH findings.

---

## Verdict

**[reviewer] APPROVE** — The Lua MERGE_SCRIPT is semantically correct, fully atomic by Redis's single-threaded execution, and handles all edge cases correctly. The FakeRedis fake accurately mirrors the merge algorithm at the deserialized-object abstraction level; the shared `describe.each` conformance suite documents one contract across both drivers. The deterministic concurrency regression tests (4 store + 1 rotation-adapter) prove entry loss is eliminated and would fail against the old wholesale rewrite. Local: 340/340 jest, 59/59 engine, build clean. CI green on all code-bearing commits. PR #17 has zero file overlap. All nits are non-blocking.

---

*Evidence relied on: local test run (340 pass), engine test run (59 pass), build (clean), `gh pr checks 16` (Vercel PASS), `gh run list` (build-and-test success), full PR diff (`git diff c84bd5d..origin/ticket/21-atomic-rmw`), dev report (`work/reports/dev/TICKET-21.md`), security report (`work/reports/security/TICKET-21-security.md`), Lua script line-by-line read, FakeRedis.eval side-by-side comparison.*

---
---

# Opus Merge-Counting Pass (D-022 / D-011) — 2026-07-07

**Reviewer:** Reviewer agent (opus second pass — the APPROVE that counts for merge)
**Verdict:** **APPROVE (merge-counting)**

This pass ran the judgment the mid-tier pass could not: it verified the fake-vs-real seam **against the live Upstash store running the actual Lua**, not just the in-process FakeRedis.

## 1. REAL-UPSTASH-VS-FAKE — the marshalling seam (definitive)

The classic failure mode of fake-tested Lua is a driver marshalling mismatch: the seam where `@upstash/redis` might JSON-encode a string ARGV a second time and break `cjson.decode`. Traced both statically and against the real store:

**Static (node_modules trace):**
- `EvalCommand` builds `["eval", script, keys.length, ...keys, ...args]` (`nodejs.js:767`).
- `defaultSerializer` (`nodejs.js:562`) passes `typeof === "string"` values **through verbatim** — it JSON-encodes only non-primitives. `mergeApply` passes `desiredArg`/`snapshotArg` as **strings**, so they hit the wire un-re-encoded. **No double-encoding.**
- The real client's `eval(script: string, keys: string[], args): Promise<TData>` (`error-8y4qG0W2.d.ts:4241`) exactly matches the `RedisLike.eval` signature the store depends on. Contract match confirmed.

**Dynamic (one-time guarded run against the LIVE provisioned Upstash, throwaway key `room:opus-verify-21:queue`, deleted after — running the exact `MERGE_SCRIPT` verbatim):**

| Scenario | Result |
|---|---|
| Concurrency regression — submit races the relay | `["c","a","b","late"]` — late **preserved**, reorder held ✓ |
| Vanished id not resurrected (concurrent remove of `b`) | `["c","a"]` — `b` **dropped**, not resurrected ✓ |
| **Byte-for-byte payload fidelity** — `songTitle: 'Ação — "Olá" \ /x 日本語'`, `nickname: "Zé"` | round-trips **exactly** through EVAL→cjson→RPUSH-verbatim→automaticDeserialization ✓ |
| Empty-result path — `del` without `rpush` | key **gone**, return `0`, no partial-write window ✓ |

The Unicode/quote/backslash round-trip is the decisive proof: the JSON-string-of-JSON-strings ARGV survives `cjson.decode` → `.id` read → verbatim RPUSH → client deserialization with zero corruption. **The seam is closed — real Lua behaves identically to the FakeRedis emulation. NOT a blocker.**

## 2. Failure-mode judgment

- **EVAL availability:** EVAL is a core Redis scripting primitive, supported across Upstash tiers; verified live on the actual provisioned store. If ever unavailable, `redis.eval` throws → the route surfaces a 500 → **fail-loud**, which is correct for a data-integrity op (a 500 is strictly better than a silent lost/corrupted queue).
- **Lua atomicity (all-or-nothing):** confirmed. The whole read→merge→`DEL`→`RPUSH` runs inside one EVAL, serialized by Redis's single thread against every concurrent RPUSH/LPOP. Scenario 4 proves the empty-merge case cleanly empties the key with **no partial del-without-rpush window** visible to any other client (the script is indivisible). Caveat (theoretical, non-blocking): Redis Lua does not roll back a partially-run script on a mid-script *runtime* error — but `RPUSH` of already-validated strings cannot error, and `unpack(out)` is bounded by `QUEUE_MAX` (a small karaoke queue), so no Lua-stack overflow. Practically safe.

## 3. Ordering-at-END concession (one real bar scenario)

Patron C submits a song while a relay is mid-flight: C's entry is durably RPUSH'd, then re-appended at the queue **tail** by the merge (rather than slotted into its fair rotation position, because the relay computed order from a snapshot that predates C). Relays fire on every submit/advance, so the **next** relay re-sorts C into fair position — self-correcting within ≤1 poll cycle. The entry is **never lost** (the property that matters). No patron-visible injustice beyond a sub-second ordering delay. Concession is sound.

## 4. Architectural coherence — MERGE_SCRIPT-for-everything

Judged, not redesigned: routing all three ops (`rewrite`/`removeEntry`/`reorder`) through one merge script is the **right long-term shape** here. All three are genuinely the same shape — read → compute the desired list **client-side** (the engine-fairness order the server cannot recompute) → atomic merge-write — so a single generic merge is the natural primitive, not an over-generalization. One script also minimizes the FakeRedis emulation surface (one algorithm to mirror across both drivers), a real maintainability win. Per-op native scripts (e.g. `LREM`-by-id) would be marginally more bandwidth-efficient but multiply the test-double surface for no correctness gain. Coherent.

## 5. Tests / build (independently re-verified)

`STORE_DRIVER=memory npx jest` → 23 suites / **340 pass**; `node --test` (packages/rotation-engine) → **59 pass**. Build is CI-verified green: the `build-and-test` run (28873705494) passed on commit `2958af8`, and `git diff 2958af8..HEAD` touches **only** `work/reports/**` + `work/events/**` — zero code delta, so the green run fully represents the code at HEAD `f22dfcf` (S1 satisfied).

## Merge-prep note (non-code, for the TM)

`gh pr view` reports `mergeStateStatus: DIRTY`. `git merge-tree` confirms the **only** conflict is `work/events/2026-07.jsonl` — the append-only framework event log (both `main` and this branch appended). **All code and doc files merge cleanly.** This is a mechanical, recurring event-log conflict; the TM resolves it (union both appends) as merge prep — it does not affect code correctness or this verdict. Class-level suggestion: add a `merge=union` `.gitattributes` entry for `work/events/*.jsonl` to auto-resolve this recurring conflict.

## Opus findings

No new BLOCKER or HIGH. Concurs with the first-pass nits (REV-21-01 EVALSHA caching; REV-21-02 test label; SEC-21-01 unguarded outer `cjson.decode`) — all non-blocking, carry as optional follow-ups.

**[reviewer] APPROVE (opus merge-counting)** — code correct and provably atomic against concurrent RPUSH, fake-vs-real seam **closed by live-store verification** (incl. byte-for-byte payload fidelity), failure modes fail-loud, ordering concession sound, architecture coherent, tests bite (340/59, CI-green). One non-code merge-prep item: resolve the `work/events` event-log conflict before merge.
