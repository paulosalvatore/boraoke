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

---

# Opus judgment pass (D-022 second tier) — 2026-07-06

Reviewer agent, opus tier. This is the merge-counting pass. I re-verified tests/build myself on the exact PR head `83ff8c5`, then hunted the seams the sonnet/mechanical passes structurally cannot reach: the fake-vs-real Redis contract, serverless concurrency, driver failure modes, and whether the frozen interface actually carries wave-2. Verdict: **APPROVE**, with mechanical merge-prep conditions for the TM (not code changes) plus one out-of-scope follow-up ticket.

## 1. Fake-vs-real serialization seam — PROBED AGAINST THE REAL CLIENT, holds

The headline risk: does `UpstashStore` behave against real `@upstash/redis` the way `FakeRedis` idealizes? I read the actual installed client (`node_modules/@upstash/redis@1.38.0`, `nodejs.js`) rather than trusting the fake. Findings against the real contract:

- **Write path** (`defaultSerializer`, nodejs.js:560): `string | number | boolean` pass through untouched; every other type → `JSON.stringify(c)`. So `rpush(key, entry)` stores a JSON string of the `QueueEntry`; `set(pausedKey, "1")` stores the bare string `"1"`. The store passes **raw objects/strings, never pre-stringified** → there is NO double-encode. Confirmed by reading every call site in `upstash.ts`.
- **Read path** (`parseResponse` → `parseRecursive`, nodejs.js:60-78): default `automaticDeserialization` is ON. Arrays (LRANGE) map each element through `JSON.parse`; single values (LINDEX/GET) `JSON.parse` directly. So `lrange`/`lindex` return **parsed `QueueEntry` objects** — matches what the store expects.
- **The one real divergence** is `GET` on the paused flag: real client does `JSON.parse("1")` → **number `1`**, NOT string `"1"` (the `parseRecursive` numeric-guard at nodejs.js:67 keeps it as `1` because `(1).toString() === "1"`). `FakeRedis.get` returns the string `"1"`. The store's `isPaused` handles BOTH: `v === "1" || v === 1 || v === true`. This is the exact spot a naive impl would ship broken against prod while green against the fake — the dev anticipated it correctly. Good.
- **QueueEntry round-trip is JSON-safe**: all fields are string / ISO-string / boolean. Optional `undefined` fields (`title`/`table`/`graceRequeue`) are dropped by `JSON.stringify` on write; reading them still yields `undefined` — no consumer breakage. The FakeRedis stores object references (skipping the serialize round-trip), which is a fidelity gap in the abstract but behaviorally identical here because every field is a JSON-safe primitive.

**Verdict on the seam: sound.** Sonnet's NIT #1 (FakeRedis lacks a JSON round-trip) is valid *as hardening* — I'd go further: having `FakeRedis` do `JSON.parse(JSON.stringify(v))` on store AND coerce the paused `"1"`→`1` would lock the `isPaused` number-coercion in as a regression guard. Still non-blocking; I verified the real contract by hand.

## 2. Serverless concurrency — real vs theoretical, split cleanly

- **`addEntry` (RPUSH):** atomic append, no anomaly. The `llen`-then-`rpush` QUEUE_MAX check is a genuine race (N concurrent adds at len 199 all pass → soft over-cap), but `QUEUE_MAX=200` is a DoS soft-guard, not an invariant; a few entries over on a thundering herd is harmless for a bar queue. Acknowledged in-code + security + TICKET-9. **Accept.**
- **`advance` (LPOP + separate LINDEX):** not atomic across the two round-trips, BUT `LPOP` itself is atomic so no entry is ever lost or duplicated. The read-back races are benign: concurrent advances just skip N heads (semantically "skipped twice" on a host double-click); an `addEntry` interleaving in the LPOP→LINDEX gap yields a correct head either way. **Accept.**
- **`removeEntry` / `reorder` (read-modify-write: `lrange` → `del` → `rpush`):** THIS is the one real lost-update window — an `addEntry` or `advance` interleaving a host reorder gets clobbered by the wholesale rewrite from a stale snapshot (patron's just-submitted song vanishes, or a played song reappears). Real. Two mitigants make it proportionate to defer: (a) these ops have **no caller until TICKET-7** (host controls aren't wired — I confirmed the routes only call `getQueue`/`nowPlaying`/`addEntry`/`advance`), so the window is **unreachable on the live path at this merge**; (b) it's documented in-code and scoped to TICKET-9 for an atomic (Lua/pipeline/WATCH) fix. **Accept, flagged for TICKET-9.**

## 3. Driver-selection failure modes — fails loud, no per-request cost

