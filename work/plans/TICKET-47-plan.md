# TICKET-47 — Plan: exempt `reason=unplayable` advances from the anti-grief charge

**Plan status:** PRE-APPROVED by TM — the ticket file (`work/tickets/TICKET-47-unplayable-rate-exempt.md`) IS the approved plan (LOW, well-specified). Proceeding to implement without a separate approval round.

## Approach

Split the single per-room advance rate bucket in `lib/advance-rate-limit.ts` into two independent per-room sliding-window buckets:

- **singer-skip bucket** (non-`unplayable`): key `room:<id>`, ceiling **12 / 60s** — byte-for-byte the existing anti-grief limit, unchanged.
- **unplayable bucket** (`reason=unplayable`): key `unplayable:<id>`, ceiling **40 / 60s** — the new generous-but-bounded watchdog-drain ceiling.

Additive API: `advanceRateLimitOk(roomId, opts?, now?)` where `opts = { unplayable?: boolean }`. Existing 2-arg call `advanceRateLimitOk(roomId, now)` stays valid by detecting a numeric 2nd arg (back-compat), and the preferred new signature is `advanceRateLimitOk(roomId, { unplayable }, now)`. To keep the existing unit tests (which call `advanceRateLimitOk("roomA", NOW+i)` — number as 2nd arg) valid untouched, the 2nd param accepts either an options object or a `now` number.

Both buckets share the same `hits` Map (distinct key prefixes) so the existing LRU heap-growth guard (`ADVANCE_BUCKETS_MAX`, `evictOverflow`) covers both without new machinery. `_resetAdvanceRateLimit()` still clears everything.

## Files touched

- `lib/advance-rate-limit.ts` — two-bucket split; add `ADVANCE_UNPLAYABLE_ROOM_MAX = 40` + exported constant; keep `ADVANCE_ROOM_MAX`/window/LRU/reset. Overloaded 2nd param (opts-or-now).
- `app/api/queue/advance/route.ts` — resolve `skipReason` BEFORE the rate-limit call, pass `{ unplayable: skipReason === "unplayable" }` into `advanceRateLimitOk`. Keep 400/401 ordering and the 429 shape unchanged.
- `__tests__/advance-rate-limit.test.ts` — add unplayable-ceiling (13 OK, past 40 trips), non-unplayable exactly-12-then-trip, bucket independence, and route-level unplayable-charged-to-unplayable-bucket tests.

## Risks

- **Reordering `skipReason` resolution** above the rate-limit call in the route: low risk — it only reads `searchParams`, no side effects, no store access. Auth (400/401) stays before it.
- **API back-compat**: existing tests pass a number as 2nd arg. Overload must treat a number as `now` and an object as opts. Covered by keeping existing tests green.
- **Security tradeoff** (Reviewer to scrutinize): `reason` is caller-forgeable; a scraped-token attacker could set `reason=unplayable` to hit the 40-bucket instead of the 12-bucket. Mitigation = the bucket stays bounded (40/60s), not a full exemption. Flagged in PR/report for Reviewer.

## Test strategy

Full `npm test` (jest) green + `npm run build` + lint. New lib-level tests use injected `now`; route-level test uses the existing `authedAdvance` harness with `reason=unplayable` query param and asserts the unplayable bucket is charged (13 unplayable advances all 200, while a single non-unplayable still counts toward the 12 bucket independently).
