# TICKET-56 Review — Atomic `rejectAllPending` via Lua EVAL (+ folded Cyber)

Reviewer: opus (D-022 merge-counting pass). Also folds the Cyber-Security gate (the change touches a data-store teardown path with no new network/auth surface, so a separate Cyber pass was not spawned).
Branch: `ticket/56-lua-reject-all-pending` · Worktree `.worktrees/ticket-56` · Base `origin/main` @ `9470051`
Commit under review: `87709d5` (the delta pass re-verified against this SHA; pass 1 reviewed the identical content as an uncommitted working tree).

## Verdict: APPROVE-WITH-FOLLOWUPS (opus merge-counting) — folded Cyber-Security: PASS

Recorded across two passes: **pass 1 — APPROVE-WITH-FOLLOWUPS** (6 follow-ups, no blockers), **pass 2 — CONFIRMED** (delta-only confirmation after the TM-selected subset was applied, 1 new NIT, no blockers). The change does exactly what the ticket asks, preserves every observable property I could test, and its central claim is backed by a test I empirically verified fails against the old code.

## Pass 1 — full review (uncommitted working tree, 2 files)

Scope: `lib/pending-store.ts`, `__tests__/pending-store.test.ts`. No untracked files.

### Gates reproduced independently (not trusting the Dev summary)

| Gate | Command | Observed |
|---|---|---|
| Tests (post-change) | `npx jest` | **42 suites / 599 tests passed, exit 0** |
| Build | `npx next build` | **exit 0**, full route table emitted |
| Baseline (pre-change) | old `lib/pending-store.ts` + old test file restored from `HEAD` into a scratch copy | **42 suites / 594 passed** |

**594 → 599 = +5**, matching exactly the 5 new `it(` blocks in the diff. No `.skip` / `.only` / `xit` / `it.todo` anywhere in `__tests__/pending-store.test.ts`; nothing silently disabled. No pre-existing assertion deleted or weakened — the diff only adds, plus widens the `FakeRedis.calls` counter object. Dev's claimed numbers are accurate.

### Acceptance criteria — each verified independently

**AC1 — one atomic EVAL, no lost-update window. PASS.** `lib/pending-store.ts:351-355` issues a single `redis.eval`; the whole LRANGE→GET→SET→PEXPIRE cycle lives inside `REJECT_ALL_PENDING_SCRIPT`, so Redis's single-threaded execution serializes it against every concurrent `take`/`add`/`reject`. The client-side read-modify-write is gone from the happy path.

**AC2 — observable semantics preserved exactly. PASS**, each checked against the script body: returns the count via `flipped`, coerced `Number(flipped) || 0`; idempotent via the `obj.status == 'pending'` guard (proven by the *unmodified* shared-contract test "…returns the count, is idempotent"); room-scoped, since both `KEYS[1]` and the ARGV prefix derive from the same `roomId` (the unmodified contract test `__tests__/pending-store.test.ts:311-322` still passes); never approves and never deletes queue entries, since the script issues only `GET`/`SET`/`PEXPIRE`/`LREM` with no `DEL` and a prefix hardcoded to `room:<id>:pending:item:`; TTL applied via `PEXPIRE itemKey, ttl` with `REJECTED_PENDING_TTL_MS` passed as ARGV[2]; lazy index-prune not regressed, via `raw == false → LREM`, matching `listRoom`'s null-slot prune at `:300-305`.

**AC3 — `MemoryPendingStore` byte-identical, interface unchanged. PASS.** Zero diff hunks in `MemoryPendingStore` (`:123-201`). `PendingStore` unchanged; only the driver-internal `PendingRedisLike` gained a member. The `describe.each` shared-contract block runs unmodified against both drivers.

**AC4 — `eval` mirrors `RedisLike`; `FakeRedis` follows the `MERGE_SCRIPT` precedent. PASS.** `PendingRedisLike.eval` (`:52`) is signature-identical to `RedisLike.eval` at `lib/store/upstash.ts:109`. The `FakeRedis.eval` emulation mirrors the existing `__tests__/store.test.ts:99-126` pattern down to the docblock structure and the "synchronous execution models server-side atomicity" rationale — the house precedent, not an invented one. On the specific concern about the pre-existing `pexpire === 2` case (`:366-379`): it is **still meaningful**, because the emulated script calls `this.pexpire(...)` per flip so the counter reaches 2 through the new path, and the test additionally asserts real TTL values via `_ttlOf`. Not trivially satisfied.