- **`store` is a module-load singleton** (`export const store = createStore()` at `lib/store.ts:39`), evaluated **once per lambda cold start**. There are NO per-request driver checks — item (3)'s cold-start concern doesn't apply; the design is right.
- **Creds missing but upstash selected:** `createUpstashStore()` throws at module import → the route module fails to load → loud 500 on every request. No silent fallback to a divergent driver. Good.
- **Creds present but wrong/unreachable at runtime:** `new Redis({url, token})` is lazy (no validation at construct), so the first command rejects → route `await` rejects → Next.js 500. Fails loud per-request; worst case a request hangs up to the fetch/Vercel function timeout (~10s default) since no explicit `retry`/timeout is configured on the client. **Optional hardening:** pass a retry/timeout to `new Redis()`. Prototype-acceptable as-is.

## 4. Frozen-interface bet for TICKET-10 (rotation) — holds

Can rotation-mode be built over these 9 ops without a full-queue R-M-W per advance? Grace-requeue (move the played head back into the queue instead of dropping it) is expressible as `nowPlaying`/`lindex` (peek) + `advance`/`lpop` (remove) + `addEntry`/`rpush` (re-queue to back) — no full-queue read for a back-append. Precise-position reinsertion would use `reorder` (R-M-W, already shipped). Rotation *display fairness ordering* (interleave by patron) is a read-side computation over `getQueue` — needs no new store op. The `graceRequeue` field is already reserved on `QueueEntry`. So TICKET-10 never reopens `types.ts`. **The freeze is a good bet.** Caveat: an atomic `lpop`-then-`rpush` "pop-and-requeue" primitive is absent, so a naive TICKET-10 requeue inherits the same lost-update class as the host ops — same TICKET-9 atomicity fix covers it.

## 5. Tests / build — re-verified on head 83ff8c5

- `npm test` → **78/78 pass** (3 suites: youtube, api-queue, store). Own run.
- `npm run build` → **compiled clean, 7/7 static pages**, type-check green, routes as expected. Own run.

## Out-of-scope / merge-prep findings (do NOT block the code)

- **A. CI GitHub Action is broken repo-wide (file a follow-up ticket).** `ci.yml`'s `build-and-test` job fails in ~4-5s with **zero steps executed** across *every* ticket (1, 2, 3, 19) — the signature of exhausted GitHub Actions minutes / unavailable runner on this private repo. For PR #7 it produced **no check-run at all**; the only reporting check is **Vercel** (a real preview build + deploy) = SUCCESS. Nothing is GitHub-enforced-required (branch protection is unavailable — private repo without Pro). This is **pre-existing and not introduced by TICKET-6**, so it does not block this PR (I verified test + build green locally on the head + Vercel green — S1 spirit satisfied). But for a "production-reliability core," shipping while the automated test-CI gate is dark is a real reliability gap → **file a follow-up ticket to restore ci.yml** (top up Actions minutes or move CI to a working runner).
- **B. Branch is `DIRTY` (mechanical merge-prep for the TM).** `origin/ticket/6-persistence` is 9 commits behind `origin/main`; `git merge-tree` shows conflicts in **only** `README.md` (TICKET-2 deploy section vs TICKET-6 persistence section — docs) and `work/events/2026-07.jsonl` (append-only event log — always conflicts across parallel branches). **Zero code-file conflicts** — `lib/`, `app/`, tests, `package.json` all merge clean. Resolution is mechanical: rebase/merge main keeping both README sections + union the event log, then merge. Does not change reviewed code semantics.

## Nits (optional, non-blocking) — carried + added

1. (sonnet) FakeRedis JSON round-trip — I'd extend it to also coerce paused `"1"`→`1` to lock in the `isPaused` behavior as a regression guard.
2. (sonnet) `lib/store/memory.ts` lacks `server-only` — belt-and-suspenders; `lib/store.ts` (the enforced import point) already carries it and MemoryStore reads no credentials.
3. (new) Consider `retry`/timeout on `new Redis()` so a misconfigured/unreachable Upstash 500s fast instead of hanging to the function timeout.

## Opus verdict

**[reviewer] APPROVE (D-022 merge-counting).** The fake-vs-real Redis seam I was tasked to adversarially probe holds against the real `@upstash/redis@1.38.0` contract — no double-encode, and the one genuine divergence (paused `GET` coercing to number) is explicitly handled. Hot-path concurrency (RPUSH/LPOP) is safe; the R-M-W host ops carry a real lost-update window but it is dormant until TICKET-7 and correctly scoped to TICKET-9. Driver selection fails loud with no per-request cost. The 9-op interface freeze genuinely carries TICKET-7/9/10. Tests 78/78 + build green on the exact head.

**TM merge conditions (mechanical, not code):** (1) resolve the `README.md` + `work/events/*.jsonl` conflict via rebase/merge-main before merging — zero code conflicts, so the reviewed semantics are unaffected; (2) file a follow-up ticket to restore the broken `ci.yml` Action (repo-wide, pre-existing). Nits 1-3 optional.
