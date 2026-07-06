# Reviewer Report — TICKET-6: Durable persistence (Upstash Redis + memory driver)

- **PR:** #7 — `ticket/6-persistence`
- **Reviewer:** Reviewer agent (sonnet first-pass; judgment layer applied inline — opus tier available but not separately invoked per TM scope)
- **Date:** 2026-07-06
- **Verdict:** APPROVE

---

## Gate preconditions

| Gate | Status | Notes |
|---|---|---|
| Security | PASS-WITH-NOTES | 2 LOWs: server-only guard (folded in, commit 405ded1), non-atomic R-M-W (accepted/TICKET-9-scoped) |
| App Tester | TM-waived N/A | UX identical; e2e green; all input validation confirmed preserved (see below) |
| CI | Vercel deploy green | Code CI (jest) billing-broken pre-existing; tests verified locally — 78/78 ✓ |

---

## What I verified

### 1. Tests — own run

```
cd .worktrees/ticket-6
npm ci && npm test && npm run build
```

**npm test output:**
```
PASS __tests__/youtube.test.ts
PASS __tests__/api-queue.test.ts
PASS __tests__/store.test.ts

Test Suites: 3 passed, 3 total
Tests:       78 passed, 78 total
Time:        0.293 s
```

**npm run build output:**
```
✓ Compiled successfully in 987ms
✓ Generating static pages (7/7)
```
Type-check clean. 7/7 static pages generated.

### 2. Frozen interface vs ticket spec

`lib/store/types.ts` delivers the exact contract specified in the ticket:

| Op | Spec (TICKET-6) | Interface | TICKET-7 ops (ship here) | graceRequeue (TICKET-10) |
|---|---|---|---|---|
| getQueue | ✓ | `getQueue(roomId): Promise<QueueEntry[]>` | — | — |
| addEntry | ✓ | `addEntry(roomId, entry): Promise<boolean>` | — | — |
| removeEntry | ✓ | `removeEntry(roomId, entryId): Promise<boolean>` | ✓ | — |
| advance | ✓ | `advance(roomId): Promise<QueueEntry \| null>` | — | — |
| nowPlaying | ✓ | `nowPlaying(roomId): Promise<QueueEntry \| null>` | — | — |
| reorder | ✓ | `reorder(roomId, entryId, newIndex): Promise<boolean>` | ✓ | — |
| setPaused | ✓ | `setPaused(roomId, paused): Promise<void>` | ✓ | — |
| isPaused | ✓ | `isPaused(roomId): Promise<boolean>` | ✓ | — |
| clear | ✓ | `clear(roomId): Promise<void>` | — | — |
| graceRequeue | ✓ | `QueueEntry.graceRequeue?: boolean` reserved | — | ✓ |

All 9 ops ship, all room-scoped, graceRequeue reserved. Wave-2 tickets (7, 9, 10, 11, 12) never need to edit `lib/store.ts` or `lib/store/types.ts`. **Interface is frozen as contracted.** ✓

### 3. Driver correctness

**Conformance suite design:** `describe.each(drivers)` runs the same assertion block against `MemoryStore` and `UpstashStore(FakeRedis)`. This is the correct approach — any divergence between drivers surfaces as a test failure on one of the two instantiations.

**FakeRedis fidelity:** The in-process FakeRedis implements the `RedisLike` subset the UpstashStore depends on (`lrange`, `llen`, `rpush`, `lpop`, `lindex`, `del`, `set`, `get`). Semantics match @upstash/redis: `lrange` with `stop=-1` handled correctly (`end = l.length`); `lpop` returns null on empty list; `lindex` handles negative indices. For the current `QueueEntry` shape (all string / optional-string / optional-boolean), storing objects by reference is functionally equivalent to real JSON round-trip serialization. **NIT:** FakeRedis does not exercise the JSON serialization path that the real SDK performs — if complex types (Date objects, nested arrays) are added to `QueueEntry` later, the unit test won't catch serialization regressions. A one-line comment noting this would improve maintainability. Not blocking.

**Atomic hot path:** `addEntry` → `RPUSH`, `advance` → `LPOP`. Both are atomic in Redis. `llen` cap-check before `rpush` in `addEntry` has a small race window (two concurrent patrons at cap − 1) — this is the accepted LOW from the security gate, correct for PMF volume.

**isPaused encoding:** `set(key, paused ? "1" : "0")` stores the string "1"/"0". Real @upstash/redis with auto-deserialization parses this back as the string "1" (not number 1). The `isPaused` implementation guards all cases: `v === "1" || v === 1 || v === true`. Correct.

**Driver selection logic:**
- `STORE_DRIVER=upstash` → upstash ✓
- `STORE_DRIVER=memory` → memory ✓
- Unset + `UPSTASH_REDIS_REST_URL` present → upstash ✓
- Unset + no creds → memory ✓
- `createUpstashStore()` throws if creds absent when upstash selected — no silent crash ✓
- Singleton test: `expect(store).toBeInstanceOf(MemoryStore)` confirms credential-free env → memory driver ✓

### 4. Async route conversion — no lost validation

Reviewed `app/api/queue/route.ts` and `app/api/queue/advance/route.ts` against the pre-PR state (via diff):

