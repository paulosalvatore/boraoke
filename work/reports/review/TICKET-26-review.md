# Reviewer report — TICKET-26 (anonymous identity registry)

- **PR:** #37 (draft) · **Branch:** `ticket/26-anon-identity-registry` · Base: `main`
- **Gate:** Reviewer (D-022 opus merge-counting pass — final gate)
- **Verdict:** **APPROVE** (merge-counting)
- **Date:** 2026-07-20

## What I reviewed

Full diff `origin/main..HEAD` read locally in the ticket worktree (no GitHub API diff reads). Prior gates: App Tester **PASS**, Cyber Security **PASS-WITH-NOTES** (no BLOCKER/HIGH). I read the spec (`work/planning/accounts-and-identity.md`, Layer 1 + I-1..I-6), the plan, the dev report, and both prior gate reports. The ticket file itself is not tracked in the worktree (only the `work/events/by-branch/` stream + reports carry it) — a minor record-hygiene nit, not a defect; the spec's AC block is the authoritative contract and I reviewed against it.

## Self-verified green claim (ran it myself, not asserted)

- **`npm test`** → `Test Suites: 39 passed, 39 total` · `Tests: 571 passed, 571 total` (matches dev/App-Tester/Cyber tallies exactly).
- **`npm run build`** → `✓ Compiled successfully`, `✓ Generating static pages (29/29)`, `/api/identity` route present, **exit 0**.
- **No `scripts/verify-green-local.sh` in boraoke** — a known framework/product gap (all three prior gates flagged it). Per the task instruction this is NOT a blocker; noted as a follow-up (file the Docker gate script for boraoke so D-051's authoritative verdict is reproducible here).

## Correctness — all 5 acceptance criteria met

1. **Fresh mint + reuse** — `resolveIdentity` precedence cookie → legacy → `uuidv4()`; `touch()` is an idempotent upsert. Verified in `__tests__/identity.test.ts` (mint, cookie-reuse) and `e2e/identity.spec.ts` (single httpOnly cookie, reload reuse). ✔
2. **Legacy patronUuid adoption, no duplicate** — cookie-absent + valid legacy uuid touches that exact uuid; already-registered adoption preserves `createdAt` (test asserts `after.createdAt === before.createdAt`). ✔
3. **`creatorUuid` persisted + `identity:{uuid}:rooms` index** — `createRoom(name, creatorUuid?)` persists it (awaited, durable); route calls `identityStore.addRoom`. `rooms.test.ts` asserts persistence + absence from `PublicRoom`; `identity-store.test.ts` asserts the index + key schema. ✔
4. **Fail-open on store outage** — `resolveIdentity` try/catch returns `{ok:false}`, persists nothing, cookie set strictly behind `ok`; `addRoom` swallowed; client fetch is fire-and-forget. Throwing-store test proves it never throws. ✔
5. **Zero-PII schema + invariant comment** — `IdentityRecord` = `{uuid, createdAt, lastSeenAt, userAgentClass, accountId}`; binding invariant comment in the file header; `classifyUserAgent` emits a fixed enum, never the raw UA. Test asserts the exact key set and rejects name/email/phone/ip/fingerprint/userAgent. ✔

## Non-vacuous tests — verified by mutation reasoning

- If `touch` stopped freezing `createdAt` → `identity.test.ts:69` and `identity-store.test.ts:84` both fail.
- If fail-open threw → `identity.test.ts:108` (throwing store) would propagate and fail.
- If a PII field leaked into the record → `identity-store.test.ts:117-126` key-set assertion fails.
- If `creatorUuid` leaked into `PublicRoom` → `rooms.test.ts` `not.toHaveProperty` fails.
- Both drivers run the same contract suite (Memory + Upstash-over-FakeRedis), matching the house `telemetry-store`/`feedback-store` pattern. These are real assertions, not smoke tests.

## Design soundness for TICKET-28

The schema is correctly shaped so the future claim is a **link write, not a migration**: `accountId` reserved nullable (documented, unset here), `identity:{uuid}:rooms` written server-side only, `room.creatorUuid` persisted durably. The frozen `QueueStore` (`lib/store/types.ts`) is left untouched — identity lives in its own `identity:*` keyspace mirroring the driver-swap pattern exactly. Scope is disciplined: no OAuth/accounts built here.

## Cyber notes — correctly deferred, not blockers

- **MEDIUM-1** (bare UUID is a bearer identifier) and **LOW-1** (index pollution via unauthenticated `patronUuid`) are non-exploitable today (anonymous identities carry no ownership value); they are forward-looking security ACs for TICKET-28. Confirmed deferral is correct — carry both onto the TICKET-28 board.
- **LOW-2** (body buffered before size check) is a pre-existing pattern, platform-bounded (~4.5MB Vercel cap) and behind the per-IP throttle on `/api/rooms`. Optional hardening, not a defect this PR introduces.

## Follow-ups (non-blocking)

1. **Serverless durability of the rooms index.** `identityStore.addRoom(...).catch(() => {})` is fire-and-forget (consistent with the repo's `void track(...)` convention). On Vercel, an unawaited promise after the response can be frozen before it completes, so `identity:{uuid}:rooms` may be best-effort in prod. `room.creatorUuid` IS persisted synchronously, so TICKET-28 should treat `creatorUuid` as the source of truth and the index as an O(1) optimization it can rebuild — worth an explicit note on the TICKET-28 board.
2. **File the boraoke `verify-green-local.sh` gap** so the D-051 Docker verdict is reproducible for this product.
3. Ticket source file not tracked in the worktree — minor record hygiene.

## Verdict

**APPROVE (merge-counting).** Correctness, non-vacuous tests, and TICKET-28 design soundness all confirmed against evidence I re-verified. Green claim independently reproduced (571/571 Jest, build exit 0). Not merging — merge authority + timing for this live boraoke.com prod deploy rests with the TM/TL.
