# Security Report — TICKET-21 Atomic Store RMW (PR #16)

**Auditor:** Cyber Security agent
**Date:** 2026-07-07
**PR:** #16 — `ticket/21-atomic-rmw`
**Verdict:** PASS

---

## Scope

Files audited from the PR diff (`git diff c84bd5d..origin/ticket/21-atomic-rmw`):

- `lib/store/upstash.ts` — new `MERGE_SCRIPT` Lua constant + `mergeApply` private method; changes to `removeEntry`, `reorder`, `rewrite`
- `lib/store/memory.ts` — semantic mirror of merge-on-write for MemoryStore
- `lib/store/types.ts` — interface extension (new `opts.snapshot` param)
- `lib/rotation.ts` — `relayQueue` updated to pass `snapshot` option
- `__tests__/store.test.ts` — conformance suite running against both drivers
- `__tests__/rotation-adapter.test.ts` — relay integration tests

Blast-radius code read (not diffed, for context):
- `app/api/host/reorder/route.ts`, `app/api/host/remove/route.ts`, `app/api/queue/route.ts` — API callers; confirm no external snapshot exposure

---

## Checklist

### (1) Lua injection

**Result: CLEAN**

`MERGE_SCRIPT` is a static string constant declared at module scope (`lib/store/upstash.ts:62`). It is never concatenated with or interpolated from user-controlled data. The script body is fixed.

User data enters only via `ARGV[1]` and `ARGV[2]`, which are JSON strings produced by `JSON.stringify()` in `mergeApply` (`upstash.ts:209-210`):

```
desiredArg = JSON.stringify(desired.map((e) => JSON.stringify(e)))
snapshotArg = JSON.stringify(snapshot)
```

Both are passed as data arguments to `EVAL`, not concatenated into the script body. This is the canonical Lua-safe pattern for EVAL — no Lua injection surface exists.

The queue key is passed as `KEYS[1]` (correct Redis Lua practice for cluster-compatible key references), not interpolated into the script.

### (2) JSON decode error modes in the Lua script

**Result: LOW (INFO-grade in practice)**

The Lua script has two decode strategies:

- `cjson.decode(ARGV[1])` and `cjson.decode(ARGV[2])` at `upstash.ts:64-65` — **NOT** wrapped in `pcall`. A decode failure here throws a Lua error, which Redis propagates as an EVAL error. In TypeScript this surfaces as a thrown `Error` from `this.redis.eval(...)`, which Next.js would render as an HTTP 500 on the affected route.

- `pcall(cjson.decode, s)` for per-element decodes of `desired` and `current` entries — correctly guarded. A malformed entry is silently skipped rather than aborting the script.

**Why this is INFO rather than exploitable:** `ARGV[1]` and `ARGV[2]` are always produced by `JSON.stringify()` on valid TypeScript strings/objects. No code path allows user-supplied text to substitute for `desiredArg` or `snapshotArg` — the values derive entirely from in-memory `QueueEntry[]` and `string[]` arrays that already passed through the store's own read. A corrupt value is only reachable if `JSON.stringify` itself malfunctions (a Node.js bug, not an attacker path). No exploit path exists through normal use.

**Remediation direction (optional hardening):** Wrapping the outer decodes in pcall with an explicit error return would make the script defensively complete and improve debuggability — not required for PASS.

### (3) Resource bounds / ARGV size attack

**Result: CLEAN**

Script time complexity is O(N) in queue length where N ≤ `QUEUE_MAX` = 200. With LRANGE, two linear scans, and a DEL+RPUSH, the server-side blocking time is bounded and well within safe single-threaded Redis latency.

`ARGV[1]` bound: 200 entries × max serialized entry size. QueueEntry fields are all validated upstream (`MAX_NICKNAME=30`, `MAX_TITLE=120`, `MAX_TABLE=10`, `videoId` is a validated YouTube ID, `patronUuid` is UUID-pattern validated, `mode` is an enum). Maximum realistic ARGV[1] is under 100 KB; Upstash's 1 MB EVAL argument limit is not in reach.

`ARGV[2]` (snapshot) bound: 200 × 36 chars per UUID = 7,200 bytes max.

No external API endpoint accepts a raw `snapshot` array from user input. All callers of `rewrite(roomId, entries, { snapshot })` in the codebase derive the snapshot from a live store read in the same function:
- `lib/rotation.ts:231` — `items.map((e) => e.id)` from `store.getQueue()`
- `lib/store/upstash.ts` — `removeEntry` and `reorder` build snapshot from `lrange` result internally