**AC5 — error posture. PASS with caveat (FU-1/FU-2).** `catch` → `rejectAllPendingUnsafeFallback`. No double-count is possible: the fallback re-reads live state and only flips entries *still stored* as `"pending"`, so a partially-applied script followed by the fallback converges to the same state and cannot undo or over-count.

**AC6 — test quality (are the new tests vacuous?). PASS, proven empirically — see the falsification runs below.**

**AC7 — comment style, no ticket numbers in code. PASS.** Every ticket reference in the file (`TICKET-44`, `TICKET-49`, `TICKET-53`) sits on a pre-existing line. The diff introduces **zero** new ticket numbers; the new docblocks cite `MERGE_SCRIPT` / `lib/store/upstash.ts` by name instead. Correct per the framework rule.

## Empirical falsification runs (the evidence the tests are not vacuous)

Both runs were executed in a scratch copy under `/tmp` (rsync of the worktree, symlinked `node_modules`), never by mutating the worktree. Both scratch copies were removed afterwards.

**Run 1 (pass 1) — new tests against the OLD implementation.** Restored `git show HEAD:lib/pending-store.ts` over the new test file. Result: **31 passed / 1 failed**, failing at `expect(fake.calls.eval).toBe(1)` — "Expected: 1, Received: 0". The one-eval-round-trip test genuinely discriminates the new behaviour; it is not vacuous.

**Run 2 (pass 2) — the new `console.warn` assertion against a warn-stripped implementation.** Removed *only* the `console.warn(...)` call from `lib/pending-store.ts`. Result: **31 passed / 1 failed**, failing at `:462 expect(warn).toHaveBeenCalled()` — "Expected number of calls: >= 1, Received number of calls: 0". The FU-2 assertion is real.

Noted for the record: the other four new tests pass against the old code *by design* — they are semantics-preservation regression guards, which is precisely what AC2 asks for. Also noted: no test exercises an actual concurrent interleaving; atomicity is *modelled* by the fake's synchronous `eval` rather than demonstrated. That is the same limitation the existing `MERGE_SCRIPT` tests carry, so it is consistent with the codebase, not a regression.

## Folded Cyber-Security gate: PASS

Scope: no new network, auth, or input surface. The route (`app/api/host/moderation/route.ts:16-22`) still validates `roomId` and enforces `requireHost` before anything reaches the store.

**Lua injection — no primitive exists.** `REJECT_ALL_PENDING_SCRIPT` is a static module constant; `roomId` never enters the script *text*, arriving only as `KEYS[1]` and `ARGV[1]`. There is no string interpolation into the program, so injection is structurally impossible rather than merely unlikely.

**Prefix escape / cross-room access — not possible, three independent barriers.** First, `roomIdFromRequest` → `isValidRoomId` → `ROOM_ID_RE = /^[a-z0-9-]{1,64}$/` (`lib/rooms.ts:112`): a room id **cannot contain `:`**, the key separator, so it cannot synthesize a key boundary — and `lib/rooms.ts:109-110` shows this is an already-recognized security invariant. Second, even ignoring validation, `KEYS[1]` and `ARGV[1]` derive from the *same* `roomId` string, so they are structurally incapable of straddling two rooms; a crafted id lands both the index and the item prefix in the same (possibly novel, but self-consistent) namespace. Third, the ids concatenated onto the prefix are not attacker-supplied — they come from that room's own index, server-generated by `generatePendingId` (base36 + alphanumeric tail).

**Blast radius bounded.** The script's only writes are `SET`/`PEXPIRE` on `room:<id>:pending:item:*` and `LREM` of dead ids from the index. There is **no `DEL`** anywhere in the script, and because the prefix always ends in `:pending:item:` it structurally cannot reach the queue keyspace `room:<id>:queue`. Destructive-by-design (per the ticket) and confined to the intended keyspace.

