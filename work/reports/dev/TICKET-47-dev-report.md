# TICKET-47 — Dev Report

**Status:** IMPLEMENTED — build green, full suite green (465/465). Draft PR open. Awaiting TM gate sequencing. NOT auto-mergeable (merge deploys live boraoke.com — deliver to TL).

## Summary

Split the single per-room advance rate bucket into two independent per-room sliding-window buckets so `reason=unplayable` watchdog skips no longer wedge the TV on a bad-instafail run, without weakening the anti-grief singer-skip throttle.

- singer-skip bucket (non-`unplayable`), key `room:<id>`: **12 / room / 60s** — byte-for-byte unchanged.
- unplayable bucket (`reason=unplayable`), key `unplayable:<id>`: **40 / room / 60s** — new, generous-but-bounded ceiling.

Both buckets share the one `hits` Map via distinct key prefixes, so the existing LRU heap-growth guard (`ADVANCE_BUCKETS_MAX`/`evictOverflow`) covers both. `_resetAdvanceRateLimit()` unchanged.

## Files changed

- `lib/advance-rate-limit.ts` — two-bucket split. New `ADVANCE_UNPLAYABLE_ROOM_MAX = 40` + exported `ADVANCE_RATE_UNPLAYABLE_ROOM_MAX`. Additive/back-compat API: `advanceRateLimitOk(roomId, optsOrNow?, now?)` where the 2nd arg is either `{ unplayable?: boolean }` or a legacy `now` number. Kept `ADVANCE_RATE_ROOM_MAX`, `ADVANCE_RATE_WINDOW_MS`, LRU guard, reset helper.
- `app/api/queue/advance/route.ts` — moved `skipReason` resolution ABOVE the rate-limit call (it only reads `searchParams`, no side effects; auth 400/401 ordering unchanged) and pass `{ unplayable: skipReason === "unplayable" }`. No change to telemetry events or the 429 response shape.
- `__tests__/advance-rate-limit.test.ts` — 5 new tests (see below); existing 4 untouched and green.

## Security tradeoff (Reviewer MUST scrutinize)

`reason` is caller-supplied and forgeable; the advance path's only other guard (the screen token) is scrapeable per `screen-token.ts`. A **full** exemption would let a scraped-token attacker set `reason=unplayable` and bypass the throttle entirely. The chosen mitigation is a **bounded** separate bucket (40/room/60s) — it keeps a hard ceiling on ANY advance while unwedging the legitimate watchdog-drain case. Reviewer: confirm 40 is defensible and there is no cleaner design (e.g. server-verified playability, noted as a possible future improvement in the ticket).

## Self-verification (verbatim)

### `npm run build` — GREEN
```
> boraoke@0.1.0 build
> next build
... (route table printed, all routes compiled) ...
○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```
Exit 0. (Build integrates Next.js type-checking.)

### Full jest suite — GREEN
```
Test Suites: 32 passed, 32 total
Tests:       465 passed, 465 total
Snapshots:   0 total
Time:        2.118 s
```

### Targeted `advance-rate-limit.test.ts` — 9/9 GREEN
```
  advanceRateLimitOk (unit)
    ✓ allows up to the per-room cap, then trips
    ✓ buckets are independent per room
    ✓ frees after the window slides
    ✓ non-unplayable bucket ceiling is EXACTLY 12, then trips (unchanged)
    ✓ unplayable bucket allows ≥13 (past the old 12 cap), trips past its higher ceiling
    ✓ the two buckets are independent — exhausting one leaves the other free
    ✓ legacy 2-arg call (roomId, now) still charges the singer-skip bucket
  POST /api/queue/advance rate limiting (route)
    ✓ 429s once the room exceeds its per-minute advance cap
    ✓ charges a reason=unplayable advance to the unplayable bucket, not the singer-skip one (TICKET-47)
Tests:       9 passed, 9 total
```

### Lint
Boraoke has **no** ESLint config and no `lint` npm script — `next lint` prompts to configure ESLint (not a configured gate). `next build` (with integrated type-check) + full jest is boraoke's CI-green substrate; both green. `npx tsc --noEmit` on app/lib code is clean (a raw `tsc` flags jest globals in test files only, which ts-jest supplies at test-time — not a real error).

Note: boraoke is a product repo with no `scripts/verify-green-local.sh` (that is the framework's Docker gate). Per the ticket's process step 5, build + full jest green is the substrate here.

## Acceptance criteria

- [x] ≥13 consecutive `reason=unplayable` advances in <60s no longer 429 (unplayable ceiling 40) — TV drains a bad instafail run without wedging. (route + unit test)
- [x] Singer-skip (non-`unplayable`) limit is EXACTLY 12/room/60s, unchanged — 13th non-unplayable in-window still 429s. (unit + route test)
- [x] Two buckets independent — exhausting one does not affect the other. (unit test, both directions)
- [x] Unit tests cover unplayable ceiling, non-unplayable ceiling unchanged, independence, and route-level unplayable-charged-to-unplayable-bucket.
- [x] `npm run build` + full jest green (lint not configured in boraoke; substrate green).
- [x] No change to auth ordering, telemetry events, or the 429 response shape for the non-unplayable case.

## Commits

- `fd2e2c8` — fix(rate-limit): exempt unplayable watchdog skips from anti-grief charge (TICKET-47) — code + tests + plan + report + ticket.
- (event-log auto-commits `f4a37de`/`a9fd2e5` are hook-generated, not part of the change.)

## PR

- **PR #29** — https://github.com/paulosalvatore/boraoke/pull/29 (draft). Base `main`, head `ticket/47-unplayable-exempt`. NOT auto-mergeable (prod deploy on merge — deliver to TL).