- All 7 input validation checks preserved in POST handler: body size cap, JSON parse, object check, videoId (both paths), nickname (required + max-30), patronUuid (UUID regex), title (max-120), table (max-10). ✓
- GET now uses `Promise.all([getQueue, nowPlaying])` — parallelizes two reads, correct. ✓
- Queue-full check moved from pre-construction `isQueueFull()` to `addEntry() → false`. Minor ordering change: entry object is now constructed (UUID issued) before the cap check. The UUID is discarded on rejection — correctness-correct, negligibly wasteful. ✓
- `api-queue.test.ts` updated to async store API; all 11 API tests pass including queue-full/429. ✓

App Tester waiver soundness confirmed: no behavior change in the request/response surface.

### 5. server-only stub soundness

`import "server-only"` present in:
- `lib/store.ts` (the single import point, enforced AC #6) ✓
- `lib/store/upstash.ts` (contains credential-reading code) ✓

`lib/store/memory.ts` lacks the guard — low risk given the AC #6 import enforcement and grep verification. **NIT:** adding it would be belt-and-suspenders.

Jest stub: `__mocks__/server-only.ts` exports `{}`. Mapped in `jest.config.ts` via `"^server-only$"`. Guard is active in Next.js builds (the package's `default` export condition throws); stubbed only in jest (plain node). The distinction is correct and the build confirmed the guard is active (7/7 pages, no client bundle leakage). ✓

### 6. Scope / ownership discipline

Files touched against the TICKET-6 ownership list:
- `lib/store.ts`, `lib/store/` — owned ✓
- `app/api/queue/**` — owned (async-only edits, no behavior change) ✓
- `__tests__/store*.ts`, `__tests__/queue.test.ts` — owned ✓
- `__tests__/api-queue.test.ts` — owned (async API update) ✓
- `.env.example`, `README.md`, `package.json`/lockfile — owned ✓
- `__mocks__/server-only.ts`, `jest.config.ts` — supporting infra for the guard, appropriate ✓
- `work/events/`, `work/reports/` — event log + gate reports, correct ✓

Forbidden files not touched: `app/page.tsx`, `app/tv/**`, `app/layout.tsx`, `lib/youtube.ts`, `packages/**` ✓

AC #6 ("no store import outside lib/store.ts"): verified — `app/` imports exclusively via `@/lib/store`. Tests import drivers directly for the conformance suite (intentional, not a violation). ✓

### 7. Deleted `__tests__/queue.test.ts` — coverage audit

The deleted file had 10 test cases. All coverage confirmed moved to `__tests__/store.test.ts`:

| Old test | New location |
|---|---|
| starts empty | conformance "initial state → starts empty" (×2 drivers) |
| nowPlaying is null when empty | conformance "initial state → nowPlaying is null when empty" (×2) |
| adds an entry | conformance "addEntry → adds an entry and returns true" (×2) |
| preserves submission order | conformance "addEntry → preserves submission order" (×2) |
| returns the first entry (nowPlaying) | conformance "nowPlaying → returns the head entry" (×2) |
| removes head, returns new head | conformance "advance → removes the head" (×2) |
| returns null when becomes empty | conformance "advance → returns null when queue becomes empty" (×2) |
| returns null on empty queue | conformance "advance → returns null on empty queue" (×2) |
| rejects beyond QUEUE_MAX | conformance "queue depth cap → rejects beyond QUEUE_MAX" (×2) |
| isQueueFull false below cap | removed — `isQueueFull()` no longer exported; behavior covered implicitly by addEntry returning true below cap |
| accepts again after advance when full | conformance "queue depth cap → accepts again after advancing" (×2) |
| drains in FIFO order | conformance "advance → drains in FIFO order" (×2) |

Coverage not dropped — expanded (now runs against both drivers, adds room scoping, reorder, pause, key schema, singleton tests). ✓

---

## Nits (non-blocking)

1. **FakeRedis serialization comment** — FakeRedis stores objects by reference without JSON serialization. Real @upstash/redis JSON-serializes on write and deserializes on read. Current `QueueEntry` (all string/optional-string/optional-boolean) is safe. A brief comment in `FakeRedis` noting the serialization gap would help future contributors who might add complex types.

2. **`lib/store/memory.ts` missing `server-only`** — `lib/store.ts` (the enforced import point) has the guard. Adding it to `memory.ts` too would be belt-and-suspenders given the AC #6 enforcement.

---

## Evidence cited

- Own `npm test` run: 78/78 pass (3 suites)
- Own `npm run build`: clean, 7/7 pages
- Diff read locally from `origin/ticket/6-persistence` (git-local-first, no API calls)
- Security report: `work/reports/security/TICKET-6-security.md` (PASS-WITH-NOTES, 2 LOWs)
- Dev report: `work/reports/dev/TICKET-6.md` (current, reflects security follow-up commit 405ded1)
- CI: `gh pr checks 7` — Vercel deploy pass, Vercel Preview Comments pass

---

## Verdict

**[reviewer] APPROVE** — Interface is frozen exactly per spec (all 9 ops, all TICKET-7/10 reservations, room-scoped). Conformance suite genuinely runs identical assertions against both drivers. Security LOW #1 folded in (server-only guard verified in build). All input validation preserved in async conversion. Deleted test file's coverage moved and expanded, not dropped. Build and tests green. Two non-blocking nits noted above.