**Undeclared-KEYS deviation — acceptable here.** `MERGE_SCRIPT` (`lib/store/upstash.ts:63-65`) touches only `KEYS[1]`; this is the repo's first script deriving keys from an ARGV prefix. Correct and safe on the single-node Upstash deployment this app uses (`createUpstashPendingStore`, `:414-423`); it would violate Redis Cluster cross-slot rules if the keyspace ever moved to a clustered deployment. Now documented in code — see FU-3.

**DoS.** The script is O(N) *blocking* on Redis's single thread, N = index length (pending plus not-yet-expired rejected entries). Bounded by `pendingRoomMax()` (default 100) plus the 10-minute rejected TTL — low hundreds realistically, sub-millisecond. Not a live risk. Now documented in code — see FU-4.

**No security findings that block.**

## Dev-declared risks — adjudicated

**Prefix-vs-KEYS.** Safe on this deployment and injection-proof (reasoning above); the cluster caveat was undocumented in code at pass 1, which became FU-3.

**Lost-EVAL-response → fallback re-runs and returns 0 though the flip happened.** **Confirmed telemetry-only, caller traced.** `rejectedPending` (`app/api/host/moderation/route.ts:48-51`) flows *only* into `track("host_action", { props: { …, rejectedPending } })` (`:54-62`); the HTTP response is `{ ok: true, moderation: raw }` (`:64`), so the count never reaches the client. No user-visible or control-flow dependency. The re-run itself is safe: entries are already `rejected`, so it correctly returns 0 with no state corruption. Acceptable.

**cjson re-encode reordering keys / coercing future numeric fields.** **No live risk today, verified at the type level.** `PendingEntry` (`lib/pending-types.ts`) is `pendingId`/`roomId`/`status`/`createdAt` — all strings — plus `entry: QueueEntry`, which (`lib/store/types.ts:15-31`) is `id`, `videoId`, `title?`, `nickname`, `patronUuid`, `table?`, `mode`, `submittedAt` (all strings) and `graceRequeue?: boolean`. **Zero numeric fields**, no nullable fields, no empty-collection fields — so neither `%.14g` float coercion nor an ambiguous `{}` array/object round-trip is reachable. Key reordering is irrelevant since every consumer `JSON.parse`s. The docblock already states the invariant, which is the right mitigation; FU-5 would have made it enforceable.

## Follow-ups and their dispositions

**FU-1 [MED] — "never throws" guarantee overstated; fallback unprotected.** The original comment claimed "a Redis/EVAL blip must not fail the host's toggle", but `rejectAllPendingUnsafeFallback` is not itself wrapped: on a genuine Redis outage its `listRoom` throws and `rejectAllPending` propagates, 500-ing the route *after* `setRoomModeration` already committed the toggle. Pre-existing, non-regressive behaviour. **Disposition: comment half APPLIED** (`:372-381` now scopes the claim to an EVAL-specific blip and states explicitly that a full Redis outage still surfaces, unchanged from pre-script behaviour). **Behavioral half (wrapping the fallback) DEFERRED to the board by TM decision.**

**FU-2 [MED] — bare `catch {}` was silent; a permanent EVAL failure would degrade forever with no signal. Disposition: APPLIED.** `catch (err)` + `console.warn("[pending-store] bulk-reject EVAL failed — falling back to the NON-ATOMIC loop (lost-update window reopened)", err)` at `lib/pending-store.ts:387`, with a `jest.spyOn(console, "warn")` assertion added to the existing fallback test. The Dev's rejection of `track(...)` is accepted: it takes a fixed `TelemetryEventName` enum and importing `lib/telemetry` into the store would couple the layers; `console.warn` matches the in-repo precedent (`app/api/queue/advance/route.ts`).

**FU-3 [LOW] — document the prefix-derived-keys / Redis Cluster caveat and the deliberate `MERGE_SCRIPT` divergence. Disposition: APPLIED.** `NOTE —` paragraph at `lib/pending-store.ts:229-234`. Technically accurate.

**FU-4 [LOW] — document the O(N) server-blocking cost vs the old O(N) non-blocking round-trips. Disposition: APPLIED.** `COST —` paragraph at `lib/pending-store.ts:236-241`, including the correct framing of N as "pending plus not-yet-expired rejected entries" and the `PENDING_ROOM_MAX` caveat.