An attacker cannot inject an oversized snapshot through any exposed API surface.

One Lua note: `redis.call('RPUSH', key, unpack(out))` uses Lua 5.1 `unpack` with up to 200 elements. This is well within the Redis Lua stack limit (LUAI_MAXCSTACK ≈ 200). If `QUEUE_MAX` is raised materially above 200 in a future ticket, the RPUSH call should be split into batched calls or the Lua script updated to use a loop. Flag for consideration at that time.

### (4) Removed-entry resurrection via stale snapshot

**Result: CLEAN — merge rule correctly prevents resurrection**

The merge algorithm's Step 1 filters desired entries by `present[obj.id]`, where `present` is built from `redis.call('LRANGE', key, 0, -1)` — the CURRENT live queue contents at the moment the Lua script runs atomically, not from the caller's snapshot.

Scenario: relay reads queue=[A, B, C], computes desired=[B, A, C]. Host concurrently removes B (queue becomes [A, C]). Relay then calls `mergeApply(key, [B, A, C], [A, B, C])`.

Lua execution (atomic, after remove):
- `current` = [A, C]; `present` = {A, C}
- Step 1: B not in present → skip; A in present → keep; C in present → keep. `out` = [A, C]
- Step 2: A and C are both in snapshot → no stray appends. Final = [A, C]. ✓

The removed entry B is not resurrected by any stale relay or concurrent caller. The script's atomicity (single-threaded Redis execution) makes this guarantee tight.

The `removeEntry` method correctly includes the removed entry in its snapshot (`queue.map((e) => e.id)` before filtering), so even in the degenerate case where another path concurrently re-adds an entry with the same ID (impossible with UUID v4, but correct by design), Step 2 would not re-append it.

### (5) Memory-driver parity

**Result: CLEAN**

`MemoryStore.rewrite` with `opts.snapshot` implements the identical merge contract as the Lua path (`memory.ts:86-101`):
- `kept = entries.filter((e) => present.has(e.id))` mirrors Step 1
- `appended = r.queue.filter((e) => !inSnapshot.has(e.id))` mirrors Step 2
- `r.queue = [...kept, ...appended]` is the final assignment

The shared conformance suite in `__tests__/store.test.ts` runs both drivers against the same test cases, providing continuous parity verification. Test honesty is intact: FakeRedis in tests emulates the merge algorithm synchronously (modeling atomicity correctly for single-process tests).

### (6) Secrets / log leakage

**Result: CLEAN**

- `lib/store/upstash.ts` has `import "server-only"` at line 1 (enforced by Next.js bundler to prevent client-side exposure of Redis credentials).
- Credentials are read from env vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) and passed directly to the Upstash constructor. No logging of credential values.
- No `console.log`, `console.error`, or similar calls anywhere in the diff that would expose queue contents, entry data, or credentials.
- The error message on missing env vars (`createUpstashStore`, line 234) only reveals variable names, not values.

### (7) npm audit delta

**Result: CLEAN — no package changes in this PR**

`package.json` and `package-lock.json` are unchanged in the diff. The 2 moderate severity vulnerabilities (postcss < 8.5.10 / next) pre-exist this PR and are a breaking-change fix only (`npm audit fix --force` would downgrade to Next 9.3.3). No new dependencies introduced.

---

## Test Verification

Suite run locally against `origin/ticket/21-atomic-rmw`:

- **Unit:** 340 passed / 340 total (23 suites) — matches expected count
- **E2E (Playwright):** 18 passed / 18 total
- **CI (GitHub Actions `build-and-test`):** pass — confirmed via `gh pr checks 16`

---

## Findings Summary

| Severity | ID | Location | Summary |
|---|---|---|---|
| LOW | SEC-21-01 | `lib/store/upstash.ts:64-65` (Lua) | Outer `cjson.decode(ARGV[1/2])` not wrapped in `pcall`; unguarded decode failure → 500 on affected route. Not exploitable via user input. |

No BLOCKER or HIGH findings.

---

## Verdict: PASS

The Lua script is static, data flows correctly through ARGV (not script interpolation), the merge rule is semantically sound and proved resurrection-safe, resource bounds are enforced by QUEUE_MAX, no secrets are logged, npm audit has zero delta, and all 340 unit + 18 e2e tests pass with CI green. SEC-21-01 is a low-severity defensive hardening note with no real-world exploit path — it does not block merge.