**FU-5 [LOW] — pin the cjson-safety invariant with a test, not just a comment.** The lossless-round-trip claim rests entirely on `QueueEntry` having no numeric fields; a test asserting the persisted shape is string/boolean-only would fail loudly the day someone adds e.g. `durationSeconds: number`, instead of silently reformatting it through Lua's `%.14g`. **Disposition: DEFERRED to the board by TM decision.**

**FU-6 [NIT / process] — durable record missing.** At pass 1 there was no `work/tickets/TICKET-56-*.md` and no dev report. **Disposition: SATISFIED** by `work/tickets/TICKET-56-lua-reject-all-pending.md` and `work/reports/dev/TICKET-56-dev-report.md` (both in `87709d5`), and by this review file.

**FU-7 [NIT] (new, from the delta pass) — spy restore is not failure-safe.** `warn.mockRestore()` is the last statement of the test body (`__tests__/pending-store.test.ts:476`) rather than in a `finally` or `afterEach`, and `jest.config.ts` sets no `restoreMocks`. If any assertion on lines 460-475 throws, the spy leaks for the remainder of that module's run. **Assessment: it cannot manufacture a false green** — the blast radius is limited to silencing `console.warn` on a run that is *already red*, and no other test asserts on `console.warn`. **Disposition: filed as a board follow-up, NOT a blocker**; the fix is `restoreMocks: true` in `jest.config.ts`.

## Pass 2 — delta-only confirmation: CONFIRMED

Verified against `87709d5` after the TM-selected subset was applied. The source delta versus the pass-1 content is confined to comment paragraphs plus `catch (err)` and the `console.warn`: I compared the script body, the `try` block, `Number(flipped) || 0`, and `rejectAllPendingUnsafeFallback` and all four are **byte-identical** to the version approved in pass 1. The test file still contains exactly 5 new `it(` blocks with no new or removed `describe`.

**Warn fires on the fallback path only — confirmed two ways.** It is the *only* `console.warn` in the file and sits lexically inside the `catch`, so the happy path structurally cannot reach it. Empirically, a full 599-test run grepped for `[pending-store] bulk-reject` produced **0 hits**; every happy-path test runs against an unmocked `console.warn`, so any leak would have printed. No log noise on a normal ON→OFF toggle.

**Gates re-reproduced on the delta:** `npx jest` → **42 suites / 599 tests passed** (unchanged); `npx next build` → **exit 0**. Matches the Dev's claim.

## Commit-message accuracy — flagged, record-correcting note

The commit body of `87709d5` **misdescribes the mechanism**. It says the change consolidates "the check (key exists, not in rejected set) and state transition (add to rejected set) into a single atomic Lua EVAL", and refers to "concurrent `rejectAllPending` calls" colliding. **There is no rejected set.** The script flips `status` to `"rejected"` in place on each item key (`SET itemKey, cjson.encode(obj)`) and applies `PEXPIRE` with `REJECTED_PENDING_TTL_MS`; the index list is left intact so patron polls still surface the rejections. The race actually closed is between `rejectAllPending` and concurrent `take`/`add`, not between concurrent `rejectAllPending` calls.

The **code and its docblocks are correct** — only the commit wording is wrong. It was not amended because the sanctioned commit mechanism never force-pushes. This note exists so the durable record is not misleading; anyone reading `git log` for TICKET-56 should read the docblock at `lib/pending-store.ts:207-252` instead.

## Evidence relied on

Direct reads of `lib/pending-store.ts`, `__tests__/pending-store.test.ts`, `app/api/host/moderation/route.ts`, `lib/pending-types.ts`, `lib/store/types.ts`, `lib/rooms.ts`, `lib/host-auth.ts`, `lib/store/upstash.ts` (the `MERGE_SCRIPT` precedent) and `__tests__/store.test.ts` (its `FakeRedis.eval` emulation precedent); four independently executed gate runs (`npx jest` and `npx next build` on both passes); and the two scratch-copy falsification runs recorded above. Nothing in the worktree was modified by the Reviewer at any point.
